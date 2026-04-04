const fs = require("fs");
const path = require("path");

function writeOutputs(result) {
  fs.mkdirSync(result.outputDir, { recursive: true });
  const baseName = `${sanitizeFileName(result.projectName || "project")}-behavior`;
  const enrichedResult = {
    ...result,
    summary: buildSummary(result),
  };
  const jsonPath = path.join(result.outputDir, `${baseName}.json`);
  const textPath = path.join(result.outputDir, `${baseName}.txt`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(enrichedResult, null, 2)}\n`, "utf8");
  fs.writeFileSync(textPath, renderText(enrichedResult), "utf8");
  return { jsonPath, textPath };
}

function renderText(result) {
  const groups = groupBehaviors(result.behaviors);
  const apiSurface = uniqueApis(result.apiCalls);
  const routeList = [...result.routes].sort((a, b) => a.path.localeCompare(b.path));

  const lines = [];
  lines.push("PROJECT SUMMARY");
  lines.push("");
  lines.push(`Project: ${result.projectName}`);
  lines.push(`Framework: ${result.framework}`);
  lines.push(`Input path: ${result.inputPath}`);
  lines.push(`Output directory: ${result.outputDir}`);
  lines.push(`Routes discovered: ${result.routes.length}`);
  lines.push(`States discovered: ${result.states.length}`);
  lines.push(`API calls discovered: ${result.apiCalls.length}`);
  lines.push(`Events discovered: ${result.events.length}`);
  lines.push(`Behaviors discovered: ${result.behaviors.length}`);
  lines.push(`Data flows discovered: ${result.dataFlows.length}`);
  lines.push(`Flows discovered: ${result.flows.length}`);
  lines.push("");

  lines.push("KEY ROUTES");
  lines.push("");
  if (routeList.length === 0) {
    lines.push("No routes were detected.");
  } else {
    for (const route of routeList.slice(0, 40)) {
      lines.push(`${route.path} -> ${route.component} (${route.sourceFile})`);
    }
    if (routeList.length > 40) {
      lines.push(`... ${routeList.length - 40} more routes`);
    }
  }
  lines.push("");

  lines.push("API SURFACE");
  lines.push("");
  if (apiSurface.length === 0) {
    lines.push("No API calls were detected.");
  } else {
    for (const api of apiSurface.slice(0, 40)) {
      lines.push(`${api.method} ${api.endpoint}`);
    }
    if (apiSurface.length > 40) {
      lines.push(`... ${apiSurface.length - 40} more API endpoints`);
    }
  }
  lines.push("");

  lines.push("FEATURE BEHAVIORS");
  lines.push("");
  for (const group of [...groups.keys()].sort()) {
    const behaviors = groups.get(group);
    lines.push(group.toUpperCase());
    lines.push("");
    lines.push(`Behaviors in group: ${behaviors.length}`);
    lines.push("");
    for (const behavior of behaviors.slice(0, 20)) {
      lines.push(behavior.title);
      lines.push(`-> Trigger: ${behavior.trigger}`);
      for (const step of behavior.internalSteps) {
        lines.push(`-> Internal: ${step}`);
      }
      for (const outcome of behavior.outcome) {
        lines.push(`-> Outcome: ${outcome}`);
      }
      if (behavior.route) lines.push(`-> Route: ${behavior.route}`);
      lines.push(`-> Confidence: ${behavior.confidence}`);
      lines.push("");
    }
    if (behaviors.length > 20) {
      lines.push(`... ${behaviors.length - 20} more behaviors in ${group}`);
      lines.push("");
    }
  }

  lines.push("FLOW HIGHLIGHTS");
  lines.push("");
  for (const flow of result.flows.slice(0, 80)) {
    lines.push(flow.name);
    lines.push(`-> Route: ${flow.route || "n/a"}`);
    for (const step of flow.steps) {
      lines.push(`-> Step: ${step}`);
    }
    lines.push(`-> Outcome: ${flow.outcome}`);
    lines.push(`-> Confidence: ${flow.confidence}`);
    lines.push("");
  }
  if (result.flows.length > 80) {
    lines.push(`... ${result.flows.length - 80} more flows`);
    lines.push("");
  }

  lines.push("DATA FLOWS");
  lines.push("");
  for (const flow of result.dataFlows.slice(0, 80)) {
    lines.push(flow.name);
    lines.push(`-> Source: ${flow.source}`);
    for (const step of flow.steps) {
      lines.push(`-> Step: ${step}`);
    }
    lines.push(`-> Sink: ${flow.sink}`);
    lines.push(`-> Confidence: ${flow.confidence}`);
    lines.push("");
  }
  if (result.dataFlows.length > 80) {
    lines.push(`... ${result.dataFlows.length - 80} more data flows`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function buildSummary(result) {
  const grouped = groupBehaviors(result.behaviors);
  const featureGroups = [...grouped.entries()]
    .map(([name, behaviors]) => ({
      name,
      behaviorCount: behaviors.length,
      routes: [...new Set(behaviors.map((behavior) => behavior.route).filter(Boolean))].sort(),
      topBehaviors: behaviors.slice(0, 8).map((behavior) => ({
        title: behavior.title,
        trigger: behavior.trigger,
        route: behavior.route,
        confidence: behavior.confidence,
      })),
    }))
    .sort((a, b) => b.behaviorCount - a.behaviorCount);

  return {
    projectName: result.projectName,
    counts: {
      routes: result.routes.length,
      states: result.states.length,
      derivedState: result.derivedState.length,
      events: result.events.length,
      apiCalls: result.apiCalls.length,
      navigation: result.navigation.length,
      conditionals: result.conditionals.length,
      behaviors: result.behaviors.length,
      dataFlows: result.dataFlows.length,
      flows: result.flows.length,
    },
    routes: result.routes.slice(0, 50).map((route) => ({
      path: route.path,
      component: route.component,
      sourceFile: route.sourceFile,
    })),
    apiSurface: uniqueApis(result.apiCalls).slice(0, 50),
    featureGroups,
  };
}

function groupBehaviors(behaviors) {
  const groups = new Map();
  for (const behavior of behaviors) {
    if (!groups.has(behavior.group)) groups.set(behavior.group, []);
    groups.get(behavior.group).push(behavior);
  }
  for (const [name, list] of groups.entries()) {
    groups.set(
      name,
      [...list].sort((a, b) => {
        if ((b.confidence || 0) !== (a.confidence || 0)) return (b.confidence || 0) - (a.confidence || 0);
        return (a.title || "").localeCompare(b.title || "");
      })
    );
  }
  return groups;
}

function uniqueApis(apiCalls) {
  const seen = new Set();
  const items = [];
  for (const apiCall of apiCalls) {
    const key = `${apiCall.method}:${apiCall.endpoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ method: apiCall.method, endpoint: apiCall.endpoint });
  }
  return items.sort((a, b) => `${a.method} ${a.endpoint}`.localeCompare(`${b.method} ${b.endpoint}`));
}

function sanitizeFileName(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "project";
}

module.exports = { writeOutputs };
