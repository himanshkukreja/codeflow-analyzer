const { prepareInput } = require("./input");
const { createProjectContext } = require("./project");
const { preScanProject } = require("./prescan");
const { analyzeCodebase } = require("./extract");
const { buildFlowGraph, enumerateFlows } = require("./graph");
const { synthesizeBehaviors } = require("./summarize");
const { writeOutputs } = require("./output");

async function runCli(argv) {
  const { inputPath, outputDir } = parseArgs(argv.slice(2));
  if (!inputPath || inputPath === "--help" || inputPath === "-h") {
    printHelp();
    return;
  }
  if (inputPath === "--version" || inputPath === "-v") {
    printVersion();
    return;
  }

  const prepared = prepareInput(inputPath, { outputDir });
  try {
    const context = createProjectContext(prepared.analysisRoot, prepared.outputDir);
    const prescan = preScanProject(context);
    const extracted = analyzeCodebase(context, prescan);
    const graphContext = buildFlowGraph(extracted);
    const flows = enumerateFlows(extracted, graphContext);
    const synthesized = synthesizeBehaviors(extracted);

    const result = {
      projectName: prepared.projectName,
      inputPath: prepared.analysisRoot,
      outputDir: prepared.outputDir,
      framework: context.framework,
      routes: extracted.routes,
      states: extracted.states,
      derivedState: extracted.derivedState,
      events: extracted.events,
      apiCalls: extracted.apiCalls,
      navigation: extracted.navigation,
      conditionals: extracted.conditionals,
      behaviors: synthesized.behaviors,
      dataFlows: synthesized.dataFlows,
      flows,
    };

    const outputs = writeOutputs(result);
    console.log(`Wrote ${outputs.textPath}`);
    console.log(`Wrote ${outputs.jsonPath}`);
  } finally {
    prepared.cleanup();
  }
}

module.exports = { runCli };

function parseArgs(args) {
  let inputPath = null;
  let outputDir = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--output" || arg === "-o") {
      outputDir = args[i + 1];
      i += 1;
      continue;
    }
    if (!inputPath) {
      inputPath = arg;
    }
  }

  return { inputPath, outputDir };
}

function printHelp() {
  console.log(`Codeflow Analyzer

Usage:
  codeflow-analyzer <path-to-project-or-zip> [--output <directory>]

Options:
  -o, --output <directory>   Write output files to a custom directory
  -h, --help                 Show help
  -v, --version              Show version

Examples:
  codeflow-analyzer ./demo-app
  codeflow-analyzer ./demo-app --output ./reports
  npx codeflow-analyzer ./demo-app
`);
}

function printVersion() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const pkg = require("../package.json");
  console.log(pkg.version);
}
