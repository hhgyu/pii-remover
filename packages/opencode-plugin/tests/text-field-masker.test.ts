import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SKIP_FIELDS,
  MIN_MASK_LENGTH,
  maskTextFields,
  maskTextFieldsStrict,
  restoreTextFields,
} from "../src/text-field-masker.js";

function brackets(text: string): string {
  return `<<${text}>>`;
}

function appendStar(text: string): string {
  return `${text}*`;
}

describe("maskTextFields — basic walk", () => {
  test("masks top-level string args (length > threshold)", async () => {
    const result = await maskTextFields(
      "contact user@example.com please",
      brackets
    );
    expect(result).toBe("<<contact user@example.com please>>");
  });

  test("returns short strings unchanged", async () => {
    const result = await maskTextFields("short", brackets);
    expect(result).toBe("short");
  });

  test("returns non-string scalars unchanged", async () => {
    expect(await maskTextFields(42, brackets)).toBe(42);
    expect(await maskTextFields(null, brackets)).toBe(null);
    expect(await maskTextFields(undefined, brackets)).toBe(undefined);
    expect(await maskTextFields(true, brackets)).toBe(true);
  });

  test("masks string fields inside a plain object", async () => {
    const obj = { message: "contact alice@example.com" };
    const out = (await maskTextFields(obj, brackets)) as typeof obj;
    expect(out.message).toBe("<<contact alice@example.com>>");
    expect(out).toBe(obj);
  });

  test("walks nested objects and arrays", async () => {
    const obj = {
      outer: {
        items: [
          { content: "long enough string A here" },
          { content: "long enough string B here" },
        ],
      },
    };
    const out = (await maskTextFields(obj, appendStar)) as typeof obj;
    expect(out.outer.items[0]!.content).toBe("long enough string A here*");
    expect(out.outer.items[1]!.content).toBe("long enough string B here*");
  });
});

describe("maskTextFields — skip list (path-shaped fields)", () => {
  test("does not mask `file_path`", async () => {
    const obj = { file_path: "/home/john/work/project/file.ts" };
    const out = (await maskTextFields(obj, brackets)) as typeof obj;
    expect(out.file_path).toBe("/home/john/work/project/file.ts");
  });

  test("does not mask `path`, `cwd`, `uri`, `url`", async () => {
    const obj = {
      path: "/some/absolute/path/here.txt",
      cwd: "/home/dev/repo",
      uri: "file:///home/dev/repo/main.go",
      url: "https://example.com/api/v1/resource",
    };
    const out = (await maskTextFields(obj, brackets)) as typeof obj;
    expect(out.path).toBe("/some/absolute/path/here.txt");
    expect(out.cwd).toBe("/home/dev/repo");
    expect(out.uri).toBe("file:///home/dev/repo/main.go");
    expect(out.url).toBe("https://example.com/api/v1/resource");
  });

  test("skips fields ending with `_path` / `_id` / `_dir` heuristically", async () => {
    const obj = {
      session_id: "session-1234-5678",
      project_id: "proj-aaa-bbbbbbb",
      output_path: "/tmp/output/results.json",
      log_dir: "/var/log/myapp/instance",
      avatar_url: "https://cdn.example.com/avatar/abc.png",
    };
    const before = { ...obj };
    const out = (await maskTextFields(obj, brackets)) as typeof obj;
    expect(out.session_id).toBe(before.session_id);
    expect(out.project_id).toBe(before.project_id);
    expect(out.output_path).toBe(before.output_path);
    expect(out.log_dir).toBe(before.log_dir);
    expect(out.avatar_url).toBe(before.avatar_url);
  });

  test("masks regular free-form text fields alongside skipped ones", async () => {
    const obj = {
      file_path: "/home/alice/work/repo/main.ts",
      message: "alice@example.com wrote about XYZ",
    };
    const out = (await maskTextFields(obj, brackets)) as typeof obj;
    expect(out.file_path).toBe("/home/alice/work/repo/main.ts");
    expect(out.message).toBe("<<alice@example.com wrote about XYZ>>");
  });
});

describe("maskTextFields — length threshold", () => {
  test(`strings with trimmed length <= ${MIN_MASK_LENGTH} are skipped`, async () => {
    const obj = {
      tiny: "abc",
      eightCh: "12345678",
      nineCh: "123456789",
    };
    const out = (await maskTextFields(obj, brackets)) as typeof obj;
    expect(out.tiny).toBe("abc");
    expect(out.eightCh).toBe("12345678");
    expect(out.nineCh).toBe("<<123456789>>");
  });

  test("custom minLength is honoured", async () => {
    const obj = { short: "abcdefgh" };
    const out = (await maskTextFields(obj, brackets, { minLength: 4 })) as typeof obj;
    expect(out.short).toBe("<<abcdefgh>>");
  });
});

describe("maskTextFields — cycle / non-plain-object safety", () => {
  test("survives a cyclic object graph", async () => {
    interface Node {
      kind: string;
      text: string;
      self?: Node;
    }
    const node: Node = { kind: "long_kind_name_here", text: "alice@example.com long" };
    node.self = node;
    const out = (await maskTextFields(node, brackets)) as Node;
    expect(out.text).toBe("<<alice@example.com long>>");
    expect(out.self).toBe(out);
  });

  test("never mutates strings inside Date / Map instances", async () => {
    const map = new Map([["k", "alice@example.com long string here"]]);
    const out = await maskTextFields(map, brackets);
    expect(out).toBe(map);
    expect(map.get("k")).toBe("alice@example.com long string here");
  });
});

describe("maskTextFields — skip-list overrides", () => {
  test("custom skipFields add to defaults (heuristic still applies)", async () => {
    const obj = {
      file_path: "/home/john/work/longfile.ts",
      custom_secret: "alice@example.com long",
      content: "alice@example.com long content here",
    };
    const skip: ReadonlySet<string> = new Set(["custom_secret"]);
    const out = (await maskTextFields(obj, brackets, { skipFields: skip })) as typeof obj;
    expect(out.custom_secret).toBe("alice@example.com long");
    expect(out.file_path).toBe("/home/john/work/longfile.ts");
    expect(out.content).toBe("<<alice@example.com long content here>>");
  });
});

describe("DEFAULT_SKIP_FIELDS shape", () => {
  test("contains the canonical path-shaped keys", () => {
    for (const k of ["file_path", "path", "cwd", "uri", "url"]) {
      expect(DEFAULT_SKIP_FIELDS.has(k)).toBe(true);
    }
  });
});

describe("restoreTextFields — restore walker", () => {
  function unwrap(text: string): string {
    return text.replace(/__OPF_(?:[A-Z_]+)_(\d+)__/g, "[restored-$1]");
  }

  test("restores tokens in nested args, mutating in place", async () => {
    const args = {
      questions: [
        {
          question: "User __OPF_PERSON_1__ asked about __OPF_EMAIL_1__",
          options: [
            { label: "Yes", description: "Confirm __OPF_PERSON_1__" },
          ],
        },
      ],
    };
    const out = (await restoreTextFields(args, unwrap)) as typeof args;
    expect(out.questions[0]!.question).toBe(
      "User [restored-1] asked about [restored-1]"
    );
    expect(out.questions[0]!.options[0]!.description).toBe(
      "Confirm [restored-1]"
    );
    expect(out).toBe(args);
  });

  test("does not apply length threshold (short token strings restored)", async () => {
    const args = { short: "__OPF_X_1__" };
    const out = (await restoreTextFields(args, unwrap)) as typeof args;
    expect(out.short).toBe("[restored-1]");
  });

  test("skips path-shaped fields (same default skip list as mask)", async () => {
    const args = {
      file_path: "/tmp/file__OPF_PERSON_1__.txt",
      content: "Body __OPF_PERSON_1__ here",
    };
    const out = (await restoreTextFields(args, unwrap)) as typeof args;
    expect(out.file_path).toBe("/tmp/file__OPF_PERSON_1__.txt");
    expect(out.content).toBe("Body [restored-1] here");
  });

  test("returns args unchanged for null/undefined", async () => {
    expect(await restoreTextFields(null, unwrap)).toBeNull();
    expect(await restoreTextFields(undefined, unwrap)).toBeUndefined();
  });

  test("tolerates cycles", async () => {
    interface Node {
      text: string;
      self?: Node;
    }
    const node: Node = { text: "Hello __OPF_PERSON_1__" };
    node.self = node;
    const out = (await restoreTextFields(node, unwrap)) as Node;
    expect(out.text).toBe("Hello [restored-1]");
    expect(out.self).toBe(out);
  });
});

describe("maskTextFieldsStrict — boundary fail-closed masker", () => {
  function brackets(text: string): string {
    return `<<${text}>>`;
  }

  test("masks short strings (no min-length threshold)", async () => {
    const args = { short: "abc" };
    const out = (await maskTextFieldsStrict(args, brackets)) as typeof args;
    expect(out.short).toBe("<<abc>>");
  });

  test("masks path-named fields (no path-shape skip list)", async () => {
    const args = {
      file_path: "/some/path/here",
      avatar_url: "https://x.example/avatar.png",
      content: "free form text",
    };
    const out = (await maskTextFieldsStrict(args, brackets)) as typeof args;
    expect(out.file_path).toBe("<</some/path/here>>");
    expect(out.avatar_url).toBe("<<https://x.example/avatar.png>>");
    expect(out.content).toBe("<<free form text>>");
  });

  test("preserves structural identifier fields (type/id/callID/etc.)", async () => {
    const args = {
      type: "tool",
      id: "abc123",
      callID: "call_x",
      tool: "my-tool",
      sessionID: "sess1",
      messageID: "msg1",
      partID: "part1",
      content: "actual content here",
    };
    const out = (await maskTextFieldsStrict(args, brackets)) as typeof args;
    expect(out.type).toBe("tool");
    expect(out.id).toBe("abc123");
    expect(out.callID).toBe("call_x");
    expect(out.tool).toBe("my-tool");
    expect(out.sessionID).toBe("sess1");
    expect(out.messageID).toBe("msg1");
    expect(out.partID).toBe("part1");
    expect(out.content).toBe("<<actual content here>>");
  });

  test("recursively masks nested objects", async () => {
    const args = {
      nested: {
        inner: {
          secret: "x",
          info: "longer string",
        },
      },
    };
    const out = (await maskTextFieldsStrict(args, brackets)) as typeof args;
    expect(out.nested.inner.secret).toBe("<<x>>");
    expect(out.nested.inner.info).toBe("<<longer string>>");
  });
});
