#!/usr/bin/env bun
import { loadConfig } from "@pii-remover/core";

import { parseFlags, runCli } from "../src/cli.js";
import { startProxy } from "../src/server.js";

const argv = process.argv.slice(2);

if (argv[0] === "start") {
  const flags = parseFlags(argv.slice(1));
  const loadOpts: { configPath?: string } = {};
  if (flags.configPath) loadOpts.configPath = flags.configPath;
  const config = await loadConfig(loadOpts);
  const startOpts: Parameters<typeof startProxy>[0] = { config };
  if (flags.port !== undefined) startOpts.port = flags.port;
  if (flags.host !== undefined) startOpts.host = flags.host;

  const proxy = await startProxy(startOpts);
  process.stdout.write(`pii-remover-proxy listening on ${proxy.url}\n`);

  const shutdown = async () => {
    await proxy.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await new Promise(() => {});
}

const exit = await runCli(argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
process.exit(exit);
