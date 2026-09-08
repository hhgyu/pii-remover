import { describe, expect, test } from "bun:test";

import {
  classifyPluginEntry,
  inspectPluginOrder,
  openCodeConfigPaths,
  pluginArrayFrom,
  warnOnPluginOrder,
} from "../src/plugin-order.js";

const MASK = "file:///n/@pii-remover/opencode-plugin/dist/mask.js";
const RESTORE = "file:///n/@pii-remover/opencode-plugin/dist/restore.js";
const FULL = "file:///n/@pii-remover/opencode-plugin/dist/index.js";

function kinds(plugins: readonly string[]): readonly string[] {
  return inspectPluginOrder(plugins).map((i) => i.kind);
}

describe("classifyPluginEntry", () => {
  test("recognises split entries as file URLs and as subpath specs", () => {
    expect(classifyPluginEntry(MASK)).toBe("mask");
    expect(classifyPluginEntry(RESTORE)).toBe("restore");
    expect(classifyPluginEntry("@pii-remover/opencode-plugin/mask")).toBe("mask");
    expect(classifyPluginEntry("@pii-remover/opencode-plugin/restore")).toBe(
      "restore"
    );
  });

  test("recognises every shape of a full-mode registration", () => {
    expect(classifyPluginEntry("@pii-remover/opencode-plugin")).toBe("full");
    expect(classifyPluginEntry("@pii-remover/opencode-plugin@0.0.5")).toBe("full");
    expect(classifyPluginEntry(FULL)).toBe("full");
    expect(
      classifyPluginEntry("file:///n/@pii-remover/opencode-plugin/src/index.ts")
    ).toBe("full");
  });

  test("a foreign plugin shipping its own dist/index.js stays foreign", () => {
    expect(classifyPluginEntry("file:///n/other-plugin/dist/index.js")).toBe(
      "foreign"
    );
    expect(classifyPluginEntry("file:///n/other-plugin/dist/mask.js")).toBe(
      "foreign"
    );
    expect(classifyPluginEntry("some-plugin@latest")).toBe("foreign");
  });
});

describe("inspectPluginOrder", () => {
  test("the installed layout — mask first, others between, restore last — is clean", () => {
    expect(kinds([MASK, "a@1", "b@1", RESTORE])).toEqual([]);
  });

  test("mask alone at index 0 with nothing after it is clean", () => {
    expect(kinds([MASK])).toEqual([]);
  });

  test("says nothing when neither split entry is registered", () => {
    expect(kinds(["a@1", "b@1"])).toEqual([]);
  });

  test("flags a plugin registered ahead of mask", () => {
    const issues = inspectPluginOrder(["early@1", MASK, RESTORE]);
    expect(issues.map((i) => i.kind)).toEqual(["plugins_before_mask"]);
    expect(issues[0]?.message).toContain("early@1");
    expect(issues[0]?.message).toContain("UNMASKED");
  });

  test("flags a plugin registered behind restore", () => {
    const issues = inspectPluginOrder([MASK, RESTORE, "late@1"]);
    expect(issues.map((i) => i.kind)).toEqual(["plugins_after_restore"]);
    expect(issues[0]?.message).toContain("late@1");
    expect(issues[0]?.message).toContain("RESTORED");
  });

  test("flags an inverted pair and the surrounding drift together", () => {
    expect(kinds([RESTORE, MASK])).toEqual([
      "restore_before_mask",
      "plugins_before_mask",
      "plugins_after_restore",
    ]);
  });

  test("flags a full-mode entry coexisting with the split entries", () => {
    const issues = inspectPluginOrder([MASK, FULL, RESTORE]);
    expect(issues.map((i) => i.kind)).toEqual(["double_registration"]);
    expect(issues[0]?.message).toContain(FULL);
  });

  test("a bare package entry next to the split pair is the same conflict", () => {
    expect(kinds([MASK, "@pii-remover/opencode-plugin", RESTORE])).toEqual([
      "double_registration",
    ]);
  });

  test("only the last restore anchors the tail check", () => {
    expect(kinds([MASK, RESTORE, RESTORE])).toEqual([]);
  });
});

describe("pluginArrayFrom", () => {
  test("returns the string entries of a plugin array", () => {
    expect(pluginArrayFrom('{"plugin":["a","b"]}')).toEqual(["a", "b"]);
  });

  test("drops non-string entries instead of failing", () => {
    expect(pluginArrayFrom('{"plugin":["a",42,null]}')).toEqual(["a"]);
  });

  test("returns null for malformed JSON or a missing plugin array", () => {
    expect(pluginArrayFrom("{oops")).toBeNull();
    expect(pluginArrayFrom('{"plugin":"a"}')).toBeNull();
    expect(pluginArrayFrom("[]")).toBeNull();
  });
});

describe("openCodeConfigPaths", () => {
  test("covers the global config and both project locations", () => {
    const paths = openCodeConfigPaths({ directory: "/repo", homeDir: "/home/u" });
    expect(paths).toHaveLength(3);
    expect(paths.some((p) => p.includes("opencode.json"))).toBe(true);
  });

  test("without a directory only the global config is checked", () => {
    expect(openCodeConfigPaths({ homeDir: "/home/u" })).toHaveLength(1);
  });
});

describe("warnOnPluginOrder", () => {
  function reader(files: Record<string, string>) {
    return async (path: string): Promise<string> => {
      const hit = Object.entries(files).find(([k]) => path.endsWith(k));
      if (hit === undefined) throw new Error(`ENOENT ${path}`);
      return hit[1];
    };
  }

  test("warns once per issue with the offending config path", async () => {
    const warnings: string[] = [];
    const issues = await warnOnPluginOrder({
      directory: "/repo",
      homeDir: "/home/u",
      warn: (m) => warnings.push(m),
      readFileImpl: reader({
        [`${"opencode.json"}`]: JSON.stringify({
          plugin: ["early@1", MASK, RESTORE],
        }),
      }),
    });
    expect(issues.map((i) => i.kind)).toContain("plugins_before_mask");
    expect(warnings.every((w) => w.startsWith("[pii-remover] WARNING:"))).toBe(
      true
    );
  });

  test("an unreadable or clean config produces no warning", async () => {
    const warnings: string[] = [];
    const issues = await warnOnPluginOrder({
      directory: "/repo",
      homeDir: "/home/u",
      warn: (m) => warnings.push(m),
      readFileImpl: reader({
        "opencode.json": JSON.stringify({ plugin: [MASK, "x@1", RESTORE] }),
      }),
    });
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a missing config never throws", async () => {
    const warnings: string[] = [];
    await warnOnPluginOrder({
      directory: "/repo",
      homeDir: "/home/u",
      warn: (m) => warnings.push(m),
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(warnings).toEqual([]);
  });
});
