#!/usr/bin/env bun
import { runCli } from "../src/cli.js";

const argv = process.argv.slice(2);
const exit = await runCli(argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  argv0: process.argv[1] ?? "pii-remover",
});
process.exit(exit);
