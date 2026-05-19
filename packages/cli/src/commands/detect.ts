import { PIIRemover, type PIIRemoverInitOptions } from "@pii-remover/core";

export interface DetectCommandIo {
  text: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  initPiiRemover?: (opts: PIIRemoverInitOptions) => Promise<PIIRemover>;
}

export interface DetectCommandResult {
  exitCode: 0 | 2;
  detections: number;
}

export async function runDetectCommand(
  io: DetectCommandIo
): Promise<DetectCommandResult> {
  const env = io.env ?? process.env;
  const initFn =
    io.initPiiRemover ??
    ((opts: PIIRemoverInitOptions) => PIIRemover.init(opts));

  let remover: PIIRemover;
  try {
    remover = await initFn({ env, warn: (m) => io.stderr(`${m}\n`) });
  } catch (err) {
    io.stderr(
      `pii-remover detect: init failed: ${(err as Error).message}\n`
    );
    return { exitCode: 2, detections: 0 };
  }

  try {
    const masked = await remover.mask(io.text);
    io.stdout(
      `${JSON.stringify(
        {
          masked: masked.text,
          tokens: masked.tokens.map((t) => ({
            token: t.token,
            category: t.category,
            start: t.start,
            end: t.end,
            original: t.text,
          })),
          backend: masked.backend_name,
          latency_ms: Math.round(masked.latency_ms * 100) / 100,
          bypassed: masked.bypassed,
        },
        null,
        2
      )}\n`
    );
    remover.dispose();
    return { exitCode: 0, detections: masked.tokens.length };
  } catch (err) {
    try {
      remover.dispose();
    } catch {
      /* best-effort */
    }
    io.stderr(
      `pii-remover detect: detection failed: ${(err as Error).message}\n`
    );
    return { exitCode: 2, detections: 0 };
  }
}
