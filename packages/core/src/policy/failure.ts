export type FailurePolicy = "closed" | "hybrid" | "open";

export class FailClosedError extends Error {
  override name = "FailClosedError";
  readonly backend: string | undefined;
  readonly bypass_env: string;

  constructor(
    message: string,
    options: { backend?: string; cause?: unknown; bypass_env: string }
  ) {
    super(message);
    this.backend = options.backend;
    this.bypass_env = options.bypass_env;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface ApplyPolicyOptions<T> {
  policy: FailurePolicy;
  bypass: boolean;
  bypassEnv: string;
  primary: () => Promise<T>;
  fallback?: () => Promise<T>;
  passthrough: () => T;
  onError?: (err: unknown, mode: FailurePolicy) => void;
  backendName?: string;
}

export async function applyPolicy<T>(opts: ApplyPolicyOptions<T>): Promise<T> {
  if (opts.bypass || opts.policy === "open") {
    return opts.passthrough();
  }
  try {
    return await opts.primary();
  } catch (err) {
    opts.onError?.(err, opts.policy);
    if (opts.policy === "hybrid" && opts.fallback) {
      try {
        return await opts.fallback();
      } catch (fbErr) {
        opts.onError?.(fbErr, "hybrid");
        const failOptions: { backend?: string; cause: unknown; bypass_env: string } = {
          cause: fbErr,
          bypass_env: opts.bypassEnv,
        };
        if (opts.backendName !== undefined) failOptions.backend = opts.backendName;
        throw new FailClosedError(
          "PII Remover: primary detection failed and hybrid regex fallback also failed",
          failOptions
        );
      }
    }
    const failOptions: { backend?: string; cause: unknown; bypass_env: string } = {
      cause: err,
      bypass_env: opts.bypassEnv,
    };
    if (opts.backendName !== undefined) failOptions.backend = opts.backendName;
    throw new FailClosedError(
      `PII Remover: detection failed (policy=${opts.policy})`,
      failOptions
    );
  }
}
