#!/usr/bin/env node

const { runCli } = require("../src/cli");

runCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
