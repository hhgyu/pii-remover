/**
 * Manual verification script for split-mode POC.
 *
 * Run: bun run examples/verify-split-mode.ts
 *
 * What this verifies:
 * 1. Two glue files produce separate hook sets (mask-only / restore-only)
 * 2. Both share the same PIIRemover instance (module singleton)
 * 3. Mask hooks populate the vault, restore hooks read from it
 * 4. Full round-trip: mask → (simulated other-plugin passthrough) → restore
 *
 * This does NOT start OpenCode — it simulates the two-plugin loading pattern
 * to verify the architectural assumptions before real-world testing.
 */
import { configurePiiRemoverPlugin } from "../packages/opencode-plugin/src/hooks.js";

async function main() {
  console.log("=== Split-Mode POC Verification ===\n");

  const fakeCtx = {
    project: { id: "verify-test" },
    directory: "/tmp/test",
    worktree: "main",
  };

  console.log("[1] Loading mask plugin...");
  const maskPlugin = configurePiiRemoverPlugin({ mode: "mask" });
  const maskHooks = await maskPlugin(fakeCtx);

  console.log("[2] Loading restore plugin...");
  const restorePlugin = configurePiiRemoverPlugin({ mode: "restore" });
  const restoreHooks = await restorePlugin(fakeCtx);

  console.log("\n--- Hook Registration ---");
  console.log(`mask   → tool.execute.before: ${maskHooks["tool.execute.before"] ? "YES" : "NO"}`);
  console.log(`mask   → tool.execute.after:  ${maskHooks["tool.execute.after"] ? "YES" : "NO"}`);
  console.log(`mask   → exp.text.complete:   ${maskHooks["experimental.text.complete"] ? "YES" : "NO"}`);
  console.log(`restore → tool.execute.before: ${restoreHooks["tool.execute.before"] ? "YES" : "NO"}`);
  console.log(`restore → tool.execute.after:  ${restoreHooks["tool.execute.after"] ? "YES" : "NO"}`);
  console.log(`restore → exp.text.complete:   ${restoreHooks["experimental.text.complete"] ? "YES" : "NO"}`);

  console.log("\n--- Mask Round-Trip ---");
  const piiText = "Contact alice@example.com or call 010-1234-5678";
  const toolArgs = { args: { content: piiText } };

  console.log(`[3] Original: ${piiText}`);
  await maskHooks["tool.execute.before"]!(
    { tool: "write", sessionID: "s", callID: "c1" },
    toolArgs
  );
  const masked = (toolArgs.args as { content: string }).content;
  console.log(`[4] Masked:   ${masked}`);

  const result = { title: "", output: masked, metadata: {} };
  await restoreHooks["tool.execute.after"]!(
    { tool: "read", sessionID: "s", callID: "c1", args: {} },
    result
  );
  console.log(`[5] Restored: ${result.output}`);

  const maskOk = masked !== piiText && masked.includes("__OPF_");
  const restoreOk = result.output === piiText;
  const hookSplitOk =
    maskHooks["tool.execute.before"] !== undefined &&
    maskHooks["tool.execute.after"] === undefined &&
    restoreHooks["tool.execute.before"] === undefined &&
    restoreHooks["tool.execute.after"] !== undefined;

  console.log("\n=== Results ===");
  console.log(`Hook split (mask-only / restore-only): ${hookSplitOk ? "PASS" : "FAIL"}`);
  console.log(`Masking works:                         ${maskOk ? "PASS" : "FAIL"}`);
  console.log(`Restoration works (vault shared):      ${restoreOk ? "PASS" : "FAIL"}`);

  if (!hookSplitOk || !maskOk || !restoreOk) {
    console.log("\n❌ VERIFICATION FAILED");
    process.exit(1);
  }
  console.log("\n✅ All checks passed — ready for OpenCode integration test");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
