import { describe, expect, test } from "bun:test";

import {
  isPiiRemoverHookCommand,
  isSameHookCommand,
  normalizeHookCommand,
  tokenizeCommand,
} from "../src/commands/hook-ownership.js";

describe("tokenizeCommand", () => {
  test("keeps a quoted path with spaces as one token", () => {
    expect(tokenizeCommand('node "/Program Files/pii-remover.js" hook')).toEqual([
      "node",
      "/Program Files/pii-remover.js",
      "hook",
    ]);
  });
});

describe("normalizeHookCommand", () => {
  test("a node-prefixed quoted command and its bare form compare equal", () => {
    expect(isSameHookCommand('node "/bin/x" hook', "/bin/x hook")).toBe(true);
  });

  test("collapses runs of whitespace", () => {
    expect(normalizeHookCommand("  /bin/x    hook  ")).toBe("/bin/x hook");
  });

  test("different paths do not compare equal", () => {
    expect(isSameHookCommand("/bin/a hook", "/bin/b hook")).toBe(false);
  });
});

describe("isPiiRemoverHookCommand", () => {
  test("recognises every runner and path shape we install", () => {
    for (const command of [
      "/usr/local/bin/pii-remover hook",
      'node "/abs/packages/cli/bin/pii-remover.js" hook',
      'bun "/abs/bin/pii-remover.ts" hook',
      "npx @pii-remover/cli hook",
      "bunx @pii-remover/cli@0.0.5 hook",
      'node "D:\\\\git\\\\pii-remover\\\\packages\\\\cli\\\\bin\\\\pii-remover.js" hook',
      'node "/n/@pii-remover/cli/dist/cli.js" hook',
    ]) {
      expect(isPiiRemoverHookCommand(command)).toBe(true);
    }
  });

  test("does not claim a foreign hook", () => {
    for (const command of [
      "/opt/other-tool/guard.sh hook",
      "npx some-other-cli hook",
      "node /srv/app/main.js hook",
    ]) {
      expect(isPiiRemoverHookCommand(command)).toBe(false);
    }
  });

  test("a pii-remover invocation that is not the hook subcommand is not claimed", () => {
    expect(isPiiRemoverHookCommand("/usr/local/bin/pii-remover health")).toBe(
      false
    );
    expect(isPiiRemoverHookCommand("/usr/local/bin/pii-remover")).toBe(false);
  });

  test("an empty or whitespace command is not claimed", () => {
    expect(isPiiRemoverHookCommand("")).toBe(false);
    expect(isPiiRemoverHookCommand("   ")).toBe(false);
  });
});
