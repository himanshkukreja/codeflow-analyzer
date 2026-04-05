const fs = require("fs");
const path = require("path");

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "out",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function shouldIgnoreDir(name) {
  return IGNORED_DIRS.has(name);
}

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldIgnoreDir(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && isSourceFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  files.sort();
  return files;
}

function stripQuotes(value) {
  if (!value) return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeEndpoint(value) {
  if (!value) return value;
  let normalized = stripQuotes(value);
  normalized = normalized.replace(/\$\{[^}]+\}/g, ":param");
  normalized = normalized.replace(/\[(\.\.\.)?([^\]]+)\]/g, ":param");
  return normalized;
}

function textFromNodeText(value) {
  if (!value) return null;
  const cleaned = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]+\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function titleCase(value) {
  if (!value) return "Application";
  return value
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function routeGroupName(route, titleHint) {
  const hint = (titleHint || "").toLowerCase();
  if (hint.includes("login") || hint.includes("logout") || hint.includes("auth")) {
    return "Authentication";
  }
  if (route === "/" || !route) return "Application";
  const segment = route.replace(/^\//, "").split("/", 1)[0];
  return titleCase(segment || "Application");
}

function routeFromAppPath(relPath) {
  const normalized = toPosix(relPath);
  const appMarker = "/app/";
  const appIndex = normalized === "app" || normalized.startsWith("app/") ? 0 : normalized.indexOf(appMarker);
  if (appIndex < 0) return null;
  const appScoped = appIndex === 0 ? normalized : normalized.slice(appIndex + 1);
  if (!/^app\/.+\/page\.(tsx|ts|jsx|js)$/.test(appScoped) && !/^app\/page\.(tsx|ts|jsx|js)$/.test(appScoped)) return null;
  let route = appScoped
    .replace(/^app\//, "")
    .replace(/^page\.(tsx|ts|jsx|js)$/, "")
    .replace(/\/page\.(tsx|ts|jsx|js)$/, "")
    .replace(/\(([^)]+)\)\//g, "")
    .replace(/\(([^)]+)\)/g, "")
    .replace(/\[\.\.\.[^\]]+\]/g, ":param")
    .replace(/\[[^\]]+\]/g, ":param");
  route = `/${route.replace(/^\/+/, "")}`;
  return route === "/" ? "/" : route.replace(/\/+/g, "/");
}

function routeFromPagesPath(relPath) {
  const normalized = toPosix(relPath);
  const pagesMarker = "/pages/";
  const pagesIndex = normalized === "pages" || normalized.startsWith("pages/") ? 0 : normalized.indexOf(pagesMarker);
  if (pagesIndex < 0) return null;
  const pagesScoped = pagesIndex === 0 ? normalized : normalized.slice(pagesIndex + 1);
  if (pagesScoped.startsWith("pages/api/")) return null;
  if (!/^pages\/.+\.(tsx|ts|jsx|js)$/.test(pagesScoped) && !/^pages\/index\.(tsx|ts|jsx|js)$/.test(pagesScoped)) return null;
  let route = pagesScoped
    .replace(/^pages\//, "")
    .replace(/\.(tsx|ts|jsx|js)$/, "")
    .replace(/^index$/, "")
    .replace(/\/index$/, "")
    .replace(/\/\[[^\]]+\]/g, "/:param")
    .replace(/\[[^\]]+\]/g, ":param");
  if (/^_[^/]+$/.test(route)) return null;
  route = `/${route.replace(/^\/+/, "")}`;
  return route === "/" ? "/" : route.replace(/\/+/g, "/");
}

function featureNameFromRoute(route) {
  if (!route || route === "/") return "Application";
  const segment = route.replace(/^\//, "").split("/", 1)[0];
  if (!segment) return "Application";
  return titleCase(segment);
}

function lineNumber(sourceText, pos) {
  return sourceText.slice(0, pos).split("\n").length;
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function clampConfidence(value) {
  return Math.max(0, Math.min(1, value));
}

function formatTriggerLabel(parts) {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

module.exports = {
  SOURCE_EXTENSIONS,
  clampConfidence,
  dedupeBy,
  featureNameFromRoute,
  formatTriggerLabel,
  isSourceFile,
  lineNumber,
  normalizeEndpoint,
  routeFromAppPath,
  routeFromPagesPath,
  routeGroupName,
  shouldIgnoreDir,
  stripQuotes,
  textFromNodeText,
  titleCase,
  toPosix,
  walkFiles,
};
