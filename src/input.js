const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

async function prepareInput(inputArg, options = {}) {
  const requestedOutputDir = options.outputDir ? path.resolve(options.outputDir) : process.cwd();
  const githubRepo = parseGithubRepoUrl(inputArg);

  if (githubRepo) {
    return prepareGithubInput(githubRepo, requestedOutputDir);
  }

  const resolved = path.resolve(inputArg);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Input path does not exist: ${resolved}`);
  }

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
    throw new Error("Input must be a directory, a .zip file, or a public GitHub repository URL");
  }

  return prepareZipInput(resolved, requestedOutputDir);
}

function prepareZipInput(resolvedZipPath, outputDir) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-analyzer-"));
  try {
    const analysisRoot = extractArchiveToTempRoot(fs.readFileSync(resolvedZipPath), tempRoot);
    return {
      inputPath: resolvedZipPath,
      analysisRoot,
      outputDir,
      projectName: inferProjectName(resolvedZipPath, analysisRoot),
      cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function prepareGithubInput(githubRepo, outputDir) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-analyzer-"));
  try {
    const archiveBuffer = await downloadToBuffer(githubRepo.archiveUrl);
    const analysisRoot = extractArchiveToTempRoot(archiveBuffer, tempRoot);
    return {
      inputPath: githubRepo.originalUrl,
      analysisRoot,
      outputDir,
      projectName: githubRepo.repo,
      cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`Failed to fetch GitHub repository: ${githubRepo.originalUrl}\n${error.message}`);
  }
}

function extractArchiveToTempRoot(archiveBuffer, tempRoot) {
  const extractDir = path.join(tempRoot, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  const archive = new AdmZip(archiveBuffer);
  archive.extractAllTo(extractDir, true);

  const topLevel = fs
    .readdirSync(extractDir)
    .map((name) => path.join(extractDir, name))
    .filter((entryPath) => fs.statSync(entryPath).isDirectory());

  return topLevel.length === 1 ? topLevel[0] : extractDir;
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

function parseGithubRepoUrl(inputArg) {
  let parsed;
  try {
    parsed = new URL(inputArg);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;

  const rawSegments = parsed.pathname.split("/").filter(Boolean);
  if (rawSegments.length < 2) return null;

  const owner = rawSegments[0];
  const repo = rawSegments[1].replace(/\.git$/, "");
  if (!owner || !repo) return null;

  if (rawSegments.length === 2) {
    return {
      owner,
      repo,
      ref: "HEAD",
      archiveUrl: `https://github.com/${owner}/${repo}/archive/HEAD.zip`,
      originalUrl: parsed.toString(),
    };
  }

  if (rawSegments[2] === "tree" && rawSegments.length >= 4) {
    const ref = rawSegments.slice(3).join("/");
    return {
      owner,
      repo,
      ref,
      archiveUrl: `https://github.com/${owner}/${repo}/archive/refs/heads/${encodeURIComponent(ref)}.zip`,
      originalUrl: parsed.toString(),
    };
  }

  return null;
}

function downloadToBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects while downloading repository archive"));
      return;
    }

    const client = url.startsWith("https:") ? https : http;
    const request = client.get(
      url,
      {
        headers: {
          "User-Agent": "codeflow-analyzer",
          Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.8",
        },
      },
      (response) => {
        const statusCode = response.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          const location = response.headers.location;
          response.resume();
          if (!location) {
            reject(new Error(`Redirect response missing location header (${statusCode})`));
            return;
          }
          const nextUrl = new URL(location, url).toString();
          resolve(downloadToBuffer(nextUrl, redirectCount + 1));
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Unexpected HTTP status ${statusCode}`));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );

    request.setTimeout(30000, () => {
      request.destroy(new Error("Timed out while downloading repository archive"));
    });

    request.on("error", reject);
  });
}

module.exports = { prepareInput };
