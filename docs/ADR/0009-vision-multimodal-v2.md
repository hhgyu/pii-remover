# ADR-0009: Vision/multimodal PII 마스킹 — Docker 백엔드 통합 (becoolme 패턴, v1 Phase 6)

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §3, §12.3.3](../ARCHITECTURE.md), [ROADMAP.md Phase 6](../ROADMAP.md#phase-6--visionmultimodal-pii-마스킹-becoolme-패턴), [ADR-0004](./0004-local-llm-proxy-streaming.md), [ADR-0008](./0008-detection-backend-self-built-docker.md), [ADR-0010](./0010-pii-categories-opf-plus-korean.md)

---

## Context

### 처리해야 할 시나리오
Anthropic Messages API와 OpenAI Chat Completions 둘 다 이미지를 입력으로 받음:
- Anthropic: `content: [{ type: "image", source: { type: "base64", data: "..." } }]`
- OpenAI: `content: [{ type: "image_url", image_url: { url: "data:image/..." } }]`

사용자 워크플로 PII 노출:
- 스크린샷: 화면에 이메일/이름/주민번호
- 로그 캡처: 터미널 secret
- 문서 스캔: 신분증/사원증
- 다이어그램/슬라이드: 텍스트 영역 이름

### 참조 패턴 (becoolme)
[`becoolme/privacyfilter.app`](https://github.com/becoolme/privacyfilter.app)는 이 흐름을 검증:
```
이미지 → Tesseract.js OCR → text + bbox → PII detector → 영역 마스킹 → 재인코딩
```
becoolme는 100% 브라우저 — Transformers.js로 OPF 모델 실행 + Tesseract.js OCR. **개념적 파이프라인은 채택하되, 실행 환경은 우리 아키텍처에 맞춤**.

### 실행 환경 결정 — 클라이언트 in-process vs Docker 백엔드 통합

| 측면 | (A) TS 클라이언트 in-process | (B) Docker 백엔드 통합 ✅ |
|---|---|---|
| 일관성 | 텍스트는 백엔드, vision은 클라이언트 — 혼재 | 모든 PII 처리가 백엔드 — 일관 |
| 클라이언트 의존성 | tesseract.js (~30MB 모델) + sharp 네이티브 | HTTP fetch만 (의존성 0) |
| 모델 셋업 | 호스트별 캐시(OpenCode/Claude Code 각자) | Docker 이미지에 사전 포함, 한 번만 |
| 한국어 OCR 정확도 향상(v2 KLUE NER 등) | 클라이언트에 모델 추가 — 부담 ↑ | 백엔드 sidecar 추가만 — 격리 |
| 보안 모델 | 같음 (둘 다 localhost) | 같음 |
| 큰 이미지 처리 | 클라이언트 메모리 점유 | 백엔드 메모리 점유 (격리) |
| 백엔드 다운 시 | vision은 살아있음 | vision도 차단 (fail-closed 정합) |

**(B) 채택** — 사용자 명시 요청 + 백엔드 일관성 + 클라이언트 가벼움.

---

## Decision

### 1. **becoolme의 파이프라인 패턴 채택, 실행은 Docker 백엔드에서**

```
프록시 (TS)                  Detection Backend (Docker)
─────────                    ──────────────────────────
이미지 ──base64──→  POST /redact/image
                              ↓
                    [1] OCR (pytesseract, eng + kor)
                              ↓ text + bbox
                    [2] Text detector (OPF + 한국 정규식)
                              ↓ detections
                    [3] Pillow로 영역 마스킹
                              ↓
        ←─response─  { redacted_image, detections, ocr_text }

vault.assign(detections)
redacted_image를 LLM에 전송
```

### 2. **새 백엔드 endpoint: `POST /redact/image`**

**Request**:
```json
{
  "image": "base64-encoded-image",
  "media_type": "image/png",
  "languages": ["eng", "kor"],
  "mask_method": "black-box",
  "confidence_threshold": 0.6,
  "request_id": "uuid"
}
```

**Response**:
```json
{
  "redacted_image": "base64-encoded-masked-image",
  "media_type": "image/png",
  "ocr_text": "원본 OCR 추출 텍스트 (디버깅용)",
  "detections": [
    {
      "text": "철수",
      "category": "private_person",
      "bbox": { "x": 100, "y": 50, "w": 40, "h": 20 },
      "ocr_confidence": 0.92,
      "detector_confidence": 0.88
    }
  ],
  "low_confidence_regions": [
    { "bbox": {}, "ocr_confidence": 0.45 }
  ],
  "latency_ms": 850
}
```

**규칙**:
- `low_confidence_regions`는 OCR confidence < threshold인 영역. 클라이언트 정책(`mask`/`warn`/`block`)에 따라 처리
- detections의 `text`는 vault 저장용 (네트워크로 다시 안 나감)
- redacted_image는 이미 마스킹된 이미지 — 클라이언트는 그대로 LLM에 전송

### 3. **백엔드 구현: 기존 `pii-remover-backend` 컨테이너에 OCR 모듈 추가**

ADR-0008의 자체 빌드 백엔드에 vision endpoint 합류 (별도 sidecar 아님):
- **장점**: 사용자 docker-compose 한 컨테이너만 가동, 셋업 단순
- **이미지 크기 증가**: ~40MB (eng + kor traineddata) + pytesseract + Pillow → 수용 가능
- **자원**: OPF는 GPU 활용 가능, OCR은 CPU로도 충분 — 같은 컨테이너에서 양립

### 4. **OCR 엔진 선정: `pytesseract`** (becoolme의 Tesseract 호환)

| 옵션 | 장점 | 단점 |
|---|---|---|
| **`pytesseract`** ✅ | becoolme(Tesseract.js)와 동일 엔진, 모델 호환 | 한국어 정확도 PaddleOCR보다 ~5-10%p 낮음 |
| `PaddleOCR` | 한국어 정확도 ↑ | 모델 ~500MB, 의존성 ↑ |
| `EasyOCR` | 사용 쉬움 | PyTorch 의존, 이미 OPF가 PyTorch 사용 중이라 시너지는 있음 |

채택 이유: becoolme 검증 패턴 호환 우선. 한국어 OCR 한계는 v2에서 PaddleOCR로 교체 검토 가능 (ADR-XXXX).

### 5. **이미지 마스킹: Pillow (Python)** — 백엔드 측

- `PIL.ImageDraw`로 검은 박스
- `PIL.ImageFilter.GaussianBlur`로 블러 (옵션)
- `mask_method` 옵션으로 사용자 선택

### 6. **`@pii-remover/vision` TS 패키지: 얇은 HTTP 클라이언트만**

```
packages/vision/
├── src/
│   ├── client.ts           # POST /redact/image 호출
│   ├── types.ts            # request/response 타입
│   └── index.ts
└── package.json
```

- **의존성 0** (Node 내장 fetch만)
- 책임: HTTP 호출, vault 업데이트(detections 저장), 응답 검증
- 마스킹/OCR 로직 미포함 — 모두 백엔드

### 7. **프록시 통합**

`packages/proxy/src/providers/{anthropic,openai}.ts`에서 content block 처리 시 image 발견하면 `@pii-remover/vision` 호출:

```typescript
async function processContent(content, vault) {
  return await Promise.all(content.map(async (block) => {
    if (block.type === 'text') {
      return { ...block, text: pii.mask(block.text, vault) }
    }
    if (block.type === 'image') {
      const result = await visionClient.redactImage({
        image: block.source.data,
        media_type: block.source.media_type,
        languages: config.vision.languages,
        // ...
      })
      // vault에 detections 저장
      result.detections.forEach(d => vault.recordKnownText(d.text, d.category))
      // 마스킹된 이미지로 교체
      return {
        ...block,
        source: { ...block.source, data: result.redacted_image },
      }
    }
    return block
  }))
}
```

### 8. **Vault에 저장**: 텍스트 매핑만 (좌표는 일회용)

- 같은 텍스트 PII가 다음 턴 텍스트 응답에 등장하면 평소처럼 복원
- 이미지 좌표는 응답에서 재현될 일 없으므로 저장 안 함

### 9. **Fail 정책**

- 백엔드 OCR 실패 (timeout/네트워크 오류) → ADR-0006의 `failure_policy`에 따름:
  - `closed`: 이미지 포함 메시지 차단
  - `hybrid`: **이미지를 통째 차단**하지만 텍스트는 통과 (이미지 PII 누출 막음)
  - `open`: 이미지 그대로 전달 + 경고

---

## Consequences

### 긍정적
- **일관성**: 모든 PII 처리가 Docker 백엔드 — 보안 모델/신뢰 tier 단일
- **클라이언트 가벼움**: TS 측 의존성 0, 모델 다운로드 0
- **사용자 셋업**: docker-compose 한 컨테이너만 — vision 활성화 추가 단계 0
- **becoolme 패턴 호환**: 같은 OCR 엔진(Tesseract) → 동등 정확도
- **양 호스트(OpenCode/Claude Code) 동일 처리**: 백엔드 공유

### 부정적
- **백엔드 이미지 크기 ↑**: ~5-6GB → ~5.05GB (eng + kor traineddata + pytesseract + Pillow). 수용 가능.
- **백엔드 단일점 장애**: 백엔드 다운 시 vision도 차단 (fail-closed 정합).
- **큰 이미지의 base64 왕복 부담**: 5MB 이미지 = ~6.7MB base64 → HTTP localhost는 ms 단위 OK, 다만 메모리 일시 점유.
- **OCR 정확도 한국어**: Tesseract 한국어는 PaddleOCR 대비 약함 → v2 교체 검토.

### 위험 / 미해결 사항
- **OCR confidence threshold 조정**: 너무 높으면 누락 (false negative), 너무 낮으면 잡음(false positive). 기본 0.6, 사용자 corpus 측정 후 조정.
- **회전/스큐 이미지**: Tesseract는 회전된 텍스트에 약함. `--oem 1 --psm 6` 등 PSM(Page Segmentation Mode) 옵션 튜닝 필요.
- **PDF 첨부**: Anthropic은 PDF 지원. v1 Phase 6에서는 이미지만, PDF는 v1.x (별도 ADR — 백엔드에 pdfplumber/PyMuPDF 추가).
- **이미지 응답**: LLM이 응답으로 이미지 생성하는 케이스 (Anthropic은 안 함, OpenAI DALL-E 별도 endpoint) — v1 scope 외.
- **큰 이미지 메모리**: 백엔드 메모리 한도 (config로 `max_image_size_mb` default 10).

---

## Alternatives Considered

### (A) TS 클라이언트 in-process OCR (이전안)
- **거부 이유**: 사용자 명시 요청 — Docker 일관성 우선. 또한 TS 의존성 추가(~30MB tesseract.js + sharp 네이티브) 부담. 호스트별 모델 캐싱 분산.

### 별도 vision sidecar 컨테이너
- **거부 이유**: 사용자 셋업 단계 +1 (`pii-remover-vision-backend`도 가동해야). 통합 컨테이너가 더 사용자 친화적. 자원 격리 이득은 미미 (OCR이 CPU만 사용).

### PaddleOCR (Docker 통합)
- **연기 이유**: 한국어 정확도 우수하지만 모델 ~500MB + 의존성 큼. becoolme 호환을 위해 v1 Tesseract 채택. **v2에 ADR-XXXX로 교체 검토** (사용자 corpus 측정 후).

### 외부 OCR API (Google Vision 등)
- **거부 이유**: ADR-0005 Tier 4. PII 외부 노출.

### 클라이언트 Sharp + 백엔드 OCR (좌표만 백엔드 반환)
- **연기 이유**: 마스킹과 OCR 분리는 인터페이스 복잡도 ↑. v1은 백엔드 in-place 마스킹(`redacted_image` 반환)이 단순. 사용자가 마스킹 미리보기 등 필요 시 v1.x에서 좌표만 반환하는 옵션 추가 검토.

### `vision_policy` opt-out: 이미지 발견 시 차단
- **부분 채택**: `failure_policy: closed`에서 백엔드 실패 시 자동 차단. 사용자 명시 차단(`vision.enabled: false`)도 옵션.

---

## Implementation Notes

### 백엔드 추가 작업 (`packages/backend/`)
```
packages/backend/
├── server/
│   ├── api/
│   │   ├── redact.py            # POST /redact (Phase 1, 기존)
│   │   └── redact_image.py      # POST /redact/image (Phase 6, NEW)
│   ├── vision/
│   │   ├── ocr_runner.py        # pytesseract 호출
│   │   ├── mask_painter.py      # Pillow로 검은 박스/블러
│   │   └── coord_mapper.py      # OCR bbox + detector span → 이미지 좌표
│   └── ...
├── requirements.txt              # + pytesseract, Pillow
└── Dockerfile                    # + apt install tesseract-ocr-eng tesseract-ocr-kor
```

### Dockerfile 추가 부분
```dockerfile
# OCR 시스템 의존성
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-kor \
    libtesseract-dev \
    && rm -rf /var/lib/apt/lists/*

# Python 의존성: pytesseract, Pillow
# requirements.txt에 추가
```

### `@pii-remover/vision` 클라이언트 (TS)
```typescript
// packages/vision/src/client.ts
export interface ImageRedactRequest {
  image: string                    // base64
  media_type: string
  languages?: string[]
  mask_method?: 'black-box' | 'blur'
  confidence_threshold?: number
  request_id: string
}

export interface ImageRedactResponse {
  redacted_image: string
  media_type: string
  ocr_text: string
  detections: Detection[]
  low_confidence_regions: BoundingBox[]
  latency_ms: number
}

export class VisionClient {
  constructor(private endpoint: string, private auth?: AuthConfig) {}
  async redactImage(req: ImageRedactRequest): Promise<ImageRedactResponse> {
    // POST endpoint + Bearer/mTLS (ADR-0005)
    // 에러는 ADR-0006 failure_policy에 따라 처리
  }
}
```

### 설정 (config 스키마 추가)
```jsonc
{
  "vision": {
    "enabled": true,                       // false면 image content passthrough + 경고
    "languages": ["eng", "kor"],
    "mask_method": "black-box",            // "black-box" | "blur"
    "confidence_threshold": 0.6,
    "max_image_size_mb": 10,
    "policy_on_low_confidence": "mask",    // "mask" | "warn" | "block"
    "policy_on_backend_failure": "block"   // failure_policy 따름, override 가능
  }
}
```

### 측정 가능한 Phase 6 success criteria
- OCR 정확도 (한국어 + 영어 corpus 50건) ≥ 90%
- 시각 검증: 마스킹된 이미지에 PII 영역 누락 0건 (10건 fixture)
- 처리 지연 (1MB PNG) ≤ 2초 (CPU 기준)
- 메모리 (백엔드, 5MB 이미지) ≤ 500MB peak
- 클라이언트 측 추가 메모리 ≤ 10MB (base64 buffer만)

### 사용자 셋업 경험
```bash
docker compose up -d pii-remover-backend   # OPF + OCR 한 컨테이너 가동
                                            # → ~5분 첫 부팅 (모델 + OCR 데이터 로드)
                                            # → 이후 docker compose start로 즉시 가동

# 클라이언트는 추가 작업 없음
export ANTHROPIC_BASE_URL=http://localhost:8765/anthropic/v1
pii-remover proxy start   # vision 자동 활성화 (백엔드 health check 시 /redact/image 확인)
```

---

## References
- [`becoolme/privacyfilter.app`](https://github.com/becoolme/privacyfilter.app) — vision PII 파이프라인 패턴 (Apache-2.0 모델, MIT 코드)
- [`openai/privacy-filter`](https://github.com/openai/privacy-filter) — 텍스트 detector (재사용)
- [pytesseract](https://github.com/madmaze/pytesseract)
- [Pillow](https://python-pillow.org/)
- [Anthropic Vision API](https://docs.anthropic.com/en/docs/build-with-claude/vision)
- [OpenAI Vision API](https://platform.openai.com/docs/guides/vision)
- ADR-0004: 프록시 content block 처리
- ADR-0005: BackendClient 인터페이스 (`/redact/image`는 같은 trust tier)
- ADR-0006: failure_policy (vision도 동일 정책)
- ADR-0008: 자체 백엔드 — Phase 6에서 OCR 모듈 추가
- ADR-0010: 카테고리 매핑 (detections.category가 동일 enum)
- ROADMAP.md Phase 6 (Vision PII), Phase 7 (한국 이름 NER)
