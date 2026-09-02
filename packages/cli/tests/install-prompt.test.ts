import { describe, expect, test } from "bun:test";
import checkbox from "@inquirer/checkbox";
import { render } from "@inquirer/testing";

import { INSTALL_TARGET_ORDER } from "../src/commands/install-command.js";
import {
  targetsPromptConfig,
  type CheckboxChoice,
} from "../src/commands/install-prompt.js";
import type { InstallTarget } from "../src/commands/install.js";

const PROMPT_TIMEOUT_MS = 5_000;

const OFFERED: readonly CheckboxChoice<InstallTarget>[] =
  INSTALL_TARGET_ORDER.map((value) => ({
    value,
    name: `install ${value}`,
    checked: false,
  }));

function renderTargetsPrompt() {
  return render(checkbox<InstallTarget>, targetsPromptConfig(OFFERED));
}

describe("promptForTargets checkbox", () => {
  test(
    "submitting with no host checked resolves to an empty selection",
    async () => {
      const { answer, events } = await renderTargetsPrompt();

      events.keypress("enter");

      await expect(answer).resolves.toEqual([]);
    },
    PROMPT_TIMEOUT_MS
  );

  test(
    "checking the first host before submitting resolves to that host",
    async () => {
      const { answer, events, nextRender } = await renderTargetsPrompt();

      events.keypress("space");
      await nextRender();
      events.keypress("enter");

      await expect(answer).resolves.toEqual([INSTALL_TARGET_ORDER[0]]);
    },
    PROMPT_TIMEOUT_MS
  );
});
