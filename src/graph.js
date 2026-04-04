const graphlib = require("graphlib");
const { clampConfidence, dedupeBy, routeGroupName } = require("./utils");

function buildFlowGraph(analysis) {
  const graph = new graphlib.Graph({ directed: true, multigraph: true, compound: false });
  const nodeMeta = new Map();

  function addNode(id, value) {
    if (!graph.hasNode(id)) {
      graph.setNode(id, value);
      nodeMeta.set(id, value);
    }
  }

  function addEdge(from, to, label) {
    if (graph.hasNode(from) && graph.hasNode(to)) {
      graph.setEdge({ v: from, w: to, name: `${label}:${from}:${to}` }, { label });
    }
  }

  for (const route of analysis.routes) addNode(route.id, { kind: "route", label: route.path, confidence: route.confidence, route: route.path, payload: route });
  for (const state of analysis.states) addNode(state.id, { kind: "state", label: state.name, confidence: state.confidence, route: state.route, payload: state });
  for (const derived of analysis.derivedState) addNode(derived.id, { kind: "derived", label: derived.name, confidence: derived.confidence, route: derived.route, payload: derived });
  for (const apiCall of analysis.apiCalls) addNode(apiCall.id, { kind: "api", label: `${apiCall.method} ${apiCall.endpoint}`, confidence: apiCall.confidence, route: apiCall.route, payload: apiCall });
  for (const nav of analysis.navigation) addNode(nav.id, { kind: "navigation", label: nav.target, confidence: nav.confidence, route: nav.sourceRoute, payload: nav });
  for (const conditional of analysis.conditionals) addNode(conditional.id, { kind: "conditional", label: conditional.condition, confidence: conditional.confidence, route: conditional.route, payload: conditional });
  for (const event of analysis.events) addNode(event.id, { kind: "event", label: describeEventNode(event), confidence: event.confidence, route: event.route, payload: event });

  const stateByName = new Map(analysis.states.map((state) => [state.name, state]));
  const derivedByDep = new Map();
  for (const derived of analysis.derivedState) {
    for (const dep of derived.dependencies) {
      if (!derivedByDep.has(dep)) derivedByDep.set(dep, []);
      derivedByDep.get(dep).push(derived);
    }
  }

  for (const event of analysis.events) {
    const route = analysis.routes.find((candidate) => candidate.path === event.route);
    if (route) addEdge(route.id, event.id, "contains");

    for (const effect of event.triggeredEffects) {
      if (effect.kind === "state_mutation") {
        const state = stateByName.get(effect.target);
        if (state) {
          addEdge(event.id, state.id, "writes");
          const derivedNodes = derivedByDep.get(state.name) || [];
          for (const derived of derivedNodes) {
            addEdge(state.id, derived.id, "derives");
          }
        }
      } else if (effect.kind === "api_call") {
        const api = analysis.apiCalls.find((candidate) => `${candidate.method} ${candidate.endpoint}` === effect.target && candidate.sourceFile === event.sourceFile);
        if (api) addEdge(event.id, api.id, "calls");
      } else if (effect.kind === "navigation") {
        const nav = analysis.navigation.find((candidate) => candidate.target === effect.target && candidate.sourceFile === event.sourceFile);
        if (nav) {
          addEdge(event.id, nav.id, "navigates");
          const targetRoute = analysis.routes.find((candidate) => candidate.path === nav.target);
          if (targetRoute) addEdge(nav.id, targetRoute.id, "targets");
        }
      }
    }
  }

  for (const state of analysis.states) {
    const route = analysis.routes.find((candidate) => candidate.path === state.route);
    if (route) addEdge(route.id, state.id, "state");
  }

  for (const conditional of analysis.conditionals) {
    const route = analysis.routes.find((candidate) => candidate.path === conditional.route);
    if (route) addEdge(route.id, conditional.id, "guards");
    for (const state of analysis.states) {
      if (new RegExp(`\\b${escapeRegExp(state.name)}\\b`).test(conditional.condition)) {
        addEdge(state.id, conditional.id, "controls");
      }
    }
  }

  return { graph, nodeMeta };
}

function enumerateFlows(analysis, graphContext) {
  const { graph, nodeMeta } = graphContext;
  const flows = [];
  const startNodes = analysis.events.map((event) => event.id);

  for (const eventId of startNodes) {
    const eventNode = nodeMeta.get(eventId);
    const route = eventNode.route;
    const routeNode = analysis.routes.find((candidate) => candidate.path === route);
    const prefix = routeNode ? [routeNode.id, eventId] : [eventId];
    const visited = new Set(prefix);
    const eventPayload = eventNode.payload;
    const paths = dfsPaths(graph, eventId, visited, 0, 8);
    if (paths.length === 0) {
      flows.push(flowFromPath(prefix, nodeMeta, analysis, eventPayload));
      continue;
    }
    for (const tail of paths) {
      flows.push(flowFromPath(routeNode ? [routeNode.id, ...tail] : tail, nodeMeta, analysis, eventPayload));
    }
  }

  for (const apiCall of analysis.apiCalls.filter((item) => item.enclosingFunction === "module" || item.enclosingFunction === "useEffect")) {
    const routeNode = analysis.routes.find((candidate) => candidate.path === apiCall.route);
    const nodes = routeNode ? [routeNode.id, apiCall.id] : [apiCall.id];
    flows.push({
      id: `flow:auto:${apiCall.id}`,
      name: `Auto-load ${apiCall.endpoint}`,
      group: routeGroupName(apiCall.route, apiCall.endpoint),
      route: apiCall.route,
      kind: "auto_load",
      steps: nodes.map((nodeId) => nodeMeta.get(nodeId)?.label || nodeId),
      nodeIds: nodes,
      confidence: apiCall.confidence,
      outcome: `Calls ${apiCall.method} ${apiCall.endpoint} on load`,
    });
  }

  return dedupeBy(flows, (flow) => `${flow.route}:${flow.name}:${flow.steps.join(">")}`);
}

function dfsPaths(graph, currentId, visited, depth, maxDepth) {
  if (depth >= maxDepth) return [[currentId]];
  const outgoing = graph.outEdges(currentId) || [];
  if (outgoing.length === 0) return [[currentId]];
  const results = [];
  let extended = false;
  for (const edge of outgoing) {
    if (visited.has(edge.w)) continue;
    extended = true;
    visited.add(edge.w);
    const subPaths = dfsPaths(graph, edge.w, visited, depth + 1, maxDepth);
    for (const subPath of subPaths) {
      results.push([currentId, ...subPath]);
    }
    visited.delete(edge.w);
  }
  if (!extended) return [[currentId]];
  return results;
}

function flowFromPath(nodeIds, nodeMeta, analysis, eventPayload) {
  const nodes = nodeIds.map((id) => nodeMeta.get(id)).filter(Boolean);
  const confidence = nodes.reduce((min, node) => Math.min(min, node.confidence || 1), 1);
  const steps = nodes.map((node) => node.label);
  const leaf = nodes[nodes.length - 1];
  const name = inferFlowName(eventPayload, leaf);
  return {
    id: `flow:${nodeIds.join("->")}`,
    name,
    group: routeGroupName(eventPayload.route, name),
    route: eventPayload.route,
    kind: "interactive",
    steps,
    nodeIds,
    confidence: clampConfidence(confidence),
    outcome: inferOutcome(leaf),
  };
}

function describeEventNode(event) {
  const target = event.elementText || event.elementLabel || event.elementPlaceholder || event.elementTestId || event.element;
  return `${event.event}:${target}`;
}

function inferFlowName(event, leaf) {
  const target = event.elementText || event.elementLabel || event.elementPlaceholder || event.elementTestId || event.element;
  if (leaf && leaf.kind === "navigation") return `Navigate via ${target}`;
  if (leaf && leaf.kind === "api") return `Execute ${target}`;
  if (leaf && leaf.kind === "state") return `Update ${leaf.label}`;
  return `${event.event} ${target}`;
}

function inferOutcome(leaf) {
  if (!leaf) return "Behavior reaches a terminal state";
  if (leaf.kind === "navigation") return `Navigates to ${leaf.label}`;
  if (leaf.kind === "api") return `Calls ${leaf.label}`;
  if (leaf.kind === "state") return `Updates ${leaf.label}`;
  if (leaf.kind === "derived") return `Recomputes ${leaf.label}`;
  if (leaf.kind === "conditional") return `Affects conditional UI: ${leaf.label}`;
  if (leaf.kind === "route") return `Route becomes ${leaf.label}`;
  return `Reaches ${leaf.label}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { buildFlowGraph, enumerateFlows };
