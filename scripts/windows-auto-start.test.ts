import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backendReady, backgroundLaunchCommand, registerAutoStart, removeAutoStart, startupEntryPath, startupRunner } from "./windows-auto-start.js";

describe("Windows login startup", () => {
  test("background launch hides the window and preserves Unicode and apostrophes", () => {
    const command = backgroundLaunchCommand("D:\\한글 & Bob's repo\\startup.ps1");
    expect(command).toContain("-WindowStyle Hidden");
    const encoded = command.match(/'-EncodedCommand','([^']+)'/)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("& 'D:\\한글 & Bob''s repo\\startup.ps1'");
  });

  test("health readiness waits for model loading and rejects HTTP errors", async () => {
    let state = 0;
    const server = Bun.serve({ port: 0, fetch: () => state === 2 ? new Response("error", { status: 500 }) : Response.json({ ok: true, model_loaded: state === 1 }) });
    try {
      const url = `http://127.0.0.1:${server.port}/health`;
      expect(await backendReady(url)).toBe(false);
      state = 1;
      expect(await backendReady(url)).toBe(true);
      state = 2;
      expect(await backendReady(url)).toBe(false);
    } finally { server.stop(true); }
  });
  test("registers into an existing Startup folder junction", () => {
    const root = mkdtempSync(join(tmpdir(), "pii-startup-junction-"));
    try {
      const appData = join(root, "AppData");
      const directory = dirname(startupEntryPath(appData));
      const target = join(root, "startup-target");
      mkdirSync(target);
      mkdirSync(dirname(directory), { recursive: true });
      symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir");
      const result = registerAutoStart({ appData, backend: join(root, "backend"), bun: "C:\\bun.exe", script: "D:\\start.ts", host: "127.0.0.1", port: "8000" });
      expect(existsSync(result.entry)).toBe(true);
      expect(removeAutoStart(appData)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("quotes paths and argument values as PowerShell literals", () => {
    const script = startupRunner({ bun: "C:\\Tools\\Bun's folder\\bun.exe", script: "D:\\한글 & repo\\start.ts", host: "127.0.0.1", port: "8000", log: "D:\\repo\\startup.log" });
    expect(script).toContain("'C:\\Tools\\Bun''s folder\\bun.exe'");
    expect(script).toContain("'\"D:\\한글 & repo\\start.ts\"'");
    expect(script).toContain("'\"--skip-install\"', '\"--host\"', '\"127.0.0.1\"', '\"--port\"', '\"8000\"'");
    expect(script).toContain("-RedirectStandardOutput 'D:\\repo\\startup.log'");
    expect(script).toContain("-RedirectStandardError 'D:\\repo\\startup.log.error.log'");
  });

  test("registration updates one entry; removal is idempotent and preserves logs", () => {
    const root = mkdtempSync(join(tmpdir(), "pii-startup-test-"));
    try {
      const options = { appData: join(root, "AppData"), backend: join(root, "한글 & backend"), bun: "C:\\bun.exe", script: "D:\\start.ts", host: "127.0.0.1", port: "8000" };
      const first = registerAutoStart(options);
      expect(first.entry).toBe(startupEntryPath(options.appData));
      const vbs = readFileSync(first.entry, "utf16le");
      expect(vbs.startsWith("\uFEFF")).toBe(true);
      expect(vbs).toContain("-WindowStyle Hidden");
      expect(vbs).toContain('", 0, False');
      const second = registerAutoStart({ ...options, port: "8001" });
      expect(second.entry).toBe(first.entry);
      const runner = join(options.backend, ".cache", "windows-startup.ps1");
      expect(readFileSync(runner, "utf8")).toContain("'\"--port\"', '\"8001\"'");
      expect(removeAutoStart(options.appData)).toBe(true);
      expect(existsSync(first.entry)).toBe(false);
      expect(existsSync(runner)).toBe(true);
      expect(removeAutoStart(options.appData)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
