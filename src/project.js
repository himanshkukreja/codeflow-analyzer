const fs = require("fs");
const path = require("path");
const { Project, ModuleKind, ScriptTarget, ts } = require("ts-morph");
const { routeFromAppPath, routeFromPagesPath, toPosix, walkFiles } = require("./utils");

function detectFramework(rootDir, sourceFiles) {
  if (sourceFiles.length === 0) {
    return "unknown";
  }
  if (
    fs.existsSync(path.join(rootDir, "app")) ||
    sourceFiles.some((file) => file.relPath.startsWith("app/") || file.appRoute)
  ) {
    return "nextjs-app-router";
  }
  if (
    fs.existsSync(path.join(rootDir, "pages")) ||
    sourceFiles.some((file) => file.relPath.startsWith("pages/") || file.pagesRoute)
  ) {
    return "nextjs-pages-router";
  }
  const looksLikeReact = sourceFiles.some((file) =>
    /from\s+['"]react['"]|from\s+['"]react-router-dom['"]|<[A-Z][A-Za-z0-9]*\b|useState\s*\(|useEffect\s*\(|onClick=|onSubmit=|onChange=/.test(file.content)
  );
  return looksLikeReact ? "react" : "unknown";
}

function findTsConfig(rootDir) {
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(rootDir, name));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function createProjectContext(rootDir, outputDir) {
  const filePaths = walkFiles(rootDir);
  const sourceFiles = filePaths.map((filePath) => {
    const relPath = toPosix(path.relative(rootDir, filePath));
    const content = fs.readFileSync(filePath, "utf8");
    const trimmed = content.trimStart();
    return {
      filePath,
      relPath,
      content,
      isClientComponent: trimmed.startsWith('"use client"') || trimmed.startsWith("'use client'"),
      appRoute: routeFromAppPath(relPath),
      pagesRoute: routeFromPagesPath(relPath),
    };
  });

  const framework = detectFramework(rootDir, sourceFiles);
  const tsConfigPath = findTsConfig(rootDir);
  let project;
  if (tsConfigPath) {
    project = new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: false,
      skipFileDependencyResolution: false,
    });
    project.addSourceFilesAtPaths(filePaths);
  } else {
    project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.Preserve,
        target: ScriptTarget.ESNext,
        module: ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
      },
    });
    project.addSourceFilesAtPaths(filePaths);
  }

  const projectFiles = project.getSourceFiles().filter((sourceFile) => {
    const normalized = path.resolve(sourceFile.getFilePath());
    return normalized.startsWith(path.resolve(rootDir));
  });

  const byRelPath = new Map();
  for (const meta of sourceFiles) {
    byRelPath.set(meta.relPath, meta);
  }

  return {
    rootDir,
    outputDir,
    framework,
    tsConfigPath,
    project,
    sourceFiles,
    projectFiles,
    sourceFileByPath: new Map(projectFiles.map((file) => [toPosix(path.relative(rootDir, file.getFilePath())), file])),
    metaByPath: byRelPath,
  };
}

module.exports = { createProjectContext };
