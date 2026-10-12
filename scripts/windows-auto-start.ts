import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export function backgroundLaunchCommand(runner: string): string {
  const encoded = Buffer.from(`& ${psLiteral(runner)}`, "utf16le").toString("base64");
  return `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`;
}

export async function launchBackground(runner: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", backgroundLaunchCommand(runner)], { windowsHide: true, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Background launch failed (exit ${code}).`)));
  });
}

export async function backendReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const health = await response.json() as { ok?: boolean; model_loaded?: boolean };
    return health.ok === true && health.model_loaded === true;
  } catch { return false; }
}

const startupFilename = "pii-remover-backend.vbs";

export function startupEntryPath(appData: string): string {
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", startupFilename);
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function startupRunner(options: { bun: string; script: string; host: string; port: string; log: string }): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$arguments = @(${[options.script, "--skip-install", "--host", options.host, "--port", options.port].map(value => psLiteral('"' + value.replaceAll('"', '\\"') + '"')).join(", ")})`,
    `$process = Start-Process -FilePath ${psLiteral(options.bun)} -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput ${psLiteral(options.log)} -RedirectStandardError ${psLiteral(options.log + ".error.log")} -Wait -PassThru`,
    "exit $process.ExitCode",
    "",
  ].join("\r\n");
}

export function registerAutoStart(options: { appData: string; backend: string; bun: string; script: string; host: string; port: string }): { entry: string; log: string; runner: string } {
  const cache = join(options.backend, ".cache");
  mkdirSync(cache, { recursive: true });
  const runner = join(cache, "windows-startup.ps1");
  const log = join(cache, "windows-startup.log");
  // UTF-8 BOM lets Windows PowerShell 5.1 read non-ASCII repository paths.
  writeFileSync(runner, "\uFEFF" + startupRunner({ ...options, log }), "utf8");
  const entry = startupEntryPath(options.appData);
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runner}"`;
  const vbs = `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`;
  const startupDirectory = dirname(entry);
  // Bun on Windows can report EEXIST for existing shell-folder junctions.
  // Do not recreate an existing Startup directory.
  if (!existsSync(startupDirectory)) mkdirSync(startupDirectory, { recursive: true });
  if (!statSync(startupDirectory).isDirectory()) throw new Error(`Startup path is not a directory: ${startupDirectory}`);
  // VBScript on Windows uses UTF-16LE with a BOM for Unicode paths.
  writeFileSync(entry, "\uFEFF" + vbs, "utf16le");
  return { entry, log, runner };
}

export function removeAutoStart(appData: string): boolean {
  const entry = startupEntryPath(appData);
  const existed = existsSync(entry);
  rmSync(entry, { force: true });
  return existed;
}
