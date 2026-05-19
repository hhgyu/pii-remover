import { describe, expect, test } from "bun:test";
import {
  findKoreanNames,
  isKoreanStopword,
  isKoreanSurname,
  KOREAN_STOPWORDS,
  KOREAN_SURNAMES,
  SURNAMES,
} from "../src/detector/korean-heuristic/index.js";

const TYPICAL_NAMES: readonly string[] = [
  "김철수",
  "박영희",
  "이순신",
  "강감찬",
  "정약용",
  "황보영",
  "남궁민수",
  "최민수",
  "윤동주",
  "장영실",
];

const TASK_STOPWORDS: readonly string[] = [
  "박스", "정말", "정도", "정상", "정원",
  "박물관", "박수", "박사",
  "김치", "김밥", "김장", "김포", "김해",
  "이거", "이건", "이번", "이전", "이후", "이상", "이하",
  "최선", "최고", "최대", "최소", "최근",
  "윤리",
  "한강", "한국", "한복", "한문",
  "신라", "신촌", "신경",
  "안녕", "안전", "안내",
  "백두",
  "강남", "강북",
  "노란", "노력", "노트",
  "도서", "도시",
];

describe("Korean surname data", () => {
  test("contains exactly 100 surnames (single + compound)", () => {
    expect(KOREAN_SURNAMES.length).toBe(100);
  });

  test("SURNAMES set has 100 unique entries", () => {
    expect(SURNAMES.size).toBe(100);
  });

  test("includes top-10 single surnames", () => {
    const top10 = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임"];
    for (const s of top10) expect(isKoreanSurname(s)).toBe(true);
  });

  test("includes well-known compound surnames", () => {
    expect(isKoreanSurname("남궁")).toBe(true);
    expect(isKoreanSurname("황보")).toBe(true);
    expect(isKoreanSurname("제갈")).toBe(true);
    expect(isKoreanSurname("선우")).toBe(true);
    expect(isKoreanSurname("사공")).toBe(true);
    expect(isKoreanSurname("서문")).toBe(true);
  });

  test("excludes non-surname Hangul chars", () => {
    expect(isKoreanSurname("학")).toBe(false);
    expect(isKoreanSurname("회")).toBe(false);
    expect(isKoreanSurname("씨")).toBe(false);
  });
});

describe("Korean stopwords data", () => {
  test("contains all 30+ task-spec stopwords", () => {
    expect(TASK_STOPWORDS.length).toBeGreaterThanOrEqual(30);
    for (const w of TASK_STOPWORDS) {
      expect(isKoreanStopword(w)).toBe(true);
    }
  });

  test("KOREAN_STOPWORDS is a Set with size > 30", () => {
    expect(KOREAN_STOPWORDS.size).toBeGreaterThan(30);
  });
});

describe("findKoreanNames — typical Korean names", () => {
  test("detects all 10 typical names individually", () => {
    for (const name of TYPICAL_NAMES) {
      const dets = findKoreanNames(name);
      expect(dets).toHaveLength(1);
      expect(dets[0]!.text).toBe(name);
      expect(dets[0]!.category).toBe("private_person");
      expect(dets[0]!.start).toBe(0);
      expect(dets[0]!.end).toBe(name.length);
    }
  });

  test("detects names embedded in surrounding non-Hangul text", () => {
    const text = "Mr. 김철수 sent an email.";
    const dets = findKoreanNames(text);
    expect(dets).toHaveLength(1);
    expect(dets[0]!.text).toBe("김철수");
    expect(text.slice(dets[0]!.start, dets[0]!.end)).toBe("김철수");
  });

  test("detects multiple names separated by punctuation", () => {
    const dets = findKoreanNames("김철수, 박영희 그리고 이순신");
    const texts = dets.map((d) => d.text);
    expect(texts).toContain("김철수");
    expect(texts).toContain("박영희");
    expect(texts).toContain("이순신");
  });

  test("detects compound-surname names (황보영, 남궁민수)", () => {
    const dets1 = findKoreanNames("황보영");
    expect(dets1).toHaveLength(1);
    expect(dets1[0]!.text).toBe("황보영");

    const dets2 = findKoreanNames("남궁민수");
    expect(dets2).toHaveLength(1);
    expect(dets2[0]!.text).toBe("남궁민수");
  });
});

describe("findKoreanNames — stopword filtering (false-positive guard)", () => {
  test("does not detect any of the 30+ stopwords as names", () => {
    for (const w of TASK_STOPWORDS) {
      const dets = findKoreanNames(w);
      expect(
        dets,
        `stopword '${w}' was unexpectedly detected as a name`
      ).toHaveLength(0);
    }
  });

  test("does not detect stopwords inside sentences", () => {
    const dets = findKoreanNames("정말 정도가 박스에 있다");
    expect(dets.map((d) => d.text)).not.toContain("정말");
    expect(dets.map((d) => d.text)).not.toContain("박스");
  });
});

describe("findKoreanNames — edge cases", () => {
  test("does NOT detect single-char names (e.g., '김' alone)", () => {
    expect(findKoreanNames("김")).toHaveLength(0);
    expect(findKoreanNames("박")).toHaveLength(0);
  });

  test("DOES detect 4-char names with compound surname ('황보영희')", () => {
    const dets = findKoreanNames("황보영희");
    expect(dets).toHaveLength(1);
    expect(dets[0]!.text).toBe("황보영희");
  });

  test("does NOT detect foreign-style names (외래어, e.g., '스미스')", () => {
    expect(findKoreanNames("스미스")).toHaveLength(0);
    expect(findKoreanNames("톰슨")).toHaveLength(0);
    expect(findKoreanNames("브라운")).toHaveLength(0);
  });

  test("does NOT detect bare compound surname without given name ('황보' alone)", () => {
    expect(findKoreanNames("황보")).toHaveLength(0);
    expect(findKoreanNames("남궁")).toHaveLength(0);
  });

  test("empty / non-Hangul text yields no detections", () => {
    expect(findKoreanNames("")).toHaveLength(0);
    expect(findKoreanNames("hello world")).toHaveLength(0);
    expect(findKoreanNames("123 456")).toHaveLength(0);
  });

  test("respects custom surnames override", () => {
    const customSurnames = new Set(["김"]);
    const dets = findKoreanNames("김철수, 박영희", {
      surnames: customSurnames,
    });
    expect(dets).toHaveLength(1);
    expect(dets[0]!.text).toBe("김철수");
  });

  test("respects custom stopwords override (empty set => more matches)", () => {
    const emptyStopwords = new Set<string>();
    const dets = findKoreanNames("정말", { stopwords: emptyStopwords });
    expect(dets).toHaveLength(1);
    expect(dets[0]!.text).toBe("정말");
  });

  test("span offsets are codepoint-correct for Hangul (BMP)", () => {
    const text = "오늘 김철수, 반갑습니다";
    const dets = findKoreanNames(text);
    const personMatch = dets.find((d) => d.text === "김철수");
    expect(personMatch).toBeDefined();
    if (personMatch) {
      expect(text.slice(personMatch.start, personMatch.end)).toBe("김철수");
    }
  });
});
