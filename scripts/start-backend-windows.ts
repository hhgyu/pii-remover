import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultKeyPath, resolveTokenSecret, TOKEN_KEY_ENV_NAME } from "../packages/core/src/redaction/token-hash.js";
import { backendReady, launchBackground, registerAutoStart, removeAutoStart } from "./windows-auto-start.js";

const backend = join(dirname(dirname(fileURLToPath(import.meta.url))), "packages", "backend");

async function run(command: string, args: string[], env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: backend, env, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT") resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function main() {
  let host = "127.0.0.1";
  let port = "8000";
  let pythonVersion = "3.11";
  let skipInstall = false;
  let autoStart = false;
  let removeStartup = false;
  let foreground = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--help") {
      console.log("npm run backend:up:windows -- [--host 127.0.0.1] [--port 8000] [--python-version 3.11] [--skip-install] [--auto-start | --remove-auto-start] [--foreground]");
      console.log("--auto-start: register login startup and start in the background.");
      console.log("--foreground: run in the current terminal, including with --auto-start.");
      console.log("--remove-auto-start: unregister login startup, then exit (running servers stay up).");
      return;
    }
    if (arg === "--skip-install") { skipInstall = true; continue; }
    if (arg === "--auto-start") { autoStart = true; continue; }
    if (arg === "--remove-auto-start") { removeStartup = true; continue; }
    if (arg === "--foreground") { foreground = true; continue; }
    if (!["--host", "--port", "--python-version"].includes(arg!)) throw new Error(`Unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--host") host = value;
    if (arg === "--port") port = value;
    if (arg === "--python-version") pythonVersion = value;
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Port must be 1-65535.");
  if (!/^3\.\d+$/.test(pythonVersion)) throw new Error("Python version must look like 3.11.");
  if (process.platform !== "win32") throw new Error("This launcher is for Windows.");
  if (autoStart && removeStartup) throw new Error("Use only one of --auto-start and --remove-auto-start.");
  const appData = process.env.APPDATA;
  if ((autoStart || removeStartup) && !appData) throw new Error("APPDATA is required for Windows login startup.");
  if (removeStartup) {
    console.log(removeAutoStart(appData!) ? "Windows login auto-start removed." : "Windows login auto-start was not registered.");
    return;
  }

  const python = join(backend, ".venv", "Scripts", "python.exe");
  if (!existsSync(python)) {
    if (skipInstall) throw new Error("Virtual environment missing. Run without --skip-install first.");
    await run("py", [`-${pythonVersion}`, "-m", "venv", join(backend, ".venv")]);
  }
  if (!skipInstall) {
    // Python 3.11 can create venvs with pip 22, whose resolver backtracks heavily.
    await run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
    await run(python, ["-m", "pip", "install", "-r", join(backend, "requirements.txt"), "-r", join(backend, "scripts", "requirements-kner-builder.txt")]);
  }

  const modelEnv = { ...process.env, OPF_DEVICE: "cpu", OPF_VARIANT: "int8" };
  const handoffDir = mkdtempSync(join(tmpdir(), "pii-remover-models-"));
  let koreanModelPath: string;
  try {
    const handoff = join(handoffDir, "model-path.txt");
    console.log("Preparing and verifying OPF + Korean NER models before starting the server...");
    await run(python, [join(backend, "scripts", "prepare_windows_models.py"), handoff], modelEnv);
    koreanModelPath = readFileSync(handoff, "utf8").trim();
  } finally {
    rmSync(handoffDir, { recursive: true, force: true });
  }

  // Preserve a previous Docker key when the host has no configured key yet.
  const keyPath = defaultKeyPath();
  const envPath = join(backend, ".env");
  if (!process.env[TOKEN_KEY_ENV_NAME] && !existsSync(keyPath) && existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*PII_REMOVER_TOKEN_KEY\s*=(.*)$/);
      if (!match) continue;
      let value = match[1]!.trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!value) continue;
      mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
      writeFileSync(keyPath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
      break;
    }
  }
  const key = resolveTokenSecret();
  if (key.source === "ephemeral") throw new Error("Cannot persist token key. Set PII_REMOVER_TOKEN_KEY or fix permissions on the host key file.");
  console.log(`Token key source: ${key.source} (value hidden).`);
  if (autoStart) {
    // Shell-only environment variables disappear at login. Require the same
    // persistent host key so the startup process and host hooks agree.
    if (key.source === "env") {
      if (existsSync(keyPath) && readFileSync(keyPath, "utf8").trim() !== key.secret) {
        throw new Error("Environment token key differs from the persistent host key. Align PII_REMOVER_TOKEN_KEY and the host key file before registering auto-start.");
      }
      if (!existsSync(keyPath)) {
        mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
        writeFileSync(keyPath, key.secret, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
    }
    const startup = registerAutoStart({ appData: appData!, backend, bun: process.execPath, script: fileURLToPath(import.meta.url), host, port });
    console.log(`Windows login auto-start registered for http://${host}:${port}.`);
    console.log(`Log: ${startup.log}`);
    if (!foreground) {
      const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
      const healthUrl = `http://${probeHost}:${port}/health`;
      if (await backendReady(healthUrl)) {
        console.log("Backend is already running and ready; no additional process started.");
        return;
      }
      await launchBackground(startup.runner);
      console.log("Waiting for the background server to become ready...");
      const deadline = Date.now() + 120_000;
      let nextUpdate = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await backendReady(healthUrl)) {
          console.log(`Background server ready at http://${host}:${port}. You can close this terminal.`);
          return;
        }
        if (Date.now() >= nextUpdate) { console.log(`Still waiting; see ${startup.log}`); nextUpdate += 30_000; }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(`Background server did not become ready within 120 seconds. See ${startup.log}`);
    }
    console.log("Running in the foreground now; future logins will start it in the background.");
  }
  console.log(`Starting CPU detection + proxy at http://${host}:${port}. Ctrl+C to stop.`);
  console.log("First use downloads model weights. Check /health for model_loaded: true.");
  await run(python, ["-m", "uvicorn", "server.main:app", "--host", host, "--port", port], {
    ...process.env,
    [TOKEN_KEY_ENV_NAME]: key.secret,
    OPF_DEVICE: "cpu",
    OPF_VARIANT: "int8",
    PII_PROXY_ENABLED: "1",
    KNER_ONNX_PATH: koreanModelPath,
    KNER_PRELOAD: "1",
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
