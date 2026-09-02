import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

import checkbox from "@inquirer/checkbox";
import { DEFAULT_CONFIG, type PIICategory } from "@pii-remover/core";

import {
  ALL_CATEGORIES,
  CATEGORY_LABELS,
  loadExistingConfig,
  type InstallFs,
  type InstallTarget,
  type PiiRemoverConfigSlice,
} from "./install.js";

export interface CheckboxChoice<T> {
  readonly value: T;
  readonly name: string;
  readonly checked: boolean;
}

export type SelectTargetsFn = (
  choices: readonly CheckboxChoice<InstallTarget>[]
) => Promise<readonly InstallTarget[]>;

export type SelectCategoriesFn = (
  choices: readonly CheckboxChoice<PIICategory>[]
) => Promise<readonly PIICategory[]>;

export interface PromptIo {
  stdout: (s: string) => void;
  prompt?: (question: string) => Promise<string>;
  installFs?: InstallFs;
  selectTargets?: SelectTargetsFn;
  selectCategories?: SelectCategoriesFn;
}

export interface PiiConfigFlags {
  endpoint?: string;
  categories?: string[];
  autoStart?: boolean;
  composeFile?: string;
  startTimeoutMs?: number;
}

export interface TargetsPromptConfig {
  readonly message: string;
  readonly choices: readonly CheckboxChoice<InstallTarget>[];
}

/**
 * Exported separately from the prompt because `@inquirer/testing`'s
 * `render(prompt, config)` takes the two apart; inlining this back makes the
 * real checkbox undrivable from a test.
 */
export function targetsPromptConfig(
  choices: readonly CheckboxChoice<InstallTarget>[]
): TargetsPromptConfig {
  return {
    message: "Select the hosts to install PII Remover into:",
    choices: toInquirerChoices(choices),
  };
}

export const promptForTargets: SelectTargetsFn = (choices) =>
  checkbox<InstallTarget>(targetsPromptConfig(choices));

export const promptForCategories: SelectCategoriesFn = (choices) =>
  checkbox<PIICategory>({
    message: "Select PII categories to detect:",
    choices: toInquirerChoices(choices),
  });

function toInquirerChoices<T>(
  choices: readonly CheckboxChoice<T>[]
): { name: string; value: T; checked: boolean }[] {
  return choices.map((c) => ({
    name: c.name,
    value: c.value,
    checked: c.checked,
  }));
}

export async function resolvePiiConfig(
  flags: PiiConfigFlags,
  io: PromptIo
): Promise<PiiRemoverConfigSlice> {
  const piiConfig = await baselinePiiConfig(flags, io);
  if (flags.autoStart !== undefined) piiConfig.auto_start = flags.autoStart;
  if (flags.composeFile !== undefined) piiConfig.compose_file = flags.composeFile;
  if (flags.startTimeoutMs !== undefined) {
    piiConfig.start_timeout_ms = flags.startTimeoutMs;
  }
  return piiConfig;
}

async function baselinePiiConfig(
  flags: PiiConfigFlags,
  io: PromptIo
): Promise<PiiRemoverConfigSlice> {
  const scripted =
    (flags.endpoint !== undefined && flags.endpoint !== "") ||
    flags.categories !== undefined ||
    flags.autoStart !== undefined ||
    flags.composeFile !== undefined ||
    flags.startTimeoutMs !== undefined;

  if (scripted) {
    return {
      endpoint: flags.endpoint ?? DEFAULT_CONFIG.backend.endpoint,
      categories: flags.categories?.filter(isPiiCategory) ?? [
        ...DEFAULT_CONFIG.detection.enabled_categories,
      ],
    };
  }

  const promptFn = io.prompt ?? makeReadlinePrompt();
  const existing = await loadExistingConfig(
    process.cwd(),
    homedir(),
    io.installFs ?? CONFIG_LOOKUP_FS
  );
  if (existing === null) {
    io.stdout("\nNo pii-remover.json found. Let's configure it.\n");
    return promptForConfig(io, promptFn);
  }

  io.stdout(
    `\nFound existing config — endpoint: ${existing.endpoint}, ${existing.categories.length} categories enabled.\n`
  );
  const use = await promptFn("Use existing config? [Y/n] ");
  return use.trim().toLowerCase() === "n"
    ? promptForConfig(io, promptFn)
    : existing;
}

const CONFIG_LOOKUP_FS: InstallFs = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFile(p, "utf8"),
  writeFile: async () => {},
  mkdir: async () => {},
};

async function promptForConfig(
  io: PromptIo,
  prompt: (question: string) => Promise<string>
): Promise<PiiRemoverConfigSlice> {
  const defaultEndpoint = DEFAULT_CONFIG.backend.endpoint;
  const endpointInput = await prompt(
    `OPF backend endpoint [${defaultEndpoint}]: `
  );
  const endpoint = endpointInput.trim() || defaultEndpoint;

  const select = io.selectCategories ?? promptForCategories;
  const categories = await select(
    ALL_CATEGORIES.map((value) => ({
      value,
      name: `${CATEGORY_LABELS[value]} (${value})`,
      checked: true,
    }))
  );

  io.stdout(
    `\nConfig: endpoint=${endpoint}, ${categories.length}/${ALL_CATEGORIES.length} categories enabled.\n`
  );
  return { endpoint, categories: [...categories] };
}

function isPiiCategory(value: string): value is PIICategory {
  return ALL_CATEGORIES.some((known) => known === value);
}

function makeReadlinePrompt(): (question: string) => Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return (question: string) =>
    new Promise((resolveAnswer) =>
      rl.question(question, (answer) => {
        rl.close();
        resolveAnswer(answer);
      })
    );
}
