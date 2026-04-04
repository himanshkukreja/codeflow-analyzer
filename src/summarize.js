const { dedupeBy, titleCase } = require("./utils");

const LOW_SIGNAL_EVENTS = new Set(["error", "load", "mouseenter", "mouseleave", "mousemove", "mouseover", "mouseout", "focus", "blur", "expired", "ended"]);
const GENERIC_TARGETS = new Set(["button", "input", "form", "div", "span", "img", "svg", "path", "code", "modal", "unknown"]);
const GENERIC_LABELS = new Set(["button", "submit", "close", "cancel", "open", "back", "next", "previous", "ok", "done"]);

const FEATURE_ALIASES = new Map([
  ["app", "Application"],
  ["apps", "Applications"],
  ["app-library", "Applications"],
  ["applications", "Applications"],
  ["application", "Applications"],
  ["auth", "Authentication"],
  ["login", "Authentication"],
  ["sessions", "Sessions"],
  ["session", "Sessions"],
  ["devices", "Devices"],
  ["device", "Devices"],
  ["real-devices", "Real Devices"],
  ["virtual-devices", "Virtual Devices"],
  ["installs", "Installs"],
  ["install", "Installs"],
  ["dashboard", "Dashboard"],
  ["sidebar", "Navigation"],
  ["nav", "Navigation"],
  ["not-found", "Application"],
  ["notfound", "Application"],
]);

function synthesizeBehaviors(analysis) {
  const behaviors = [];
  const dataFlows = [];

  for (const event of analysis.events) {
    const behavior = buildBehavior(event);
    if (!behavior) continue;
    behaviors.push(behavior);
    dataFlows.push(...flowsFromBehavior(behavior, event));
  }

  for (const derived of analysis.derivedState) {
    dataFlows.push({
      id: `dataflow:${derived.id}`,
      name: `${humanizeIdentifier(derived.name)} derivation`,
      group: inferFeatureNameFromSource(derived.route, derived.sourceFile, derived.name),
      route: derived.route,
      source: derived.dependencies.join(", "),
      steps: [...derived.dependencies.map((dep) => `state:${dep}`), `derived:${derived.name}`],
      sink: derived.name,
      confidence: derived.confidence,
      priority: 4,
    });
  }

  return {
    behaviors: dedupeBy(
      behaviors.sort(compareBehavior),
      (behavior) => `${behavior.group}:${behavior.title}:${normalizeKey(behavior.trigger)}`
    ),
    dataFlows: dedupeBy(
      dataFlows.sort((a, b) => (b.priority || 0) - (a.priority || 0)),
      (flow) => `${flow.group}:${flow.name}:${flow.source}:${flow.sink}`
    ),
  };
}

function buildBehavior(event) {
  const feature = inferFeatureName(event);
  const semantics = inferBehaviorSemantics(event, feature);
  const priority = scoreBehavior(event, semantics);

  if (shouldDropBehavior(event, semantics, priority)) return null;

  const internalSteps = [];
  const outcome = [];
  const signals = ["event"];

  if (event.guardCondition) {
    internalSteps.push(`Available when ${event.guardCondition}`);
    signals.push("conditional");
  }

  for (const effect of event.triggeredEffects) {
    if (effect.kind === "state_mutation") {
      internalSteps.push(`Updates ${humanizeIdentifier(effect.target)} state`);
      outcome.push(`UI can update from ${humanizeIdentifier(effect.target)} changes`);
      signals.push("state");
    } else if (effect.kind === "api_call") {
      internalSteps.push(`Calls ${effect.target}`);
      signals.push("api");
    } else if (effect.kind === "navigation") {
      const navigationTarget = describeNavigationTarget(effect.target);
      internalSteps.push(`Navigates to ${navigationTarget}`);
      outcome.push(`Route changes to ${navigationTarget}`);
      signals.push("navigation");
    } else if (effect.kind === "action_call") {
      internalSteps.push(`Runs shared action ${effect.resolvedTo}`);
    } else if (effect.kind === "browser_api") {
      internalSteps.push(`Uses ${effect.target}`);
    }
  }

  if (outcome.length === 0) {
    outcome.push(defaultOutcome(event, semantics, feature));
  }

  return {
    id: `behavior:${event.id}`,
    title: semantics.title,
    group: feature,
    route: event.route,
    feature,
    trigger: semantics.trigger,
    internalSteps: [...new Set(internalSteps)],
    outcome: [...new Set(outcome)],
    signals: [...new Set(signals)],
    confidence: event.confidence,
    priority,
    sourceFile: event.sourceFile,
  };
}

function inferBehaviorSemantics(event, feature) {
  const apiEffects = event.triggeredEffects.filter((effect) => effect.kind === "api_call").map((effect) => effect.target);
  const navEffects = event.triggeredEffects.filter((effect) => effect.kind === "navigation").map((effect) => effect.target);
  const stateEffects = event.triggeredEffects.filter((effect) => effect.kind === "state_mutation").map((effect) => effect.target);

  const bestLabel = bestTargetLabel(event, feature);
  const genericLabel = isGenericLabel(bestLabel);
  const combined = [bestLabel, event.handlerName, event.element, ...apiEffects, ...stateEffects].filter(Boolean).join(" ").toLowerCase();

  if (isSearchEvent(event, bestLabel, [...stateEffects, ...apiEffects])) {
    return {
      title: `User can search ${featureEntityPlural(feature)}`,
      trigger: defaultTrigger(event, bestLabel || `Search ${featureEntityPlural(feature)}`, feature),
      targetLabel: bestLabel,
      specificity: 5,
      important: true,
    };
  }

  if (isFilterEvent(event, bestLabel, [...stateEffects, ...apiEffects])) {
    return {
      title: `User can filter ${featureEntityPlural(feature)}`,
      trigger: defaultTrigger(event, bestLabel || `Filter ${featureEntityPlural(feature)}`, feature),
      targetLabel: bestLabel,
      specificity: 5,
      important: true,
    };
  }

  if (apiEffects.length > 0) {
    const apiSemantic = describeApiBehavior(apiEffects[0], event, feature, bestLabel);
    return {
      title: apiSemantic.title,
      trigger: apiSemantic.trigger || defaultTrigger(event, bestLabel, feature),
      targetLabel: bestLabel,
      specificity: apiSemantic.specificity,
      important: true,
      apiAction: apiSemantic,
    };
  }

  if (combined.includes("release")) {
    return {
      title: "User can release a session",
      trigger: defaultTrigger(event, bestLabel || "Release", feature),
      targetLabel: bestLabel,
      specificity: 5,
      important: true,
    };
  }
  if (combined.includes("upload")) {
    return {
      title: "User can upload an application",
      trigger: defaultTrigger(event, bestLabel || "Upload", feature),
      targetLabel: bestLabel,
      specificity: 5,
      important: true,
    };
  }
  if (combined.includes("download")) {
    return {
      title: "User can download an application",
      trigger: defaultTrigger(event, bestLabel || "Download", feature),
      targetLabel: bestLabel,
      specificity: 5,
      important: true,
    };
  }
  if (combined.includes("screenshot")) {
    return {
      title: "User can take a screenshot",
      trigger: defaultTrigger(event, bestLabel || "Screenshot", feature),
      targetLabel: bestLabel,
      specificity: 5,
      important: true,
    };
  }
  if (combined.includes("record")) {
    return {
      title: combined.includes("stop") ? "User can stop a recording" : "User can start a recording",
      trigger: defaultTrigger(event, bestLabel || (combined.includes("stop") ? "Stop recording" : "Start recording"), feature),
      targetLabel: bestLabel,
      specificity: 5,
      important: true,
    };
  }
  if (combined.includes("logs")) {
    return {
      title: combined.includes("start") ? "User can start device logs" : "User can view device logs",
      trigger: defaultTrigger(event, bestLabel || "Logs", feature),
      targetLabel: bestLabel,
      specificity: 5,
      important: true,
    };
  }
  if (combined.includes("devtools")) {
    return {
      title: combined.includes("inspect") ? "User can inspect the session with DevTools" : "User can open DevTools tools",
      trigger: defaultTrigger(event, bestLabel || "DevTools", feature),
      targetLabel: bestLabel,
      specificity: 4,
      important: true,
    };
  }
  if (combined.includes("gallery")) {
    return {
      title: "User can open the session gallery",
      trigger: defaultTrigger(event, bestLabel || "Gallery", feature),
      targetLabel: bestLabel,
      specificity: 4,
      important: true,
    };
  }

  if (navEffects.length > 0) {
    const target = prettifyRoute(navEffects[0]);
    return {
      title: `User can navigate to ${target}`,
      trigger: defaultTrigger(event, bestLabel || target, feature),
      targetLabel: bestLabel || target,
      specificity: 4,
      important: true,
    };
  }

  if (isToggleEvent(event, bestLabel, stateEffects)) {
    return {
      title: `User can toggle ${bestLabel || humanizeIdentifier(stateEffects[0])}`,
      trigger: defaultTrigger(event, bestLabel || humanizeIdentifier(stateEffects[0]), feature),
      targetLabel: bestLabel,
      specificity: 3,
      important: Boolean(bestLabel && !genericLabel),
    };
  }

  if (event.event === "submit") {
    const formLabel = feature === "Authentication" ? "login form" : `${feature.toLowerCase()} form`;
    return {
      title: feature === "Authentication" ? "User can submit the login form" : `User can submit the ${feature.toLowerCase()} form`,
      trigger: `Submit ${formLabel}`,
      targetLabel: formLabel,
      specificity: 3,
      important: true,
    };
  }

  if (event.event === "change" || event.event === "input") {
    const target = bestLabel || humanizeIdentifier(stateEffects[0] || event.element);
    return {
      title: `User can update ${target}`,
      trigger: defaultTrigger(event, target, feature),
      targetLabel: target,
      specificity: genericLabel ? 1 : 3,
      important: Boolean(target),
    };
  }

  if (bestLabel && !genericLabel) {
    return {
      title: `User can use ${bestLabel}`,
      trigger: defaultTrigger(event, bestLabel, feature),
      targetLabel: bestLabel,
      specificity: 2,
      important: true,
    };
  }

  return {
    title: `User can interact with ${humanizeIdentifier(event.element || feature)}`,
    trigger: defaultTrigger(event, bestLabel || humanizeIdentifier(event.element), feature),
    targetLabel: bestLabel,
    specificity: 0,
    important: false,
  };
}

function describeApiBehavior(apiTarget, event, feature, label) {
  const [method = "", ...rest] = String(apiTarget).split(" ");
  const endpoint = rest.join(" ").trim();
  const cleaned = endpoint
    .replace(/^\/api\/v\d+\//, "")
    .replace(/^\/api\//, "")
    .replace(/:param/g, "item")
    .replace(/\?.*$/, "")
    .replace(/^\/+/, "");
  const segments = cleaned.split("/").filter(Boolean);
  const resource = segments[0] || featureEntityPlural(feature);
  const last = segments[segments.length - 1] || resource;
  const resourceName = resourceLabel(resource, feature);

  if (endpoint.includes("/auth/login")) {
    return {
      title: "User can log in",
      trigger: label ? defaultTrigger(event, label, feature) : "Submit login form",
      specificity: 6,
    };
  }
  if (endpoint.includes("/auth/logout")) {
    return {
      title: "User can log out",
      trigger: defaultTrigger(event, label || "Logout", feature),
      specificity: 6,
    };
  }
  if (endpoint.includes("/sessions/reserve")) {
    return {
      title: "User can reserve a device session",
      trigger: defaultTrigger(event, label || "Reserve device", feature),
      specificity: 6,
    };
  }
  if (/^sessions\/item\/release$/.test(cleaned)) {
    return {
      title: "User can release a session",
      trigger: defaultTrigger(event, label || "Release session", feature),
      specificity: 6,
    };
  }
  if (/^applications\/upload$/.test(cleaned)) {
    return {
      title: "User can upload an application",
      trigger: defaultTrigger(event, label || "Upload application", feature),
      specificity: 6,
    };
  }
  if (/^applications\/item\/download$/.test(cleaned)) {
    return {
      title: "User can download an application",
      trigger: defaultTrigger(event, label || "Download application", feature),
      specificity: 6,
    };
  }
  if (method === "DELETE" && /^applications\/item$/.test(cleaned)) {
    return {
      title: "User can delete an application",
      trigger: defaultTrigger(event, label || "Delete application", feature),
      specificity: 6,
    };
  }
  if (/^installs$/.test(cleaned) && method === "POST") {
    return {
      title: "User can install an application on a device",
      trigger: defaultTrigger(event, label || "Install application", feature),
      specificity: 6,
    };
  }
  if (/^screenshots\/item\/take$/.test(cleaned)) {
    return {
      title: "User can take a screenshot",
      trigger: defaultTrigger(event, label || "Take screenshot", feature),
      specificity: 6,
    };
  }
  if (/^recordings\/item\/start$/.test(cleaned)) {
    return {
      title: "User can start a recording",
      trigger: defaultTrigger(event, label || "Start recording", feature),
      specificity: 6,
    };
  }
  if (/^recordings\/item\/stop$/.test(cleaned)) {
    return {
      title: "User can stop a recording",
      trigger: defaultTrigger(event, label || "Stop recording", feature),
      specificity: 6,
    };
  }
  if (/^location\/item\/set$/.test(cleaned)) {
    return {
      title: "User can set a mocked device location",
      trigger: defaultTrigger(event, label || "Set location", feature),
      specificity: 6,
    };
  }
  if (/^location\/item\/clear$/.test(cleaned)) {
    return {
      title: "User can clear the mocked device location",
      trigger: defaultTrigger(event, label || "Clear location", feature),
      specificity: 6,
    };
  }
  if (/^openurl\/item$/.test(cleaned)) {
    return {
      title: "User can open a URL on the device",
      trigger: defaultTrigger(event, label || "Open URL", feature),
      specificity: 6,
    };
  }
  if (/^devtools\/item\/start$/.test(cleaned)) {
    return {
      title: "User can start DevTools for the session",
      trigger: defaultTrigger(event, label || "Start DevTools", feature),
      specificity: 6,
    };
  }
  if (/^devtools\/item\/stop$/.test(cleaned)) {
    return {
      title: "User can stop DevTools for the session",
      trigger: defaultTrigger(event, label || "Stop DevTools", feature),
      specificity: 6,
    };
  }
  if (/^logs\/item\/start$/.test(cleaned)) {
    return {
      title: "User can start device logs",
      trigger: defaultTrigger(event, label || "Start logs", feature),
      specificity: 6,
    };
  }
  if (/^sessions\/item\/input$/.test(cleaned)) {
    return {
      title: "User can send device input",
      trigger: defaultTrigger(event, label || "Send input", feature),
      specificity: 6,
    };
  }
  if (/^biometric\/item\/match$/.test(cleaned)) {
    return {
      title: "User can simulate a matching biometric scan",
      trigger: defaultTrigger(event, label || "Match biometric", feature),
      specificity: 6,
    };
  }
  if (/^biometric\/item\/nomatch$/.test(cleaned)) {
    return {
      title: "User can simulate a failed biometric scan",
      trigger: defaultTrigger(event, label || "Reject biometric", feature),
      specificity: 6,
    };
  }
  if (/^biometric\/item\/enroll$/.test(cleaned)) {
    return {
      title: "User can enroll biometrics",
      trigger: defaultTrigger(event, label || "Enroll biometrics", feature),
      specificity: 6,
    };
  }
  if (/^biometric\/item\/unenroll$/.test(cleaned)) {
    return {
      title: "User can remove enrolled biometrics",
      trigger: defaultTrigger(event, label || "Remove biometrics", feature),
      specificity: 6,
    };
  }

  if (method === "GET" && label && /refresh|reload/i.test(label)) {
    return {
      title: `User can refresh ${resourceName}`,
      trigger: defaultTrigger(event, label, feature),
      specificity: 5,
    };
  }
  if (method === "GET") {
    return {
      title: `User can view ${resourceName}`,
      trigger: defaultTrigger(event, label || `View ${resourceName}`, feature),
      specificity: 4,
    };
  }
  if (method === "POST") {
    return {
      title: `User can ${verbFromSegment(last, "create")} ${resourceSingular(resourceName)}`,
      trigger: defaultTrigger(event, label || humanizeIdentifier(last), feature),
      specificity: 4,
    };
  }
  if (method === "PUT" || method === "PATCH") {
    return {
      title: `User can update ${resourceSingular(resourceName)}`,
      trigger: defaultTrigger(event, label || "Update", feature),
      specificity: 4,
    };
  }
  if (method === "DELETE") {
    return {
      title: `User can delete ${resourceSingular(resourceName)}`,
      trigger: defaultTrigger(event, label || "Delete", feature),
      specificity: 4,
    };
  }

  return {
    title: `User can interact with ${resourceName}`,
    trigger: defaultTrigger(event, label || humanizeIdentifier(last), feature),
    specificity: 2,
  };
}

function flowsFromBehavior(behavior, event) {
  const stateTargets = event.triggeredEffects.filter((effect) => effect.kind === "state_mutation").map((effect) => effect.target);
  const apiTargets = event.triggeredEffects.filter((effect) => effect.kind === "api_call").map((effect) => effect.target);
  const navTargets = event.triggeredEffects.filter((effect) => effect.kind === "navigation").map((effect) => effect.target);
  const result = [];

  if (stateTargets.length === 0 && apiTargets.length === 0 && navTargets.length === 0) return result;

  result.push({
    id: `dataflow:event:${event.id}`,
    name: behavior.title,
    group: behavior.group,
    route: event.route,
    source: behavior.trigger,
    steps: [
      behavior.trigger,
      ...stateTargets.map((name) => `state:${name}`),
      ...apiTargets.map((name) => `api:${name}`),
      ...navTargets.map((name) => `navigation:${name}`),
    ],
    sink: navTargets[0] || stateTargets[0] || apiTargets[0] || "UI",
    confidence: event.confidence,
    priority: behavior.priority,
  });

  return result;
}

function defaultOutcome(event, semantics, feature) {
  if (semantics.apiAction && semantics.apiAction.title === "User can log in") {
    return "Authentication state updates after the login attempt";
  }
  if (event.event === "change" || event.event === "input") return `Visible ${feature.toLowerCase()} state may update`;
  if (event.event === "submit") return "Submission outcome depends on the handler logic";
  if (semantics.targetLabel && !isGenericLabel(semantics.targetLabel)) {
    return `${semantics.targetLabel} interaction changes visible application state`;
  }
  return "Application behavior changes according to the handler side effects";
}

function scoreBehavior(event, semantics) {
  let score = 0;
  const hasApi = event.triggeredEffects.some((effect) => effect.kind === "api_call");
  const hasNav = event.triggeredEffects.some((effect) => effect.kind === "navigation");
  const hasState = event.triggeredEffects.some((effect) => effect.kind === "state_mutation");
  const hasAction = event.triggeredEffects.some((effect) => effect.kind === "action_call");
  const hasMeaningfulLabel = Boolean(semantics.targetLabel && !isGenericLabel(semantics.targetLabel));

  if (event.route) score += 3;
  if (hasApi) score += 6;
  if (hasNav) score += 5;
  if (hasAction) score += 4;
  if (hasState) score += 2;
  if (hasMeaningfulLabel) score += 3;
  if (event.guardCondition) score += 1;
  score += semantics.specificity || 0;

  if (LOW_SIGNAL_EVENTS.has(event.event)) score -= 5;
  if (!hasApi && !hasNav && !hasAction && !hasState) score -= 4;
  if (!event.route && !hasApi && !hasNav && !hasMeaningfulLabel) score -= 3;
  if (!hasMeaningfulLabel) score -= 2;

  return score;
}

function shouldDropBehavior(event, semantics, priority) {
  const hasEffects = event.triggeredEffects.length > 0;
  const hasMeaningfulLabel = Boolean(semantics.targetLabel && !isGenericLabel(semantics.targetLabel));

  if (LOW_SIGNAL_EVENTS.has(event.event) && !hasEffects) return true;
  if (priority < 3) return true;
  if (!hasEffects && !event.route && !hasMeaningfulLabel) return true;
  return false;
}

function inferFeatureName(event) {
  return inferFeatureNameFromSource(event.route, event.sourceFile, event.handlerName || event.element);
}

function inferFeatureNameFromSource(route, sourceFile, fallback) {
  if (route) {
    const routeSegment = route.replace(/^\//, "").split("/", 1)[0];
    if (!routeSegment) return "Dashboard";
    const alias = FEATURE_ALIASES.get(routeSegment.toLowerCase());
    if (alias) return alias;
    return titleCase(routeSegment);
  }

  const normalized = String(sourceFile || "").replace(/^src\//, "");
  const segments = normalized.split("/").filter(Boolean);
  const candidates = [];
  if (segments[0] === "pages" && segments[1]) candidates.push(pathStem(segments[1]));
  if (segments[0] === "components" && segments[1]) candidates.push(pathStem(segments[1]));
  if (segments[0] === "hooks" && segments[1]) candidates.push(pathStem(segments[1]).replace(/^use/, ""));
  if (segments[0] === "api" && segments[1]) candidates.push(pathStem(segments[1]));
  if (segments.length > 0) candidates.push(pathStem(segments[segments.length - 1]));
  if (fallback) candidates.push(String(fallback));

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeFeatureToken(candidate);
    const alias = FEATURE_ALIASES.get(normalizedCandidate);
    if (alias) return alias;
    if (normalizedCandidate) return titleCase(normalizedCandidate);
  }

  return "Application";
}

function bestTargetLabel(event, feature) {
  if (event.event === "submit") {
    if (feature === "Authentication") return "login form";
    return `${feature.toLowerCase()} form`;
  }

  const candidates = [
    cleanUiText(event.elementLabel),
    cleanUiText(event.elementPlaceholder),
    cleanUiText(event.elementText),
    cleanUiText(event.elementTestId),
    humanizeTargetIdentifier(event.element),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!isWorthUsingAsTarget(candidate)) continue;
    return candidate;
  }

  return null;
}

function defaultTrigger(event, targetLabel, feature) {
  const eventLabel = titleCase(event.event || "interact");
  if (targetLabel) return `${eventLabel} ${targetLabel}`.trim();
  if (feature) return `${eventLabel} ${feature.toLowerCase()}`.trim();
  return eventLabel;
}

function isSearchEvent(event, label, stateEffects) {
  const combined = [label, event.handlerName, ...stateEffects].filter(Boolean).join(" ").toLowerCase();
  return /search|query/.test(combined);
}

function isFilterEvent(event, label, stateEffects) {
  const combined = [label, event.handlerName, ...stateEffects].filter(Boolean).join(" ").toLowerCase();
  return /filter|status|brand|region|platform|type|sort|tab/.test(combined);
}

function isToggleEvent(event, label, stateEffects) {
  const combined = [label, event.handlerName, ...stateEffects].filter(Boolean).join(" ").toLowerCase();
  return /show|open|close|toggle|panel|modal|sidebar|collapse|expand/.test(combined);
}

function prettifyRoute(route) {
  if (!route) return "the next page";
  if (route === "/") return "Dashboard";
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(route)) return "the next page";
  return titleCase(route.replace(/^\//, "").replace(/\/:param/g, " details").replace(/\//g, " "));
}

function describeNavigationTarget(target) {
  if (!target) return "the next page";
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(target)) return "a computed route";
  return target;
}

function humanizeTargetIdentifier(value) {
  if (!value || GENERIC_TARGETS.has(String(value).toLowerCase())) return null;
  return humanizeIdentifier(value);
}

function humanizeIdentifier(value) {
  if (!value) return null;
  return String(value)
    .replace(/^use/, "")
    .replace(/^set/, "")
    .replace(/^handle/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toLowerCase());
}

function cleanUiText(value) {
  if (!value) return null;
  const cleaned = String(value)
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;
  if (cleaned.length > 70) return null;
  if (/[{}<>]/.test(cleaned)) return null;
  if (/className=|on[A-Z][a-z]+=?|=>|\/>|\(\)|\bstyle=/.test(cleaned)) return null;
  if (/^[^a-zA-Z0-9]+$/.test(cleaned)) return null;

  return cleaned;
}

function isWorthUsingAsTarget(value) {
  if (!value) return false;
  if (value.length === 1 && /[^a-zA-Z0-9]/.test(value)) return false;
  return true;
}

function isGenericLabel(value) {
  if (!value) return true;
  const normalized = String(value).trim().toLowerCase();
  return GENERIC_LABELS.has(normalized) || GENERIC_TARGETS.has(normalized);
}

function resourceLabel(resource, feature) {
  const alias = FEATURE_ALIASES.get(resource.toLowerCase());
  if (alias) return alias.toLowerCase();
  if (resource === "item") return featureEntityPlural(feature);
  return humanizeIdentifier(resource) || featureEntityPlural(feature);
}

function featureEntityPlural(feature) {
  const normalized = String(feature || "items").toLowerCase();
  if (normalized === "authentication") return "authentication fields";
  if (normalized.endsWith("s")) return normalized;
  if (normalized.endsWith("y")) return `${normalized.slice(0, -1)}ies`;
  return `${normalized}s`;
}

function resourceSingular(value) {
  if (!value) return "item";
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function verbFromSegment(segment, fallback) {
  const normalized = normalizeFeatureToken(segment);
  const mapping = {
    reserve: "reserve",
    release: "release",
    upload: "upload",
    download: "download",
    start: "start",
    stop: "stop",
    clear: "clear",
    set: "set",
    take: "take",
    openurl: "open",
    input: "send",
    install: "install",
  };
  return mapping[normalized] || fallback;
}

function normalizeFeatureToken(value) {
  return String(value || "")
    .replace(/\.(jsx|js|tsx|ts)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function pathStem(value) {
  return String(value || "").replace(/\.(jsx|js|tsx|ts)$/, "");
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compareBehavior(a, b) {
  if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
  if ((b.confidence || 0) !== (a.confidence || 0)) return (b.confidence || 0) - (a.confidence || 0);
  return (a.title || "").localeCompare(b.title || "");
}

module.exports = { synthesizeBehaviors };
