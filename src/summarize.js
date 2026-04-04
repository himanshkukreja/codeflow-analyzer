const { dedupeBy, routeGroupName, titleCase } = require("./utils");

function synthesizeBehaviors(analysis) {
  const behaviors = [];
  const dataFlows = [];

  for (const event of analysis.events) {
    const title = behaviorTitle(event);
    const internalSteps = [];
    const outcome = [];
    const signals = ["event"];

    if (event.guardCondition) {
      internalSteps.push(`Guarded by ${event.guardCondition}`);
      signals.push("conditional");
    }

    for (const effect of event.triggeredEffects) {
      if (effect.kind === "state_mutation") {
        internalSteps.push(`Updates state ${effect.target}`);
        outcome.push(`UI may re-render from ${effect.target}`);
        signals.push("state");
      } else if (effect.kind === "api_call") {
        internalSteps.push(`Calls API ${effect.target}`);
        signals.push("api");
      } else if (effect.kind === "navigation") {
        internalSteps.push(`Navigates to ${effect.target}`);
        outcome.push(`Route changes to ${effect.target}`);
        signals.push("navigation");
      } else if (effect.kind === "action_call") {
        internalSteps.push(`Calls shared action ${effect.resolvedTo}`);
      } else if (effect.kind === "browser_api") {
        internalSteps.push(`Uses ${effect.target}`);
      }
    }

    if (outcome.length === 0) {
      outcome.push(defaultOutcome(event));
    }

    behaviors.push({
      id: `behavior:${event.id}`,
      title,
      group: routeGroupName(event.route, title),
      route: event.route,
      trigger: triggerLabel(event),
      internalSteps: [...new Set(internalSteps)],
      outcome: [...new Set(outcome)],
      signals: [...new Set(signals)],
      confidence: event.confidence,
    });

    dataFlows.push(...flowsFromEvent(event, analysis));
  }

  for (const derived of analysis.derivedState) {
    dataFlows.push({
      id: `dataflow:${derived.id}`,
      name: `${derived.name} derivation`,
      group: routeGroupName(derived.route, derived.name),
      route: derived.route,
      source: derived.dependencies.join(", "),
      steps: [...derived.dependencies.map((dep) => `state:${dep}`), `derived:${derived.name}`],
      sink: derived.name,
      confidence: derived.confidence,
    });
  }

  return {
    behaviors: dedupeBy(behaviors, (behavior) => `${behavior.route}:${behavior.title}:${behavior.trigger}`),
    dataFlows: dedupeBy(dataFlows, (flow) => `${flow.route}:${flow.name}:${flow.source}:${flow.sink}`),
  };
}

function behaviorTitle(event) {
  const combined = [
    event.handlerName,
    event.elementText,
    event.elementLabel,
    event.elementPlaceholder,
    event.elementTestId,
    event.route,
    ...event.triggeredEffects.map((effect) => String(effect.target || "")),
  ]
    .join(" ")
    .toLowerCase();

  if (combined.includes("/api/auth/login") || combined.includes("login")) return "User can log in";
  if (combined.includes("/api/auth/logout") || combined.includes("logout")) return "User can log out";
  if (combined.includes("search")) return `User can search ${pluralEntity(event.route)}`;
  if (combined.includes("filter") || combined.includes("status")) return `User can filter ${pluralEntity(event.route)}`;
  if (combined.includes("delete")) return `User can delete a ${singularEntity(event.route)}`;
  if (combined.includes("save") || combined.includes("update") || combined.includes("put /api/")) return `User can update a ${singularEntity(event.route)}`;
  if (event.event === "submit") return `User can submit the form on ${event.route || "this page"}`;
  if (event.event === "click" && (event.elementText || event.elementLabel)) return `User can click "${event.elementText || event.elementLabel}"`;
  if (event.event === "change") return `User can update ${event.elementPlaceholder || event.elementLabel || event.elementTestId || event.element}`;
  return `User can interact with ${event.element}`;
}

function triggerLabel(event) {
  const target = event.elementText || event.elementLabel || event.elementPlaceholder || event.elementTestId || event.element;
  return `${titleCase(event.event)} ${target}`.trim();
}

function defaultOutcome(event) {
  if (event.event === "change") return "Derived UI state may update";
  if (event.event === "submit") return "Submission outcome depends on handler logic";
  return "Application behavior changes according to handler side effects";
}

function flowsFromEvent(event) {
  const stateTargets = event.triggeredEffects.filter((effect) => effect.kind === "state_mutation").map((effect) => effect.target);
  const apiTargets = event.triggeredEffects.filter((effect) => effect.kind === "api_call").map((effect) => effect.target);
  const navTargets = event.triggeredEffects.filter((effect) => effect.kind === "navigation").map((effect) => effect.target);
  const result = [];
  if (stateTargets.length === 0 && apiTargets.length === 0 && navTargets.length === 0) return result;

  result.push({
    id: `dataflow:event:${event.id}`,
    name: behaviorTitle(event),
    group: routeGroupName(event.route, behaviorTitle(event)),
    route: event.route,
    source: triggerLabel(event),
    steps: [
      triggerLabel(event),
      ...stateTargets.map((name) => `state:${name}`),
      ...apiTargets.map((name) => `api:${name}`),
      ...navTargets.map((name) => `navigation:${name}`),
    ],
    sink: navTargets[0] || stateTargets[0] || apiTargets[0] || "UI",
    confidence: event.confidence,
  });
  return result;
}

function pluralEntity(route) {
  if (!route || route === "/") return "items";
  return route.replace(/^\//, "").split("/", 1)[0] || "items";
}

function singularEntity(route) {
  const plural = pluralEntity(route);
  return plural.endsWith("s") ? plural.slice(0, -1) : plural;
}

module.exports = { synthesizeBehaviors };
