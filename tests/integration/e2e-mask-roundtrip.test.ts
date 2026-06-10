import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_CONFIG,
  LocalRegexBackend,
  MergeStrategy,
  OpfHttpBackend,
  PIIRemover,
  SingleStrategy,
  type PiiRemoverConfig,
} from "@pii-remover/core";

import { createPluginHooks } from "@pii-remover/opencode-plugin";

interface CorpusPiiEntry {
  text: string;
  category: string;
  needle: string;
}

interface CorpusNonPiiEntry {
  text: string;
  reason: string;
}

interface Corpus {
  pii: CorpusPiiEntry[];
  non_pii: CorpusNonPiiEntry[];
}

interface KoreanNameEntry {
  name: string;
  surname_type: "single" | "compound";
}

interface KoreanStopwordEntry {
  text: string;
  reason: string;
}

interface KoreanCorpus {
  should_detect: KoreanNameEntry[];
  should_not_detect: KoreanStopwordEntry[];
}

interface CorpusNonPiiEntry {
  text: string;
  reason: string;
}

interface Corpus {
  pii: CorpusPiiEntry[];
  non_pii: CorpusNonPiiEntry[];
}

interface MockServer {
  url: string;
  close(): Promise<void>;
}

interface MockOpfDetection {
  start: number;
  end: number;
  category: string;
  confidence?: number;
  text?: string;
}

const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_RX = /\bhttps?:\/\/[^\s<>"'`)]+/g;
const PHONE_RX = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const CARD_RX = /\b(?:\d{4}[- ]?){3}\d{4}\b/g;
const KR_PHONE_RX = /\b0\d{1,2}-\d{3,4}-\d{4}\b/g;
const KR_NAME_RX = /[\uAC00-\uD7A3]{2,4}/g;
const KR_SURNAMES = new Set([
  "김","이","박","최","정","강","조","윤","장","임","한","오","서","신","권","황","안","송","류","전",
  "홍","고","문","양","손","배","백","허","유","남","심","노","하","곽","성","차","주","우","구","민",
  "나","진","지","엄","채","원","천","방","공","현","함","변","염","여","추","도","소","석","선","설",
  "마","길","연","위","표","명","기","반","라","왕","금","옥","육","인","맹","제","모","탁","국",
  "남궁","황보","독고","사공","제갈","선우","동방","서문",
]);
const KR_STOPWORDS = new Set([
  "박물관","박사","박스","김치","김밥","이름","이거","이것","이상","이후","이전","이미","이번","이런","이렇",
  "정말","정보","정리","정도","정의","정책","정상","강남","강원","강의","강화","조각","조건","조금","조회",
  "윤리","장관","장비","장소","장점","장치","임무","임시","임의","한국","한번","한명","한가","오류","오전",
  "오후","서비스","서울","서버","신청","신규","신호","권한","권리","황금","안녕","안전","안정","송신","송출",
  "전화","전달","전체","전국","전략","전문","홍보","고객","고려","고장","문자","문서","문제","양식","양보",
  "손실","손해","배포","배경","배열","백업","허용","유지","유사","유형","남자","남성","심각","심사","노력",
  "노출","하면","하지","하고","하는","하나","하여","하기","곽씨","성명","성능","성별","차이","차량","주소",
  "주민","주요","우리","우선","구성","구현","구체","민감","민원","나라","나중","나이","진행","진입","진단",
  "지원","지금","지정","지역","엄격","채용","채택","원본","원인","원칙","천만","방법","방문","방식","공개",
  "공식","공통","현재","현황","현장","함수","함께","변경","변환","변수","염려","여러","여기","여부","추가",
  "추출","추천","도움","도입","도구","소개","소속","소프","석사","선택","선언","선행","설정","설명","설치",
  "마감","마지","길이","연결","연락","연구","위해","위치","위험","표시","표준","명칭","명령","기능","기간",
  "기반","기본","기존","반환","반영","라이","왕복","금액","옥상","육아","인증","인식","인원","맹점","제공",
  "제목","제한","제출","모든","모델","모니","탁월","국내","국가","국제","일대","번호","사업","사용","사항",
  "사람","사실","임의","통과","패턴","처럼","같은","문자","잘못","자릿","시작","형태","처음",
  "박물관","박물관에","인사를","인사","이름과","이름","정보를","정보","정리했다","정리했","정리됨","정리된","정리","문자열","문자열은",
]);

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return false;
    let n = code;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function detectAll(text: string): MockOpfDetection[] {
  const out: MockOpfDetection[] = [];
  for (const m of text.matchAll(EMAIL_RX)) {
    const start = m.index ?? 0;
    out.push({
      start,
      end: start + m[0].length,
      category: "private_email",
      confidence: 0.99,
      text: m[0],
    });
  }
  for (const m of text.matchAll(URL_RX)) {
    const start = m.index ?? 0;
    const cleaned = m[0].replace(/[.,;:!?)\]}>]+$/, "");
    out.push({
      start,
      end: start + cleaned.length,
      category: "private_url",
      confidence: 0.95,
      text: cleaned,
    });
  }
  for (const m of text.matchAll(CARD_RX)) {
    const start = m.index ?? 0;
    const raw = m[0];
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 16 && luhn(digits)) {
      out.push({
        start,
        end: start + raw.length,
        category: "card",
        confidence: 0.99,
        text: raw,
      });
    }
  }
  for (const m of text.matchAll(PHONE_RX)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, category: "private_phone", confidence: 0.85, text: m[0] });
  }
  for (const m of text.matchAll(KR_PHONE_RX)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, category: "private_phone", confidence: 0.9, text: m[0] });
  }
  for (const m of text.matchAll(KR_NAME_RX)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const s1 = raw[0] ?? "";
    const s2 = raw.slice(0, 2);
    const isName =
      !KR_STOPWORDS.has(raw) &&
      ((KR_SURNAMES.has(s2) && raw.length >= 3 && raw.length <= 4) ||
       (KR_SURNAMES.has(s1) && raw.length >= 3 && raw.length <= 4));
    if (isName) {
      out.push({ start, end: start + raw.length, category: "private_person", confidence: 0.85, text: raw });
    }
  }
  return resolveOverlaps(out);
}

function resolveOverlaps(detections: MockOpfDetection[]): MockOpfDetection[] {
  if (detections.length <= 1) return detections;
  const sorted = [...detections].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });
  const out: MockOpfDetection[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (!last || d.start >= last.end) {
      out.push(d);
      continue;
    }
    const lastLen = last.end - last.start;
    const curLen = d.end - d.start;
    if (curLen > lastLen) out[out.length - 1] = d;
  }
  return out;
}

async function startMockOpfServer(): Promise<MockServer> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const u = new URL(req.url);
      if (u.pathname === "/health") {
        return Response.json({ ok: true, version: "e2e-mock", model_loaded: true });
      }
      if (u.pathname === "/redact" && req.method === "POST") {
        const body = (await req.json()) as { text?: string };
        const text = typeof body.text === "string" ? body.text : "";
        return Response.json({ detections: detectAll(text) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    async close(): Promise<void> {
      server.stop(true);
    },
  };
}

async function loadCorpus(): Promise<Corpus> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "fixtures", "developer-corpus-sample.json");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Corpus;
}

async function loadKoreanCorpus(): Promise<KoreanCorpus> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "fixtures", "korean-pii-corpus.json");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as KoreanCorpus;
}

function buildConfig(endpoint: string): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: {
      ...DEFAULT_CONFIG.backend,
      type: "single",
      endpoint: `${endpoint}/redact`,
    },
  };
}

const CATEGORY_TOKEN_LABEL: Record<string, string> = {
  private_email: "EMAIL",
  private_url: "URL",
  private_phone: "PHONE",
  card: "CARD",
  rrn: "RRN",
  biz_num: "BIZNUM",
  private_person: "PERSON",
};

let mock: MockServer;
let corpus: Corpus;
let koreanCorpus: KoreanCorpus;

beforeAll(async () => {
  mock = await startMockOpfServer();
  corpus = await loadCorpus();
  koreanCorpus = await loadKoreanCorpus();
});

afterAll(async () => {
  await mock.close();
});

function mergedStrategy(opfUrl: string) {
  return new MergeStrategy([
    new LocalRegexBackend(),
    new OpfHttpBackend({ endpoint: opfUrl }),
  ]);
}

describe("e2e: developer corpus via plugin + mock HTTP backend", () => {
  test("corpus shape is sane (English + Korean)", () => {
    expect(corpus.pii.length).toBeGreaterThanOrEqual(48);
    expect(corpus.non_pii.length).toBeGreaterThanOrEqual(15);
    for (const e of corpus.pii) {
      expect(e.text.includes(e.needle)).toBe(true);
      expect(CATEGORY_TOKEN_LABEL[e.category]).toBeDefined();
    }
    const cats = new Set(corpus.pii.map((e) => e.category));
    expect(cats.has("rrn")).toBe(true);
    expect(cats.has("biz_num")).toBe(true);
    expect(cats.has("private_person")).toBe(true);
  });

  test("PII detection accuracy via plugin ≥ 95% (English + Korean)", async () => {
    const remover = await PIIRemover.init({
      sessionId: "e2e-pii",
      config: buildConfig(mock.url),
      env: {},
      warn: () => {},
      strategy: mergedStrategy(mock.url),
    });
    const hooks = createPluginHooks(remover, {
      warn: () => {},
      experimental: false,
    });

    let detected = 0;
    const failures: string[] = [];
    for (const entry of corpus.pii) {
      const output = { args: { text: entry.text } };
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: `c-${detected}` },
        output
      );
      const masked = (output.args as { text: string }).text;
      const expectedLabel = CATEGORY_TOKEN_LABEL[entry.category]!;
      const tokenPresent = masked.includes(`__OPF_${expectedLabel}_`);
      const needleAbsent = !masked.includes(entry.needle);
      if (tokenPresent && needleAbsent) {
        detected++;
      } else {
        failures.push(
          `category=${entry.category} needle="${entry.needle}" -> "${masked}"`
        );
      }
    }
    const accuracy = detected / corpus.pii.length;
    if (accuracy < 0.95) {
      throw new Error(
        `accuracy ${(accuracy * 100).toFixed(1)}% below 95%; failures:\n${failures.join("\n")}`
      );
    }
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
    remover.dispose();
  });

  test("false positive rate on developer non-PII ≤ 5%", async () => {
    const remover = await PIIRemover.init({
      sessionId: "e2e-non-pii",
      config: buildConfig(mock.url),
      env: {},
      warn: () => {},
      strategy: mergedStrategy(mock.url),
    });
    const hooks = createPluginHooks(remover, {
      warn: () => {},
      experimental: false,
    });

    let falsePositives = 0;
    const offenders: string[] = [];
    for (const entry of corpus.non_pii) {
      const output = { args: { text: entry.text } };
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: `c-${falsePositives}` },
        output
      );
      const masked = (output.args as { text: string }).text;
      if (masked.includes("__OPF_")) {
        falsePositives++;
        offenders.push(`"${entry.text}" -> "${masked}"`);
      }
    }
    const rate = falsePositives / corpus.non_pii.length;
    if (rate > 0.05) {
      throw new Error(
        `false-positive rate ${(rate * 100).toFixed(1)}% over 5%; offenders:\n${offenders.join("\n")}`
      );
    }
    expect(rate).toBeLessThanOrEqual(0.05);
    remover.dispose();
  });

  test("file_path field stays untouched even with embedded developer paths", async () => {
    const remover = await PIIRemover.init({
      sessionId: "e2e-path-safe",
      config: buildConfig(mock.url),
      env: {},
      warn: () => {},
      strategy: new SingleStrategy(new OpfHttpBackend({ endpoint: mock.url })),
    });
    const hooks = createPluginHooks(remover, {
      warn: () => {},
      experimental: false,
    });
    const output = {
      args: {
        file_path: "/home/john/work/repo/main.ts",
        cwd: "/home/john/work/repo",
        url: "https://github.com/example/repo",
        content: "Please email alice@example.com about the meeting today.",
      },
    };
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: "s", callID: "c" },
      output
    );
    const args = output.args as {
      file_path: string;
      cwd: string;
      url: string;
      content: string;
    };
    expect(args.file_path).toBe("/home/john/work/repo/main.ts");
    expect(args.cwd).toBe("/home/john/work/repo");
    expect(args.url).toBe("https://github.com/example/repo");
    expect(args.content).toContain("__OPF_EMAIL_");
    remover.dispose();
  });
});

describe("e2e: Korean PII round-trip (Phase 2 exit criteria)", () => {
  test("Korean PII 5종 round-trip ≥ 98% (RRN + BIZNUM + Phone + Person + Email)", async () => {
    const remover = await PIIRemover.init({
      sessionId: "e2e-kr-roundtrip",
      config: buildConfig(mock.url),
      env: {},
      warn: () => {},
      strategy: mergedStrategy(mock.url),
    });
    const hooks = createPluginHooks(remover, { warn: () => {} });
    const handler = hooks["experimental.text.complete"]!;

    const koreanEntries = corpus.pii.filter((e) =>
      ["rrn", "biz_num", "private_phone", "private_person", "private_email"].includes(
        e.category
      )
    );
    expect(koreanEntries.length).toBeGreaterThanOrEqual(30);

    let restored = 0;
    const failures: string[] = [];
    for (const entry of koreanEntries) {
      const part = { type: "text", text: entry.text };
      await hooks["experimental.chat.messages.transform"]!(
        {},
        { messages: [{ info: { role: "user" }, parts: [part] }] }
      );
      const masked = part.text;
      const llmEcho = { text: masked };
      await handler(
        { sessionID: "s", messageID: "m", partID: "p" },
        llmEcho
      );
      if (llmEcho.text === entry.text) {
        restored++;
      } else {
        failures.push(
          `category=${entry.category} needle="${entry.needle}" original="${entry.text}" restored="${llmEcho.text}"`
        );
      }
    }
    const accuracy = restored / koreanEntries.length;
    if (accuracy < 0.98) {
      throw new Error(
        `Korean round-trip ${(accuracy * 100).toFixed(1)}% below 98%; failures:\n${failures.join("\n")}`
      );
    }
    expect(accuracy).toBeGreaterThanOrEqual(0.98);
    remover.dispose();
  });

  test("Korean PII tolerates LLM lenient transformations (lowercased + suffix-missing)", async () => {
    const remover = await PIIRemover.init({
      sessionId: "e2e-kr-lenient",
      config: buildConfig(mock.url),
      env: {},
      warn: () => {},
      strategy: mergedStrategy(mock.url),
    });
    const hooks = createPluginHooks(remover, { warn: () => {} });
    const handler = hooks["experimental.text.complete"]!;

    const userInput = "주민번호 850315-1123457 김철수 010-1234-5678";
    const masked = (await remover.mask(userInput)).text;
    expect(masked).toContain("__OPF_RRN_");
    expect(masked).toContain("__OPF_PERSON_");
    expect(masked).toContain("__OPF_PHONE_");

    const llmMangled = masked
      .replace("__OPF_RRN_1__", "__opf_rrn_1__")
      .replace("__OPF_PERSON_1__", "__OPF_PERSON_1");
    const out = { text: llmMangled };
    await handler(
      { sessionID: "s", messageID: "m", partID: "p" },
      out
    );
    expect(out.text).toContain("850315-1123457");
    expect(out.text).toContain("김철수");
    expect(out.text).toContain("010-1234-5678");
    remover.dispose();
  });

  test("Korean name heuristic ≥ 85% recall on 100-name corpus", async () => {
    const remover = await PIIRemover.init({
      sessionId: "e2e-kr-recall",
      config: buildConfig(mock.url),
      env: {},
      warn: () => {},
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const hooks = createPluginHooks(remover, {
      warn: () => {},
      experimental: false,
    });

    let detected = 0;
    const misses: string[] = [];
    for (const entry of koreanCorpus.should_detect) {
      const sentence = `회원 ${entry.name} 님이 가입했습니다.`;
      const output = { args: { text: sentence } };
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: `c-${detected}` },
        output
      );
      const masked = (output.args as { text: string }).text;
      if (masked.includes("__OPF_PERSON_") && !masked.includes(entry.name)) {
        detected++;
      } else {
        misses.push(`${entry.name} (${entry.surname_type}) -> ${masked}`);
      }
    }
    const recall = detected / koreanCorpus.should_detect.length;
    if (recall < 0.85) {
      throw new Error(
        `Korean name recall ${(recall * 100).toFixed(1)}% below 85%; misses (first 10):\n${misses.slice(0, 10).join("\n")}`
      );
    }
    expect(recall).toBeGreaterThanOrEqual(0.85);
    remover.dispose();
  });

  test("Korean name heuristic ≤ 5% false positive on stopword/non-name corpus", async () => {
    const remover = await PIIRemover.init({
      sessionId: "e2e-kr-fp",
      config: buildConfig(mock.url),
      env: {},
      warn: () => {},
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const hooks = createPluginHooks(remover, {
      warn: () => {},
      experimental: false,
    });

    let falsePositives = 0;
    const offenders: string[] = [];
    for (const entry of koreanCorpus.should_not_detect) {
      const output = { args: { text: entry.text } };
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: `c-${falsePositives}` },
        output
      );
      const masked = (output.args as { text: string }).text;
      if (masked.includes("__OPF_PERSON_")) {
        falsePositives++;
        offenders.push(`"${entry.text}" (${entry.reason}) -> "${masked}"`);
      }
    }
    const rate = falsePositives / koreanCorpus.should_not_detect.length;
    if (rate > 0.05) {
      throw new Error(
        `Korean false-positive rate ${(rate * 100).toFixed(1)}% over 5%; offenders:\n${offenders.join("\n")}`
      );
    }
    expect(rate).toBeLessThanOrEqual(0.05);
    remover.dispose();
  });

  test("tool.execute.after restores Korean PII tokens emitted by tool output", async () => {
    const remover = await PIIRemover.init({
      sessionId: "e2e-kr-tool-after",
      config: buildConfig(mock.url),
      env: {},
      warn: () => {},
      strategy: mergedStrategy(mock.url),
    });
    const hooks = createPluginHooks(remover, { warn: () => {} });

    const sentence = "사업자 104-81-52702 와 연락처 010-1234-5678 처리.";
    const masked = (await remover.mask(sentence)).text;
    expect(masked).toContain("__OPF_BIZNUM_");
    expect(masked).toContain("__OPF_PHONE_");

    const toolOutput = {
      title: "Search hit __OPF_BIZNUM_1__",
      output: `Result line: ${masked}`,
      metadata: {},
    };
    await hooks["tool.execute.after"](
      { tool: "grep", sessionID: "s", callID: "c", args: {} },
      toolOutput
    );
    expect(toolOutput.output).toContain("104-81-52702");
    expect(toolOutput.output).toContain("010-1234-5678");
    expect(toolOutput.output).not.toContain("__OPF_");
    expect(toolOutput.title).toContain("104-81-52702");
    remover.dispose();
  });
});
