import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  PIIRemover,
  SingleStrategy,
  LocalRegexBackend,
  DEFAULT_CONFIG,
} from "@pii-remover/core";

import {
  createPluginHooks,
  trackMode,
  __resetTrackedModesForTests,
  type CreatedHooks,
} from "../src/hooks.js";

function silentWarn(): (msg: string) => void {
  return () => {};
}

async function buildRemover(sessionId = "split-test-session") {
  return PIIRemover.init({
    sessionId,
    config: DEFAULT_CONFIG,
    warn: silentWarn(),
    strategy: new SingleStrategy(new LocalRegexBackend()),
  });
}

describe("createPluginHooks — mode split", () => {
  test("mode=full registers both mask and restore hooks", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn(), mode: "full" });

    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(hooks["tool.execute.after"]).toBeDefined();
    expect(hooks["experimental.text.complete"]).toBeDefined();
    expect(hooks["experimental.chat.messages.transform"]).toBeDefined();
    expect(hooks["experimental.chat.system.transform"]).toBeDefined();
    remover.dispose();
  });

  test("mode=mask registers only masking hooks", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn(), mode: "mask" });

    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(hooks["experimental.chat.messages.transform"]).toBeDefined();
    expect(hooks["experimental.chat.system.transform"]).toBeDefined();

    expect(hooks["tool.execute.after"]).toBeUndefined();
    expect(hooks["experimental.text.complete"]).toBeUndefined();
    remover.dispose();
  });

  test("mode=restore registers only restoration hooks", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn(), mode: "restore" });

    expect(hooks["tool.execute.before"]).toBeUndefined();
    expect(hooks["experimental.chat.messages.transform"]).toBeUndefined();
    expect(hooks["experimental.chat.system.transform"]).toBeUndefined();

    expect(hooks["tool.execute.after"]).toBeDefined();
    expect(hooks["experimental.text.complete"]).toBeDefined();
    remover.dispose();
  });

  test("mode=mask masks tool args (experimental:false legacy net)", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, {
      warn: silentWarn(),
      mode: "mask",
      experimental: false,
    });
    const output = { args: { content: "email alice@example.com" } };

    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "s", callID: "c" },
      output
    );

    const args = output.args as { content: string };
    expect(args.content).toContain("{{OPF:EMAIL:");
    remover.dispose();
  });

  test("mode=restore restores tokens from vault", async () => {
    const remover = await buildRemover();

    // First mask to populate the vault
    const maskResult = await remover.mask("email alice@example.com");
    expect(maskResult.text).toContain("{{OPF:EMAIL:");

    // Now restore via hook
    const hooks = createPluginHooks(remover, { warn: silentWarn(), mode: "restore" });
    const output = { title: "", output: maskResult.text, metadata: {} };

    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "split-test-session", callID: "c", args: {} },
      output
    );

    expect(output.output).toBe("email alice@example.com");
    remover.dispose();
  });

  test("shared remover: mask mode vault is readable by restore mode", async () => {
    const remover = await buildRemover();

    const maskHooks = createPluginHooks(remover, {
      warn: silentWarn(),
      mode: "mask",
      experimental: false,
    });
    const restoreHooks = createPluginHooks(remover, { warn: silentWarn(), mode: "restore" });

    const output = { args: { content: "contact bob@corp.io for details" } };
    await maskHooks["tool.execute.before"]!(
      { tool: "write", sessionID: "s", callID: "c" },
      output
    );
    const masked = (output.args as { content: string }).content;
    expect(masked).toContain("{{OPF:EMAIL:");

    const restoreOutput = { title: "", output: masked, metadata: {} };
    await restoreHooks["tool.execute.after"]!(
      { tool: "read", sessionID: "split-test-session", callID: "c", args: {} },
      restoreOutput
    );
    expect(restoreOutput.output).toBe("contact bob@corp.io for details");

    remover.dispose();
  });

  test("mode=mask still restores display-tool args (shared vault read)", async () => {
    const remover = await buildRemover();
    const masked = await remover.mask("contact alice@example.com please");
    expect(masked.text).toContain("{{OPF:EMAIL:");

    const maskHooks = createPluginHooks(remover, { warn: silentWarn(), mode: "mask" });
    const output = { args: { questions: [{ question: masked.text }] } };
    await maskHooks["tool.execute.before"]!(
      { tool: "question", sessionID: "split-test-session", callID: "c" },
      output
    );
    const q = (output.args as { questions: Array<{ question: string }> })
      .questions[0];
    expect(q?.question).toContain("alice@example.com");
    expect(q?.question).not.toContain("{{OPF:EMAIL:");
    remover.dispose();
  });
});

describe("trackMode — order warnings", () => {
  beforeEach(() => {
    __resetTrackedModesForTests();
  });

  test("mask before restore emits no warning", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    trackMode("mask", warn);
    trackMode("restore", warn);
    expect(warnings).toHaveLength(0);
  });

  test("restore loaded before mask emits warning", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    trackMode("restore", warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("restore plugin loaded before mask");
  });

  test("mask loaded after restore emits warning", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    trackMode("restore", warn);
    warnings.length = 0;
    trackMode("mask", warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mask plugin loaded after restore");
  });

  test("mode=full is not tracked and emits no warning", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    trackMode("full", warn);
    trackMode("full", warn);
    expect(warnings).toHaveLength(0);
  });
});
