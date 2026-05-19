#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
const VERSION = rootPkg.version;
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(VERSION)) {
  console.error(`sync-versions: root package.json has invalid version '${VERSION}'`);
  process.exit(1);
}

const NPM_PACKAGES = [
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/mcp-server/package.json",
  "packages/proxy/package.json",
  "packages/opencode-plugin/package.json",
  "packages/vision/package.json",
  "packages/shared-types/package.json",
];

const TOML_FILES = [
  "packages/backend/pyproject.toml",
];

const PYTHON_FILES = [
  "packages/backend/server/__init__.py",
];

const SOURCE_FILES = [
  {
    path: "packages/mcp-server/src/server.ts",
    pattern: /const DEFAULT_VERSION = "[^"]*";/,
    replace: () => `const DEFAULT_VERSION = "${VERSION}";`,
  },
  {
    path: "packages/mcp-server/src/cli.ts",
    pattern: /pii-remover-mcp [^\\\n"`]+\\n/,
    replace: () => `pii-remover-mcp ${VERSION}\\n`,
  },
  {
    path: "packages/proxy/src/server.ts",
    pattern: /const VERSION = "[^"]*";/,
    replace: () => `const VERSION = "${VERSION}";`,
  },
  {
    path: "packages/proxy/src/cli.ts",
    pattern: /const VERSION = "[^"]*";/,
    replace: () => `const VERSION = "${VERSION}";`,
  },
  {
    path: "packages/cli/src/constants.ts",
    pattern: /export const PACKAGE_VERSION = "[^"]*";/,
    replace: () => `export const PACKAGE_VERSION = "${VERSION}";`,
  },
];

const TEST_FILES = [
  {
    path: "packages/proxy/tests/cli.test.ts",
    pattern: /\{ ok: true, version: "[^"]*" \}/g,
    replace: () => `{ ok: true, version: "${VERSION}" }`,
  },
  {
    path: "packages/cli/tests/health.test.ts",
    pattern: /\{ ok: true, version: "[^"]*" \}/g,
    replace: () => `{ ok: true, version: "${VERSION}" }`,
  },
];

const README_FILES = [
  {
    path: "packages/backend/README.md",
    patterns: [
      /\{"ok":true,"version":"[^"]*"/g,
      /"version": "[^"]*"/g,
    ],
    replacements: [
      () => `{"ok":true,"version":"${VERSION}"`,
      () => `"version": "${VERSION}"`,
    ],
  },
];

let touched = 0;
const skipped = [];

function rewrite(path, transform) {
  const abs = resolve(ROOT, path);
  let content;
  try {
    content = readFileSync(abs, "utf-8");
  } catch (err) {
    skipped.push(`${path} (read error: ${err.code ?? err.message})`);
    return;
  }
  const next = transform(content);
  if (next === content) {
    skipped.push(`${path} (already at ${VERSION})`);
    return;
  }
  writeFileSync(abs, next);
  touched += 1;
  console.log(`  ${path}`);
}

console.log(`sync-versions → ${VERSION}`);

for (const path of NPM_PACKAGES) {
  rewrite(path, (content) => {
    const pkg = JSON.parse(content);
    if (pkg.version === VERSION) return content;
    pkg.version = VERSION;
    const trailingNewline = content.endsWith("\n") ? "\n" : "";
    return JSON.stringify(pkg, null, 2) + trailingNewline;
  });
}

for (const path of TOML_FILES) {
  rewrite(path, (content) =>
    content.replace(/^version = "[^"]+"/m, `version = "${VERSION}"`),
  );
}

for (const path of PYTHON_FILES) {
  rewrite(path, (content) =>
    content.replace(/__version__ = "[^"]+"/, `__version__ = "${VERSION}"`),
  );
}

for (const entry of SOURCE_FILES) {
  rewrite(entry.path, (content) => content.replace(entry.pattern, entry.replace()));
}

for (const entry of TEST_FILES) {
  rewrite(entry.path, (content) => content.replace(entry.pattern, entry.replace()));
}

for (const entry of README_FILES) {
  rewrite(entry.path, (content) => {
    let next = content;
    for (let i = 0; i < entry.patterns.length; i += 1) {
      next = next.replace(entry.patterns[i], entry.replacements[i]());
    }
    return next;
  });
}

console.log(`\n${touched} file(s) updated; ${skipped.length} skipped (already in sync).`);
if (process.argv.includes("--verbose")) {
  for (const s of skipped) console.log(`  - ${s}`);
}
