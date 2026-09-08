/**
 * Ownership test for `UserPromptSubmit` hook commands (Claude Code + Codex).
 *
 * The installers used to recognise a previous install by exact command-string
 * equality, so a re-install from a different runner or path — npx → compiled
 * binary, a bumped npm global version directory, `bun` instead of `node` —
 * looked like a *foreign* hook and got a second entry appended. The host then
 * runs pii-remover twice per prompt and reports every block twice.
 *
 * Matching on ownership instead lets the installer REPLACE the stale entry.
 * Ownership is deliberately narrow: the command must end with the `hook`
 * subcommand AND name a pii-remover binary, package, or install directory. A
 * foreign hook satisfying both is, for practical purposes, ours anyway.
 */

/** `pii-remover` (optionally with a script/executable extension) as the leaf. */
const OWNED_BINARY = /(?:^|[/\\])pii-remover(?:\.(?:js|mjs|cjs|ts|exe|cmd|bat))?$/i;

/** An npm spec under our scope, with or without a version suffix. */
const OWNED_PACKAGE = /^@pii-remover\/[a-z0-9-]+(?:@[^\s]+)?$/i;

/** Any path routed through a `pii-remover` / `@pii-remover` directory. */
const OWNED_PATH_SEGMENT = /(?:^|[/\\])@?pii-remover[/\\]/i;

const HOOK_SUBCOMMAND = "hook";

/**
 * Canonical form used for "is this the exact command we would write?".
 * Collapses whitespace, drops a leading `node `, and unquotes the path that
 * follows it, so `node "/p" hook` and `/p hook` compare equal.
 */
export function normalizeHookCommand(command: string): string {
  let s = command.trim().replace(/\s+/g, " ");
  if (s.toLowerCase().startsWith("node ")) {
    s = s.slice(5).trimStart();
  }
  s = s.replace(/^"([^"]+)"\s/, "$1 ");
  return s;
}

/**
 * Split a shell-ish command into tokens, keeping quoted segments whole and
 * stripping the quotes. Good enough for the command shapes the installers and
 * users actually write; it is only ever used to classify, never to execute.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined && value.length > 0) tokens.push(value);
  }
  return tokens;
}

/**
 * True when this command invokes pii-remover's `hook` subcommand, regardless of
 * which runner, path, or version installed it.
 */
export function isPiiRemoverHookCommand(command: string): boolean {
  const tokens = tokenizeCommand(command);
  const last = tokens[tokens.length - 1];
  if (last !== HOOK_SUBCOMMAND) return false;
  return tokens.some(
    (token) =>
      OWNED_BINARY.test(token) ||
      OWNED_PACKAGE.test(token) ||
      OWNED_PATH_SEGMENT.test(token)
  );
}

/** Same command modulo `node ` prefix and quoting. */
export function isSameHookCommand(a: string, b: string): boolean {
  return normalizeHookCommand(a) === normalizeHookCommand(b);
}
