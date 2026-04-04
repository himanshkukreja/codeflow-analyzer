const path = require("path");
const { parse, pattern, Lang } = require("@ast-grep/napi");
const { dedupeBy } = require("./utils");

const PATTERNS = {
  state: ["const [$STATE, $SETTER] = useState($INIT)", "const [$STATE, $DISPATCH] = useReducer($REDUCER, $INIT)"],
  api: ["fetch($URL, $$$)", "axios.$METHOD($URL, $$$)"],
  event: [
    "<$TAG onClick={$HANDLER} $$$>",
    "<$TAG onSubmit={$HANDLER} $$$>",
    "<$TAG onChange={$HANDLER} $$$>",
  ],
  navigation: ["<Link href={$TARGET} $$$>", "$ROUTER.push($TARGET)", "$ROUTER.replace($TARGET)", "navigate($TARGET)"],
  route: ["<Route path=$PATH element={$ELEMENT} $$$ />", "<Route path=$PATH $$$>$$$CHILD</Route>"],
};

function languageForFile(relPath) {
  const ext = path.extname(relPath);
  if (ext === ".tsx") return Lang.Tsx;
  if (ext === ".ts") return Lang.TypeScript;
  if (ext === ".jsx") return Lang.Jsx;
  return Lang.JavaScript;
}

function preScanProject(context) {
  const buckets = {};
  for (const key of Object.keys(PATTERNS)) {
    buckets[key] = new Set();
  }

  for (const meta of context.sourceFiles) {
    const lang = languageForFile(meta.relPath);
    let root;
    try {
      root = parse(lang, meta.content);
    } catch {
      continue;
    }

    for (const [bucketName, bucketPatterns] of Object.entries(PATTERNS)) {
      for (const bucketPattern of bucketPatterns) {
        const matcher = pattern(lang, bucketPattern);
        if (root.root().find(matcher)) {
          buckets[bucketName].add(meta.relPath);
          break;
        }
      }
    }
  }

  return buckets;
}

module.exports = { preScanProject };
