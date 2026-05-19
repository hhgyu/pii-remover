const KOREAN_SURNAMES_LIST: readonly string[] = [
  "김", "이", "박", "최", "정", "강", "조", "윤", "장", "임",
  "한", "오", "서", "신", "권", "황", "안", "송", "류", "전",
  "홍", "고", "문", "양", "손", "배", "백", "허", "유", "남",
  "심", "노", "하", "곽", "성", "차", "주", "우", "구", "나",
  "민", "진", "지", "엄", "채", "원", "천", "방", "공", "현",
  "함", "변", "염", "여", "추", "도", "소", "석", "선", "설",
  "마", "길", "연", "위", "표", "명", "기", "반", "라", "왕",
  "금", "옥", "육", "인", "맹", "제", "모", "탁", "국", "어",
  "은", "편", "용", "예", "봉", "경", "사", "부", "복", "태",
  "목", "형", "두", "감",
  "남궁", "황보", "제갈", "선우", "사공", "서문",
];

export const KOREAN_SURNAMES: readonly string[] = KOREAN_SURNAMES_LIST;
export const SURNAMES: ReadonlySet<string> = new Set(KOREAN_SURNAMES_LIST);

export function isKoreanSurname(s: string): boolean {
  return SURNAMES.has(s);
}
