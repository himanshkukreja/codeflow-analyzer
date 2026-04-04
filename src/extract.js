const path = require("path");
const {
  Node,
  SyntaxKind,
} = require("ts-morph");
const {
  clampConfidence,
  dedupeBy,
  lineNumber,
  normalizeEndpoint,
  routeFromAppPath,
  routeFromPagesPath,
  stripQuotes,
  textFromNodeText,
  toPosix,
} = require("./utils");

function analyzeCodebase(context, prescan) {
  const routeInfo = extractRoutes(context);
  const functionRegistry = buildFunctionRegistry(context);
  const sharedActions = extractSharedActions(context, functionRegistry);
  const stateSignals = extractStates(context, prescan, routeInfo);
  const stateBySetter = new Map(stateSignals.map((state) => [state.setter, state]));
  const derivedSignals = extractDerivedState(context, stateSignals, routeInfo);
  const apiCalls = extractApiCalls(context, prescan, routeInfo);
  const navigation = extractNavigation(context, prescan, routeInfo);
  const conditionals = extractConditionals(context, routeInfo);
  const boundActions = bindSharedActions(context, sharedActions);
  const events = extractEvents(context, prescan, functionRegistry, boundActions, stateBySetter, routeInfo);

  return {
    routes: routeInfo.routes,
    routeByFile: routeInfo.routeByFile,
    componentRouteByFile: routeInfo.componentRouteByFile,
    states: stateSignals,
    derivedState: derivedSignals,
    apiCalls,
    navigation,
    conditionals,
    events,
    sharedActions,
  };
}

function extractRoutes(context) {
  const routes = [];
  const routeByFile = new Map();
  const componentRouteByFile = new Map();
  const layoutFiles = context.sourceFiles
    .filter((file) => /(^|\/)layout\.(tsx|ts|jsx|js)$/.test(file.relPath))
    .map((file) => file.relPath);

  for (const meta of context.sourceFiles) {
    const route = meta.appRoute || meta.pagesRoute;
    if (route) {
      const layouts = layoutFiles.filter((layoutPath) => {
        if (!layoutPath.startsWith("app/")) return false;
        const layoutDir = path.posix.dirname(layoutPath);
        return meta.relPath.startsWith(layoutDir);
      });
      const signal = {
        id: `route:${meta.relPath}`,
        path: route,
        component: defaultExportName(context, meta.relPath) || componentNameFromFile(meta.relPath),
        sourceFile: meta.relPath,
        framework: context.framework,
        dynamicParams: [...route.matchAll(/:([^/]+)/g)].map((match) => match[1]),
        layoutChain: layouts.map((layoutPath) => defaultExportName(context, layoutPath) || componentNameFromFile(layoutPath)),
        confidence: 1,
      };
      routes.push(signal);
      routeByFile.set(meta.relPath, route);
    }
  }

  for (const sourceFile of context.projectFiles) {
    const relPath = relativeSourcePath(context, sourceFile);
    const candidates = [
      ...sourceFile
        .getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
        .filter((node) => node.getTagNameNode().getText() === "Route"),
      ...sourceFile
        .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
        .filter((node) => node.getTagNameNode().getText() === "Route"),
    ];
    for (const node of candidates) {
      const pathAttr = node.getAttribute("path");
      const elementAttr = node.getAttribute("element");
      const routePath = pathAttr && Node.isJsxAttribute(pathAttr) ? jsxAttributeValueText(pathAttr) : null;
      const component = elementAttr && Node.isJsxAttribute(elementAttr) ? jsxAttributeValueText(elementAttr) : null;
      if (!routePath) continue;
      routes.push({
        id: `route:${relPath}:${node.getStartLineNumber()}`,
        path: routePath,
        component: component || "UnknownComponent",
        sourceFile: relPath,
        framework: context.framework,
        dynamicParams: [...routePath.matchAll(/:([^/]+)/g)].map((match) => match[1]),
        layoutChain: [],
        confidence: 1,
      });
      const componentIdentifier = elementAttr && Node.isJsxAttribute(elementAttr) ? routeComponentIdentifier(elementAttr) : null;
      if (componentIdentifier) {
        const componentRelPath = resolveImportedComponentFile(context, sourceFile, componentIdentifier);
        if (componentRelPath) {
          const existing = componentRouteByFile.get(componentRelPath);
          if (!existing || existing === "*" || (existing.includes(":") && routePath !== "*")) {
            componentRouteByFile.set(componentRelPath, routePath);
          }
        }
      }
    }
  }

  return {
    routes: dedupeBy(routes, (route) => `${route.sourceFile}:${route.path}`),
    routeByFile,
    componentRouteByFile,
  };
}

function buildFunctionRegistry(context) {
  const registry = new Map();
  for (const sourceFile of context.projectFiles) {
    const relPath = relativeSourcePath(context, sourceFile);
    const entries = new Map();

    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (name) entries.set(name, fn);
    }

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = declaration.getInitializer();
      if (!initializer) continue;
      const functionNode = unwrapFunctionInitializer(initializer);
      if (functionNode) {
        entries.set(declaration.getName(), functionNode);
      }
    }

    registry.set(relPath, entries);
  }

  return registry;
}

function unwrapFunctionInitializer(initializer) {
  if (!initializer) return null;
  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) return initializer;
  if (Node.isCallExpression(initializer)) {
    const callee = initializer.getExpression().getText();
    if (["useCallback", "React.useCallback", "useMemo", "React.useMemo"].includes(callee)) {
      const [firstArg] = initializer.getArguments();
      if (firstArg && (Node.isArrowFunction(firstArg) || Node.isFunctionExpression(firstArg))) {
        return firstArg;
      }
    }
  }
  return null;
}

function extractSharedActions(context, functionRegistry) {
  const registry = new Map();

  for (const sourceFile of context.projectFiles) {
    const relPath = relativeSourcePath(context, sourceFile);
    const fileFunctions = functionRegistry.get(relPath) || new Map();
    const localActions = new Map();

    for (const fn of sourceFile.getFunctions()) {
      const fnName = fn.getName();
      if (!fnName) continue;

      if (/^use[A-Z]/.test(fnName)) {
        const returned = returnedObjectFields(fn);
        for (const field of returned) {
          const targetName = field.targetName;
          if (!targetName || !fileFunctions.has(targetName)) continue;
          localActions.set(field.exportedName, buildActionDefinition(context, relPath, fnName, field.exportedName, fileFunctions.get(targetName)));
        }
      }

      const contextHookInfo = inferContextHook(fn);
      if (contextHookInfo) {
        const providerActions = registry.get(contextHookInfo.contextName);
        if (providerActions) {
          registry.set(fnName, providerActions);
        }
      }
    }

    const providerActions = extractProviderActions(context, sourceFile, relPath, fileFunctions);
    for (const [ownerName, actions] of providerActions.entries()) {
      registry.set(ownerName, actions);
    }
    if (localActions.size > 0) {
      const owner = [...localActions.values()][0].owner;
      registry.set(owner, localActions);
    }
  }

  return registry;
}

function inferContextHook(fn) {
  const returns = fn.getDescendantsOfKind(SyntaxKind.ReturnStatement);
  for (const ret of returns) {
    const expr = ret.getExpression();
    if (!expr || !Node.isIdentifier(expr)) continue;
    let variableDecl;
    try {
      variableDecl = expr.getDefinitions?.()[0]?.getDeclarationNode?.();
    } catch {
      continue;
    }
    if (!variableDecl || !Node.isVariableDeclaration(variableDecl)) continue;
    const init = variableDecl.getInitializer();
    if (init && Node.isCallExpression(init) && init.getExpression().getText() === "useContext") {
      const [arg] = init.getArguments();
      if (arg) {
        return { contextName: arg.getText() };
      }
    }
  }
  return null;
}

function extractProviderActions(context, sourceFile, relPath, fileFunctions) {
  const result = new Map();
  const contexts = new Set();
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (initializer && Node.isCallExpression(initializer) && initializer.getExpression().getText() === "createContext") {
      contexts.add(declaration.getName());
    }
  }

  const jsxNodes = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  for (const jsx of jsxNodes) {
    const tagText = jsx.getTagNameNode().getText();
    if (!tagText.endsWith(".Provider")) continue;
    const [contextName] = tagText.split(".");
    const valueAttr = jsx.getAttribute("value");
    if (!valueAttr || !Node.isJsxAttribute(valueAttr)) continue;
    const initializer = valueAttr.getInitializer();
    if (!initializer || !Node.isJsxExpression(initializer)) continue;
    const expression = initializer.getExpression();
    if (!expression || !Node.isObjectLiteralExpression(expression)) continue;

    const actions = new Map();
    for (const prop of expression.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) {
        const name = prop.getName();
        if (fileFunctions.has(name)) {
          actions.set(name, buildActionDefinition(context, relPath, contextName, name, fileFunctions.get(name)));
        }
      } else if (Node.isPropertyAssignment(prop) && Node.isIdentifier(prop.getInitializer())) {
        const exportedName = prop.getName();
        const targetName = prop.getInitializer().getText();
        if (fileFunctions.has(targetName)) {
          actions.set(exportedName, buildActionDefinition(context, relPath, contextName, exportedName, fileFunctions.get(targetName)));
        }
      }
    }

    if (actions.size > 0) {
      result.set(contextName, actions);
    }
  }

  return result;
}

function buildActionDefinition(context, relPath, owner, exportedName, fnNode) {
  const body = getFunctionBodyNode(fnNode);
  const nestedApiCalls = collectApiCallsFromNode(context, body, relPath, null, owner);
  const nestedNavigation = collectNavigationFromNode(context, body, relPath, null);
  const stateWrites = collectStateWriteNames(body);
  return {
    id: `action:${relPath}:${owner}:${exportedName}`,
    name: exportedName,
    owner,
    sourceFile: relPath,
    line: fnNode.getStartLineNumber(),
    confidence: 1,
    apiCalls: nestedApiCalls,
    navigation: nestedNavigation,
    stateWrites,
  };
}

function extractStates(context, prescan, routeInfo) {
  const states = [];
  const candidateFiles = prescan.state && prescan.state.size > 0 ? prescan.state : new Set(context.sourceFiles.map((file) => file.relPath));

  for (const relPath of candidateFiles) {
    const sourceFile = context.sourceFileByPath.get(relPath);
    if (!sourceFile) continue;
    const route = routeForFile(context, relPath, routeInfo);

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = declaration.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      const exprText = initializer.getExpression().getText();
      if (!["useState", "React.useState", "useReducer", "React.useReducer"].includes(exprText)) continue;
      const nameNode = declaration.getNameNode();
      if (!Node.isArrayBindingPattern(nameNode)) continue;
      const elements = nameNode.getElements();
      const stateElement = elements[0];
      const setterElement = elements[1];
      if (!stateElement || !setterElement) continue;
      const stateName = stateElement.getText();
      const setterName = setterElement.getText();
      const initialValue = initializer.getArguments()[0]?.getText() || "undefined";
      const readSites = safeFindReferenceSites(stateElement, context);
      const writeSites = safeFindReferenceSites(setterElement, context, true);
      const signal = {
        id: `state:${relPath}:${stateName}`,
        name: stateName,
        setter: setterName,
        sourceFile: relPath,
        route,
        scope: inferStateScope(relPath),
        initialValue,
        line: declaration.getStartLineNumber(),
        readSites,
        writeSites,
        confidence: 1,
      };
      states.push(signal);
    }
  }

  return states;
}

function extractDerivedState(context, states, routeInfo) {
  const stateNames = new Set(states.map((state) => state.name));
  const derivedSignals = [];

  for (const sourceFile of context.projectFiles) {
    const relPath = relativeSourcePath(context, sourceFile);
    const route = routeForFile(context, relPath, routeInfo);
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = declaration.getInitializer();
      if (!initializer) continue;

      if (Node.isCallExpression(initializer) && initializer.getExpression().getText() === "useMemo") {
        const [factoryArg, depsArg] = initializer.getArguments();
        const dependencyNames = depsArg && Node.isArrayLiteralExpression(depsArg)
          ? depsArg.getElements().map((element) => element.getText())
          : [];
        const relevantDeps = dependencyNames.filter((name) => stateNames.has(name));
        if (relevantDeps.length > 0) {
          derivedSignals.push({
            id: `derived:${relPath}:${declaration.getName()}`,
            name: declaration.getName(),
            kind: "useMemo",
            dependencies: relevantDeps,
            sourceFile: relPath,
            route,
            line: declaration.getStartLineNumber(),
            confidence: 0.9,
          });
        }
        continue;
      }

      const initText = initializer.getText();
      const usedStates = [...stateNames].filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(initText));
      if (usedStates.length > 0 && /\.(filter|map|some|every|reduce)\(/.test(initText)) {
        derivedSignals.push({
          id: `derived:${relPath}:${declaration.getName()}`,
          name: declaration.getName(),
          kind: "expression",
          dependencies: usedStates,
          sourceFile: relPath,
          route,
          line: declaration.getStartLineNumber(),
          confidence: 0.8,
        });
      }
    }
  }

  return dedupeBy(derivedSignals, (item) => item.id);
}

function extractApiCalls(context, prescan, routeInfo) {
  const apiCalls = [];
  const candidateFiles = prescan.api && prescan.api.size > 0 ? prescan.api : new Set(context.sourceFiles.map((file) => file.relPath));

  for (const relPath of candidateFiles) {
    const sourceFile = context.sourceFileByPath.get(relPath);
    if (!sourceFile) continue;
    const route = routeForFile(context, relPath, routeInfo);
    apiCalls.push(...collectApiCallsFromNode(context, sourceFile, relPath, route));
  }

  return dedupeBy(apiCalls, (item) => `${item.sourceFile}:${item.line}:${item.method}:${item.endpoint}:${item.enclosingFunction}`);
}

function collectApiCallsFromNode(context, node, relPath, route, fallbackOwner = null) {
  const apiCalls = [];
  const callExpressions = Node.isSourceFile(node)
    ? node.getDescendantsOfKind(SyntaxKind.CallExpression)
    : node.getDescendantsOfKind(SyntaxKind.CallExpression);
  const importedCache = new Set();

  for (const call of callExpressions) {
    const expression = call.getExpression();
    const expressionText = expression.getText();

    if (expressionText === "fetch") {
      const [urlArg, optionsArg] = call.getArguments();
      if (!urlArg) continue;
      const endpointRaw = urlArg.getText();
      const method = extractFetchMethod(optionsArg);
      const enclosingFunction = enclosingFunctionName(call) || fallbackOwner || "module";
      apiCalls.push({
        id: `api:${relPath}:${call.getStartLineNumber()}:${method}`,
        method,
        endpoint: normalizeEndpoint(endpointRaw),
        sourceFile: relPath,
        line: call.getStartLineNumber(),
        route,
        enclosingFunction,
        confidence: endpointRaw.includes("${") ? 0.8 : 1,
      });
      continue;
    }

    if (/^axios\.(get|post|put|patch|delete)$/.test(expressionText)) {
      const method = expressionText.split(".")[1].toUpperCase();
      const [urlArg] = call.getArguments();
      if (!urlArg) continue;
      const endpointRaw = urlArg.getText();
      const enclosingFunction = enclosingFunctionName(call) || fallbackOwner || "module";
      apiCalls.push({
        id: `api:${relPath}:${call.getStartLineNumber()}:${method}`,
        method,
        endpoint: normalizeEndpoint(endpointRaw),
        sourceFile: relPath,
        line: call.getStartLineNumber(),
        route,
        enclosingFunction,
        confidence: endpointRaw.includes("${") ? 0.8 : 1,
      });
      continue;
    }

    if (Node.isPropertyAccessExpression(expression)) {
      const methodName = expression.getName();
      if (["get", "post", "put", "patch", "delete"].includes(methodName)) {
        const [urlArg] = call.getArguments();
        if (!urlArg) continue;
        const endpointRaw = urlArg.getText();
        if (!looksLikeApiEndpoint(endpointRaw)) continue;
        const enclosingFunction = enclosingFunctionName(call) || fallbackOwner || "module";
        apiCalls.push({
          id: `api:${relPath}:${call.getStartLineNumber()}:${methodName.toUpperCase()}`,
          method: methodName.toUpperCase(),
          endpoint: normalizeEndpoint(endpointRaw),
          sourceFile: relPath,
          line: call.getStartLineNumber(),
          route,
          enclosingFunction,
          confidence: endpointRaw.includes("${") ? 0.8 : 1,
        });
        continue;
      }

      if (methodName === "request") {
        const [configArg] = call.getArguments();
        if (!configArg || !Node.isObjectLiteralExpression(configArg)) continue;
        const requestConfig = extractRequestConfig(configArg);
        if (!requestConfig.url || !looksLikeApiEndpoint(requestConfig.url)) continue;
        const enclosingFunction = enclosingFunctionName(call) || fallbackOwner || "module";
        apiCalls.push({
          id: `api:${relPath}:${call.getStartLineNumber()}:${requestConfig.method}`,
          method: requestConfig.method,
          endpoint: normalizeEndpoint(requestConfig.url),
          sourceFile: relPath,
          line: call.getStartLineNumber(),
          route,
          enclosingFunction,
          confidence: requestConfig.url.includes("${") ? 0.8 : 1,
        });
      }
    }

    const importedFunction = resolveImportedFunctionNode(context, expression);
    if (!importedFunction) continue;

    const cacheKey = `${importedFunction.relPath}:${importedFunction.name}:${call.getStartLineNumber()}`;
    if (importedCache.has(cacheKey)) continue;
    importedCache.add(cacheKey);

    const importedBody = getFunctionBodyNode(importedFunction.node) || importedFunction.node;
    const importedCalls = collectApiCallsFromNode(context, importedBody, importedFunction.relPath, route, fallbackOwner || expressionText);
    for (const apiCall of importedCalls) {
      apiCalls.push({
        ...apiCall,
        id: `api:${relPath}:${call.getStartLineNumber()}:${apiCall.method}:${apiCall.endpoint}`,
        sourceFile: relPath,
        line: call.getStartLineNumber(),
        route,
        enclosingFunction: enclosingFunctionName(call) || fallbackOwner || "module",
        confidence: Math.min(apiCall.confidence || 1, 0.9),
      });
    }
  }

  return apiCalls;
}

function looksLikeApiEndpoint(value) {
  const normalized = stripQuotes(value || "");
  return normalized.startsWith("/api") || normalized.startsWith("http://") || normalized.startsWith("https://");
}

function extractRequestConfig(objectLiteral) {
  let method = "GET";
  let url = null;
  for (const prop of objectLiteral.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const name = prop.getName();
    const initializer = prop.getInitializer();
    if (!initializer) continue;
    if (name === "method") {
      method = stripQuotes(initializer.getText()).toUpperCase();
    } else if (name === "url") {
      url = initializer.getText();
    }
  }
  return { method, url };
}

function resolveImportedFunctionNode(context, expression) {
  if (!Node.isIdentifier(expression)) return null;

  let definitionNode;
  try {
    definitionNode = expression.getDefinitions?.()[0]?.getDeclarationNode?.();
  } catch {
    return null;
  }

  if (!definitionNode) return null;

  const importDecl = definitionNode.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (!importDecl) return null;

  const importedSource = importDecl.getModuleSpecifierSourceFile();
  if (!importedSource) return null;

  const importedRelPath = relativeSourcePath(context, importedSource);
  if (!/(^|\/)api\//.test(importedRelPath)) return null;

  const exportedName = Node.isImportSpecifier(definitionNode)
    ? definitionNode.getNameNode().getText()
    : "default";
  const fnNode = findExportedFunctionNode(importedSource, exportedName);
  if (!fnNode) return null;

  return {
    node: fnNode,
    relPath: importedRelPath,
    name: exportedName,
  };
}

function findExportedFunctionNode(sourceFile, exportedName) {
  if (exportedName === "default") {
    const defaultFn = sourceFile.getFunctions().find((fn) => fn.isDefaultExport());
    if (defaultFn) return defaultFn;
  }

  for (const fn of sourceFile.getFunctions()) {
    if (fn.getName() === exportedName) return fn;
  }

  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (declaration.getName() !== exportedName) continue;
    const initializer = declaration.getInitializer();
    const functionNode = unwrapFunctionInitializer(initializer);
    if (functionNode) return functionNode;
  }

  return null;
}

function extractNavigation(context, prescan, routeInfo) {
  const navigation = [];
  const candidateFiles = prescan.navigation && prescan.navigation.size > 0 ? prescan.navigation : new Set(context.sourceFiles.map((file) => file.relPath));

  for (const relPath of candidateFiles) {
    const sourceFile = context.sourceFileByPath.get(relPath);
    if (!sourceFile) continue;
    const route = routeForFile(context, relPath, routeInfo);
    navigation.push(...collectNavigationFromNode(context, sourceFile, relPath, route));
  }

  return dedupeBy(navigation, (item) => `${item.sourceFile}:${item.line}:${item.mechanism}:${item.target}`);
}

function collectNavigationFromNode(context, node, relPath, route) {
  const signals = [];

  const jsxElements = [
    ...node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ...node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
  ];

  for (const jsx of jsxElements) {
    if (jsx.getTagNameNode().getText() !== "Link") continue;
    const hrefAttr = jsx.getAttribute("href");
    if (!hrefAttr || !Node.isJsxAttribute(hrefAttr)) continue;
    const targetRaw = jsxAttributeValueText(hrefAttr);
    if (!targetRaw) continue;
    const parentElement = Node.isJsxOpeningElement(jsx) ? jsx.getParent() : jsx;
    signals.push({
      id: `navigation:${relPath}:${jsx.getStartLineNumber()}:link`,
      mechanism: "link",
      target: normalizeEndpoint(targetRaw),
      sourceFile: relPath,
      line: jsx.getStartLineNumber(),
      sourceRoute: route,
      triggerElement: "Link",
      triggerText: elementText(parentElement),
      isDynamic: targetRaw.includes("${") || targetRaw.includes("["),
      confidence: targetRaw.includes("${") ? 0.8 : 1,
    });
  }

  const callExpressions = node.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    const exprText = call.getExpression().getText();
    if (!["navigate", "router.push", "router.replace"].includes(exprText)) continue;
    const [targetArg] = call.getArguments();
    if (!targetArg) continue;
    const rawTarget = targetArg.getText();
    signals.push({
      id: `navigation:${relPath}:${call.getStartLineNumber()}:${exprText}`,
      mechanism: exprText === "navigate" ? "navigate" : exprText.includes("replace") ? "router_replace" : "router_push",
      target: normalizeEndpoint(rawTarget),
      sourceFile: relPath,
      line: call.getStartLineNumber(),
      sourceRoute: route,
      triggerElement: "code",
      triggerText: null,
      isDynamic: rawTarget.includes("${") || rawTarget.includes("["),
      confidence: rawTarget.includes("${") ? 0.8 : 1,
    });
  }

  return signals;
}

function extractConditionals(context, routeInfo) {
  const conditionals = [];

  for (const sourceFile of context.projectFiles) {
    const relPath = relativeSourcePath(context, sourceFile);
    const route = routeForFile(context, relPath, routeInfo);

    for (const expression of sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
      conditionals.push({
        id: `conditional:${relPath}:${expression.getStartLineNumber()}:ternary`,
        condition: expression.getCondition().getText(),
        trueBranch: textFromNodeText(expression.getWhenTrue().getText()) || expression.getWhenTrue().getText(),
        falseBranch: textFromNodeText(expression.getWhenFalse().getText()) || expression.getWhenFalse().getText(),
        sourceFile: relPath,
        line: expression.getStartLineNumber(),
        route,
        confidence: 1,
      });
    }

    for (const expression of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (expression.getOperatorToken().getKind() !== SyntaxKind.AmpersandAmpersandToken) continue;
      if (!Node.isJsxExpression(expression.getParent())) continue;
      conditionals.push({
        id: `conditional:${relPath}:${expression.getStartLineNumber()}:and`,
        condition: expression.getLeft().getText(),
        trueBranch: textFromNodeText(expression.getRight().getText()) || expression.getRight().getText(),
        falseBranch: null,
        sourceFile: relPath,
        line: expression.getStartLineNumber(),
        route,
        confidence: 1,
      });
    }
  }

  return dedupeBy(conditionals, (item) => item.id);
}

function bindSharedActions(context, sharedActions) {
  const bound = new Map();

  for (const sourceFile of context.projectFiles) {
    const relPath = relativeSourcePath(context, sourceFile);
    const localBindings = new Map();

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = declaration.getInitializer();
      const nameNode = declaration.getNameNode();
      if (!initializer || !Node.isCallExpression(initializer) || !Node.isObjectBindingPattern(nameNode)) continue;
      const hookName = initializer.getExpression().getText();
      const actionSource = sharedActions.get(hookName);
      if (!actionSource) continue;
      for (const element of nameNode.getElements()) {
        const propertyName = element.getPropertyNameNode()?.getText() || element.getName();
        const localName = element.getName();
        const actionDefinition = actionSource.get(propertyName);
        if (actionDefinition) {
          localBindings.set(localName, actionDefinition);
        }
      }
    }

    bound.set(relPath, localBindings);
  }

  return bound;
}

function extractEvents(context, prescan, functionRegistry, boundActions, stateBySetter, routeInfo) {
  const events = [];
  const candidateFiles = prescan.event && prescan.event.size > 0 ? prescan.event : new Set(context.sourceFiles.map((file) => file.relPath));

  for (const relPath of candidateFiles) {
    const sourceFile = context.sourceFileByPath.get(relPath);
    if (!sourceFile) continue;
    const route = routeForFile(context, relPath, routeInfo);
    const localFunctions = functionRegistry.get(relPath) || new Map();
    const localBoundActions = boundActions.get(relPath) || new Map();

    for (const attr of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      const attrName = attr.getNameNode().getText();
      if (!attrName.startsWith("on")) continue;

      const event = attrName.slice(2).toLowerCase();
      const parent = jsxElementForAttribute(attr);
      const tagNameNode = parent && typeof parent.getTagNameNode === "function" ? parent.getTagNameNode() : null;
      const element = tagNameNode ? tagNameNode.getText() : "unknown";
      const initializer = attr.getInitializer();
      const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : null;
      const resolution = resolveHandler(expression, localFunctions);
      const effects = collectEffectsFromHandler(context, resolution.bodyNode || expression, relPath, route, localBoundActions, stateBySetter);
      const signal = {
        id: `event:${relPath}:${attr.getStartLineNumber()}:${event}`,
        event,
        element,
        handlerName: resolution.name,
        sourceFile: relPath,
        route,
        line: attr.getStartLineNumber(),
        elementText: elementText(parent),
        elementLabel: jsxAttributeString(parent, "aria-label") || jsxAttributeString(parent, "label"),
        elementPlaceholder: jsxAttributeString(parent, "placeholder"),
        elementTestId: jsxAttributeString(parent, "data-testid"),
        guardCondition: inferGuardCondition(attr),
        calledActions: effects.calledActions,
        triggeredEffects: effects.effects,
        confidence: clampConfidence(effects.confidence),
      };
      events.push(signal);
    }
  }

  return dedupeBy(events, (item) => item.id);
}

function resolveHandler(expression, localFunctions) {
  if (!expression) return { name: "inline", bodyNode: null };
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return { name: "inline_arrow", bodyNode: expression };
  }
  if (Node.isIdentifier(expression)) {
    return { name: expression.getText(), bodyNode: localFunctions.get(expression.getText()) || expression };
  }
  return { name: expression.getText(), bodyNode: expression };
}

function collectEffectsFromHandler(context, node, relPath, route, boundActions, stateBySetter) {
  const effects = [];
  const calledActions = [];
  let confidence = 1;
  if (!node) {
    return { effects, calledActions, confidence: 0.5 };
  }

  const workingNode = Node.isArrowFunction(node) || Node.isFunctionExpression(node) ? node.getBody() : getFunctionBodyNode(node) || node;
  const callExpressions = Node.isNode(workingNode)
    ? workingNode.getDescendantsOfKind(SyntaxKind.CallExpression)
    : [];

  for (const call of callExpressions) {
    const exprText = call.getExpression().getText();
    if (stateBySetter.has(exprText)) {
      const state = stateBySetter.get(exprText);
      effects.push({
        kind: "state_mutation",
        target: state.name,
        source: exprText,
      });
    }

    if (exprText === "window.confirm") {
      effects.push({
        kind: "browser_api",
        target: "window.confirm",
      });
    }

    if (boundActions.has(exprText)) {
      const action = boundActions.get(exprText);
      calledActions.push(action.name);
      effects.push({
        kind: "action_call",
        target: action.name,
        resolvedTo: `${action.owner}.${action.name}`,
      });
      for (const apiCall of action.apiCalls) {
        effects.push({
          kind: "api_call",
          target: `${apiCall.method} ${apiCall.endpoint}`,
        });
      }
      for (const stateWrite of action.stateWrites) {
        effects.push({
          kind: "state_mutation",
          target: stateBySetter.get(stateWrite)?.name || stateWrite,
          source: stateWrite,
        });
      }
      for (const nav of action.navigation) {
        effects.push({
          kind: "navigation",
          target: nav.target,
          mechanism: nav.mechanism,
        });
      }
    }
  }

  for (const apiCall of collectApiCallsFromNode(context, workingNode, relPath, route)) {
    effects.push({ kind: "api_call", target: `${apiCall.method} ${apiCall.endpoint}` });
    confidence = Math.min(confidence, apiCall.confidence);
  }

  for (const nav of collectNavigationFromNode(context, workingNode, relPath, route)) {
    effects.push({ kind: "navigation", target: nav.target, mechanism: nav.mechanism });
    confidence = Math.min(confidence, nav.confidence);
  }

  return {
    effects: dedupeBy(effects, (effect) => `${effect.kind}:${effect.target}`),
    calledActions: [...new Set(calledActions)],
    confidence,
  };
}

function inferGuardCondition(attr) {
  const elementNode = jsxElementForAttribute(attr) || attr.getParent();
  const ancestors = elementNode.getAncestors();
  for (const ancestor of ancestors) {
    if (Node.isConditionalExpression(ancestor)) {
      return ancestor.getCondition().getText();
    }
    if (Node.isBinaryExpression(ancestor) && ancestor.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
      return ancestor.getLeft().getText();
    }
    if (Node.isIfStatement(ancestor)) {
      return ancestor.getExpression().getText();
    }
  }
  return null;
}

function jsxAttributeString(node, name) {
  if (!node || typeof node.getAttribute !== "function") return null;
  const attr = node.getAttribute(name);
  if (!attr || !Node.isJsxAttribute(attr)) return null;
  return jsxAttributeValueText(attr);
}

function jsxAttributeValueText(attr) {
  const initializer = attr.getInitializer();
  if (!initializer) return null;
  if (Node.isStringLiteral(initializer)) {
    return initializer.getLiteralText();
  }
  if (Node.isJsxExpression(initializer)) {
    const expr = initializer.getExpression();
    if (!expr) return null;
    return stripQuotes(expr.getText());
  }
  return stripQuotes(initializer.getText());
}

function elementText(node) {
  if (!node) return null;
  if (Node.isJsxSelfClosingElement(node)) return null;
  if (Node.isJsxOpeningElement(node)) {
    node = node.getParent();
  }
  if (Node.isJsxElement(node)) {
    const text = node
      .getJsxChildren()
      .map((child) => child.getText())
      .join(" ");
    return textFromNodeText(text);
  }
  return null;
}

function jsxElementForAttribute(attr) {
  const parent = attr.getParent();
  if (parent && parent.getKind() === SyntaxKind.JsxAttributes) {
    return parent.getParent();
  }
  return parent;
}

function nodeReferenceSites(nodes, context, treatAsWrites = false) {
  const sites = [];
  for (const node of nodes) {
    const sourceFile = node.getSourceFile();
    const relPath = relativeSourcePath(context, sourceFile);
    const fnName = enclosingFunctionName(node);
    const site = {
      file: relPath,
      line: node.getStartLineNumber(),
      function: fnName || "module",
      kind: treatAsWrites ? "write" : "read",
    };
    sites.push(site);
  }
  return dedupeBy(sites, (site) => `${site.file}:${site.line}:${site.kind}`);
}

function safeFindReferenceSites(node, context, treatAsWrites = false) {
  try {
    return nodeReferenceSites(node.findReferencesAsNodes(), context, treatAsWrites);
  } catch {
    return [];
  }
}

function inferStateScope(relPath) {
  if (relPath.includes("/context/") || relPath.startsWith("context/")) return "context_provider";
  if (relPath.includes("/hooks/") || relPath.startsWith("hooks/")) return "custom_hook";
  return "component";
}

function returnedObjectFields(fn) {
  const results = [];
  for (const statement of fn.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expr = statement.getExpression();
    if (!expr || !Node.isObjectLiteralExpression(expr)) continue;
    for (const prop of expr.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) {
        results.push({ exportedName: prop.getName(), targetName: prop.getName() });
      } else if (Node.isPropertyAssignment(prop)) {
        const initializer = prop.getInitializer();
        if (initializer && Node.isIdentifier(initializer)) {
          results.push({ exportedName: prop.getName(), targetName: initializer.getText() });
        }
      }
    }
  }
  return results;
}

function defaultExportName(context, relPath) {
  const sourceFile = context.sourceFileByPath.get(relPath);
  if (!sourceFile) return null;
  const defaultFn = sourceFile.getFunctions().find((fn) => fn.isDefaultExport());
  if (defaultFn) return defaultFn.getName() || componentNameFromFile(relPath);
  const defaultExportSymbol = sourceFile.getDefaultExportSymbol();
  if (defaultExportSymbol) return defaultExportSymbol.getName();
  return null;
}

function componentNameFromFile(relPath) {
  return path
    .basename(relPath, path.extname(relPath))
    .replace(/[\[\]]/g, "")
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function relativeSourcePath(context, sourceFile) {
  return toPosix(path.relative(context.rootDir, sourceFile.getFilePath()));
}

function routeForFile(context, relPath, routeInfo = null) {
  if (routeInfo?.routeByFile?.has(relPath)) return routeInfo.routeByFile.get(relPath);
  if (routeInfo?.componentRouteByFile?.has(relPath)) return routeInfo.componentRouteByFile.get(relPath);
  return routeFromAppPath(relPath) || routeFromPagesPath(relPath) || null;
}

function getFunctionBodyNode(node) {
  if (!node) return null;
  if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node) || Node.isMethodDeclaration(node)) {
    return node.getBody();
  }
  return null;
}

function enclosingFunctionName(node) {
  const ancestor = node.getFirstAncestor((candidate) =>
    Node.isFunctionDeclaration(candidate) ||
    Node.isFunctionExpression(candidate) ||
    Node.isArrowFunction(candidate) ||
    Node.isMethodDeclaration(candidate)
  );
  if (!ancestor) return null;
  if (Node.isFunctionDeclaration(ancestor) || Node.isMethodDeclaration(ancestor)) {
    return ancestor.getName() || "anonymous";
  }
  const parent = ancestor.getParent();
  if (Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return "anonymous";
}

function extractFetchMethod(optionsArg) {
  if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) return "GET";
  for (const prop of optionsArg.getProperties()) {
    if (Node.isPropertyAssignment(prop) && prop.getName() === "method") {
      return stripQuotes(prop.getInitializer()?.getText() || "GET").toUpperCase();
    }
  }
  return "GET";
}

function collectStateWriteNames(node) {
  if (!node || !Node.isNode(node)) return [];
  const names = node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .map((call) => call.getExpression().getText())
    .filter((name) => /^set[A-Z]/.test(name));
  return [...new Set(names)];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routeComponentIdentifier(elementAttr) {
  const initializer = elementAttr.getInitializer();
  if (!initializer || !Node.isJsxExpression(initializer)) return null;
  const expression = initializer.getExpression();
  if (!expression) return null;
  const candidates = [];

  if (Node.isJsxSelfClosingElement(expression) || Node.isJsxOpeningElement(expression)) {
    candidates.push(expression.getTagNameNode().getText());
  }
  if (Node.isJsxElement(expression)) {
    candidates.push(expression.getOpeningElement().getTagNameNode().getText());
  }

  if (Node.isNode(expression)) {
    for (const jsx of expression.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
      candidates.push(jsx.getTagNameNode().getText());
    }
    for (const jsx of expression.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) {
      candidates.push(jsx.getTagNameNode().getText());
    }
  }

  const wrappers = new Set(["ProtectedRoute", "AppShell", "Suspense", "Fragment"]);
  const component = [...candidates]
    .reverse()
    .find((name) => /^[A-Z]/.test(name) && !wrappers.has(name));

  return component || null;
}

function resolveImportedComponentFile(context, sourceFile, componentName) {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport && defaultImport.getText() === componentName) {
      const imported = importDecl.getModuleSpecifierSourceFile();
      if (!imported) return null;
      return relativeSourcePath(context, imported);
    }
    for (const named of importDecl.getNamedImports()) {
      const alias = named.getAliasNode()?.getText() || named.getName();
      if (alias === componentName) {
        const imported = importDecl.getModuleSpecifierSourceFile();
        if (!imported) return null;
        return relativeSourcePath(context, imported);
      }
    }
  }
  return null;
}

module.exports = { analyzeCodebase };
