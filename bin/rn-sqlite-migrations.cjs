#!/usr/bin/env node

const path = require("node:path");
const { runCli } = require("../dist/cli.js");

const exitCode = runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  io: {
    stderr(message) {
      process.stderr.write(message);
    },
    stdout(message) {
      process.stdout.write(message);
    },
  },
  templatesDirectory: path.resolve(__dirname, "..", "templates"),
});

process.exitCode = exitCode;
