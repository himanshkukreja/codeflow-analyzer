const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

function prepareInput(inputArg, options = {}) {
  const resolved = path.resolve(inputArg);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Input path does not exist: ${resolved}`);
  }
  const requestedOutputDir = options.outputDir ? path.resolve(options.outputDir) : process.cwd();

  if (fs.statSync(resolved).isDirectory()) {
    return {
      inputPath: resolved,
      analysisRoot: resolved,
      outputDir: requestedOutputDir,
      projectName: inferProjectName(resolved),
      cleanup: () => {},
    };
  }

  if (path.extname(resolved).toLowerCase() !== ".zip") {
    throw new Error("Input must be a directory or a .zip file");
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "static-code-analyzer-"));
  const extractDir = path.join(tempRoot, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  const archive = new AdmZip(resolved);
  archive.extractAllTo(extractDir, true);

  const topLevel = fs
    .readdirSync(extractDir)
    .map((name) => path.join(extractDir, name))
    .filter((entryPath) => fs.statSync(entryPath).isDirectory());
  const analysisRoot = topLevel.length === 1 ? topLevel[0] : extractDir;

  return {
    inputPath: resolved,
    analysisRoot,
    outputDir: requestedOutputDir,
    projectName: inferProjectName(resolved, analysisRoot),
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function inferProjectName(inputPath, analysisRoot = null) {
  const stats = fs.statSync(inputPath);
  if (stats.isDirectory()) {
    return path.basename(inputPath);
  }
  if (path.extname(inputPath).toLowerCase() === ".zip") {
    return path.basename(inputPath, ".zip") || (analysisRoot ? path.basename(analysisRoot) : "project");
  }
  return path.basename(inputPath, path.extname(inputPath));
}

module.exports = { prepareInput };
