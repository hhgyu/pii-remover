# Trust Tiers — Backend 신뢰 모델 운영 가이드

> [ADR-0005](./ADR/0005-backend-strategy-trust-tiers.md)에서 결정한 4-Tier 신뢰표를 실제 설정과 함께 적용하기 위한 사용자 가이드. opt-in 보안 원칙과 Phase 5 구현(`RemoteHttpBackend`, `TieredStrategy`, TLS 헬퍼)을 전제로 한다.

---

## 0. 빠른 인덱스

읽는 순서가 정해지지 않은 운영 문서. 다음 시점에 맞는 섹션으로 바로 이동:

- 처음 도입한다 → §1 (개요) → §3 (Tier 선택) → §4 예시 1 또는 2.
- 사내 self-hosted 백엔드 띄울 준비 됐다 → §4 예시 2.
- DPA 있는 SaaS 검토 중 → §2.3 + §4 예시 3 + §5 (보안 권고).
- mTLS 인프라 있다 → §4 예시 4.
- 운영 중 에러가 났다 → 각 예시의 트러블슈팅 절 (§4.2.7, §4.3.9, §4.4.7).
- 인증서/토큰 유출 사고 → §5.11.
- 런타임 차이 / Node에서 undici 이슈 → §7.
- 한계 확인 → §8.
- 코드 위치 / ADR 매핑 → §9.

---

## 1. 개요

### 1.1 왜 신뢰 모델인가

`pii-remover`의 목적은 LLM에 PII가 평문으로 흘러 들어가지 못하게 하는 것이다. 그런데 **PII 검출 자체를 원격 백엔드에 위탁**하면 LLM 회피 문제가 다른 외부 서버로 옮겨갈 뿐이다. 도구가 "어디로" PII를 보내도 되는지에 대한 명확한 기준이 없다면 보안 보장은 0이다.

[ADR-0005](./ADR/0005-backend-strategy-trust-tiers.md)는 이 문제를 4단계로 분류한 신뢰 모델로 해결한다. 본 문서는 그 분류를 **실제 사용 시 어떤 설정을 골라야 하는가**, **어떤 보안 옵션을 켜야 하는가**, **언제 어떤 동작을 기대해야 하는가**의 운영 매뉴얼이다.

### 1.2 신뢰 모델이 보장하는 것

- **명시적 경계**: 어느 텍스트가 어디로 흐르는지가 코드와 설정 양쪽에서 추적 가능.
- **fail-closed init**: TLS 인증서, CA 번들, mTLS cert/key가 부재하면 첫 detection 호출 시점에 throw — 실행 중 보안 약화가 발생하지 않음. [ADR-0006](./ADR/0006-fail-closed-default.md)와 일관.
- **Korean PII redaction 단방향성**: `TieredStrategy`는 로컬에서 잡은 한국 PII를 placeholder로 치환한 뒤에야 원격 호출. 한국 PII는 절대 외부로 나가지 않는다 (Phase 5 보안 invariant).
- **Token/passphrase 비노출**: Bearer 토큰, API key, mTLS passphrase는 어떤 에러 메시지나 로그에도 나오지 않는다.

### 1.3 신뢰 모델이 보장하지 않는 것

- **백엔드 자기보고는 무시한다**: 백엔드가 응답 헤더에 `trust_tier: local`이라 적어 와도 클라이언트는 자기 config의 `backend.trust_tier`만 진실로 간주.
- **보안 옵션이 자동 활성화되지 않는다**: TLS pinning, mTLS, 커스텀 CA는 모두 **opt-in**. default config는 가장 단순한 localhost 시나리오용.
- **Tier가 강제되지 않는다**: Tier 4(public SaaS)로 설정해도 도구는 동작한다. 경고만 남기고 사용자 책임. 정책 강제는 조직 운영 차원(예: CI lint)에서 처리.

### 1.4 Opt-in 보안 원칙 요약 (이 문서를 따르려면 알아야 할 것)

- **opt-in 원칙**: 보안 옵션을 강제하면 self-signed cert 환경 등에서 도구가 자체적으로 동작 못함 → 사용자가 bypass → 도구 무력화. 그래서 default는 약한 보안이고, 강한 보안은 사용자가 명시적으로 활성화한다.
- **TLS pinning + Bearer는 production 권장**: opt-in이지만 self-hosted/vendor tier에서는 강하게 권한다. 본 문서 §4 예시 2~3 참조.
- **mTLS는 사내 PKI가 있을 때만**: 클라이언트 인증서 발급 인프라가 없으면 운영 부담이 검증된 가치를 초과. §4 예시 4 참조.

### 1.5 본 문서를 읽고 나면

- 자기 워크플로에 적합한 Tier를 결정할 수 있다 (§3).
- 해당 Tier의 `pii-remover` 설정을 작성할 수 있다 (§4의 valid JSON 예시).
- 보안 옵션을 어떤 순서로 켜야 하는지 안다 (§5).
- 검증 실패 / TLS 에러 / 토큰 부재 시 어떤 메시지를 보고 어떻게 복구해야 하는지 안다 (§4 / §5 / §8).
- 운영 환경(Bun vs Node)별 차이를 안다 (§7).

본 문서는 [ADR-0005](./ADR/0005-backend-strategy-trust-tiers.md)의 결정을 전제로 작성됐다. ADR의 컨텍스트(왜 이 결정을 했는가)와 본 문서의 컨텐츠(어떻게 운영하는가)는 의도적으로 분리되어 있다. 보안 정책 자체에 동의하지 않거나 대안을 검토하고 싶다면 ADR-0005를 먼저 읽길 권한다.

---

## 2. Tier별 정의

각 Tier는 단순한 라벨이 아니라 **네트워크 노출 + 인증 + 위험**의 합성이다.

### 2.1 Tier 1 — `local`

**정의**: 같은 호스트(localhost / 127.0.0.1 / Unix socket)에서 동작하는 검출 백엔드. 사용자가 직접 띄운 Docker 컨테이너 또는 내장 `LocalRegexBackend`.

**네트워크 노출**: 없음. 패킷이 외부 인터페이스로 나가지 않음.

**인증**: 불필요 또는 매우 약한 인증(예: localhost-only bind + 토큰 없음). `backend.auth.type: "none"`가 default.

**대표 시나리오**:
- `docker-compose up`으로 띄운 OPF 자체 빌드 백엔드 ([ADR-0008](./ADR/0008-detection-backend-self-built-docker.md)) — 가장 권장되는 default 구성.
- `LocalRegexBackend`만 사용 — 한국 PII 5종 + 영문 OPF 패턴 일부 검출. ML 추론 없음.

**잠재적 위험**:
- 다른 사용자가 같은 머신에 로그인할 수 있는 다중 사용자 환경에서 localhost 8000 포트가 노출됨. 개인 개발 머신에서는 무시 가능.
- 컨테이너 escape — Docker 격리 신뢰에 의존. 대부분의 시나리오에서 충분.

**구현 매핑**:
- `OpfHttpBackend`가 localhost endpoint + `none|bearer` auth + TLS 미설정일 때 자동 선택됨 (`buildRemoteBackend`의 `isOpfWireEndpoint` 휴리스틱).
- 별도 TLS 설정 불필요. `tls.verify: true` default 유지하면 됨 (TLS 비활성 endpoint면 무시됨).

**default config**: `packages/core/src/config/schema.ts`의 `DEFAULT_CONFIG`가 이 시나리오를 가정.

**시작 절차 요약**:

1. OPF 자체 빌드 백엔드 docker image를 pull 또는 build.
2. `docker-compose up` 또는 `docker run -p 8000:8000 ...`로 컨테이너 가동.
3. `pii-remover` 설정 그대로 default 사용 — 별도 config 파일 불필요. 또는 `endpoint`를 빈 문자열로 명시해서 `LocalRegexBackend`만 쓰는 시나리오 선택.
4. 호스트 통합 (OpenCode plugin 또는 Claude Code hook) 설치 → 동작.

**리소스 사용량 추정** (OPF 백엔드 컨테이너):

- 이미지 크기: ~5-6GB (모델 weights 포함).
- 메모리: 평소 ~2GB, 추론 시 peak ~3GB.
- CPU: 추론 시 1-2 vCPU.
- GPU: 옵션 — `--gpus all`로 활성화 시 추론 latency 큰 폭 감소.

---

### 2.2 Tier 2 — `self_hosted`

**정의**: 사용자 또는 사용자 조직이 운영하는 원격 서버. **TLS 필수**. Bearer 토큰 또는 mTLS로 인증. 운영 책임은 사용자 측.

**네트워크 노출**: 사내망 또는 VPN, 또는 일부 시나리오에서는 인터넷 노출. TLS 1.2+ 강제.

**인증**: `bearer` (가장 흔함), `api_key` (커스텀 헤더), `mtls` (사내 PKI 있을 때).

**대표 시나리오**:
- 회사 내부 GPU 서버에 OPF compatible PII 검출 API를 한 곳에 배치하고 사내 개발자들이 공유.
- Bug bounty 또는 보안 팀이 운영하는 PII redaction service — DPA(데이터 처리 합의)는 사내 내부 정책으로 처리.
- Vendor의 self-hosted 옵션(컨테이너 이미지를 사내에 배포)을 사용하는 경우.

**잠재적 위험**:
- TLS pinning 미사용 시 중간자 공격(MITM) — 사내 CA를 신뢰하더라도 공격자가 사내 PKI를 침해하면 우회 가능. **TLS pinning 강력 권장**.
- 토큰 유출: token_env가 가리키는 환경변수가 다른 프로세스에서 읽히는 환경(예: 공용 CI runner). 짧은 TTL + 로테이션 정책 권장.

**구현 매핑**:
- `RemoteHttpBackend` 사용. `buildRemoteBackend`는 localhost가 아닌 endpoint면 자동으로 이 클래스를 선택.
- TLS 헬퍼(`buildFetchTlsExtension`)가 Bun에서는 `{ tls: { ... } }`, Node에서는 `{ dispatcher: undici.Agent }`로 변환.
- pinning fingerprint는 `backend.tls.pinning.sha256_fingerprint`. colon-separated 또는 concatenated 모두 허용 (`normalizeFingerprint`).

**운영 권장 사항**:
- 인증서는 사내 PKI 또는 Let's Encrypt 같은 공신력 있는 발급기관에서 받기. self-signed는 회전이 어려워 비추천.
- pinning fingerprint는 운영팀 위키에 공식 기록 + 자동 인증서 회전 파이프라인이 fingerprint를 함께 갱신하도록.
- 사내망 격리: 백엔드 서버는 VPN 또는 service mesh 내부에만 노출. 인터넷 노출 시 추가로 WAF / rate limit 권장.
- 토큰 관리: 사용자별 짧은 TTL 토큰 발급(예: 7일) + 만료 시 자동 갱신 워크플로. 공유 토큰은 누구의 머신에서 유출됐는지 추적 불가.

---

### 2.3 Tier 3 — `vendor`

**정의**: 외부 SaaS 벤더가 호스팅하는 PII 검출 API. 사용자가 인프라를 운영하지 않음. 데이터는 벤더 측 서버로 전송됨. **계약(DPA/BAA)이 있는 경우에만 권고**.

**네트워크 노출**: 인터넷. TLS 1.2+ 강제. pinning은 벤더가 인증서 로테이션 정책을 공표한 경우에만 사용.

**인증**: `bearer` 또는 `api_key`. 벤더 발급 토큰.

**대표 시나리오**:
- 사내 인프라 구축 여력이 없는 팀이 SOC2 인증 받은 PII redaction SaaS를 사용. 계약에 "원본 텍스트 로깅 안 함" 명시.
- 의료/금융 등 BAA(Business Associate Agreement) 또는 DPA(Data Processing Agreement)로 PII 처리 합의가 이미 있는 벤더.

**필수 5조건** ([ADR-0005](./ADR/0005-backend-strategy-trust-tiers.md) §4 재인용):
1. **소유권**: 자체 호스팅 OR 계약상 데이터 처리 합의(DPA/BAA) 있음
2. **전송 암호화**: TLS 1.2+ 필수, 평문 HTTP 거부
3. **로깅 정책**: 백엔드가 request body를 영구 저장 안 함 (벤더 문서로 확인)
4. **데이터 거주**: 지리적 위치 알 수 있음 (GDPR/PIPA 준수)
5. **인증**: 최소 Bearer 토큰 — 익명 endpoint 거부

**잠재적 위험**:
- 한국 PII가 벤더로 평문 전송될 수 있음 → 도구 목적 자체 무력화 위험. **반드시 `backend.type: "tiered"` 사용** — `LocalRegexBackend`가 한국 PII를 placeholder로 치환한 뒤에야 벤더로 전송됨.
- 벤더의 데이터 처리 정책이 변경되는 경우. SLA + 재계약 트리거에 데이터 처리 변경 통지 조항이 있어야 함.
- 벤더 측에 한국어 검출 정확도가 낮을 수 있음 — local regex에서 잡지 못한 한국 이름 케이스가 벤더에서도 누락될 수 있음. 그러나 redacted 텍스트에는 잡힌 PII가 placeholder로 치환되어 있어 추가 누출은 발생하지 않음.

**구현 매핑**:
- 반드시 `backend.type: "tiered"`로 설정.
- `RemoteHttpBackend.trust_tier`를 명시적으로 `"vendor"`로 설정 (Tier가 추적/감사 단계에서 보이도록).

**벤더 평가 체크리스트** (계약 전 검증):
- 데이터 거주 지역이 회사 컴플라이언스 정책에 맞는가? (예: 한국 PII는 KR/JP/SG 리전 권장)
- 벤더가 SOC 2 Type II 또는 ISO 27001 인증 보유?
- API 응답에 detection 결과뿐 아니라 redacted 텍스트도 포함되는가? (포함이면 더 안전 — 클라이언트가 redaction을 따로 검증할 필요 없음)
- 벤더가 인증서 회전 정책을 공표하는가? (pinning 가능 여부 결정)
- 벤더 API의 rate limit / SLA가 워크로드에 맞는가?

---

### 2.4 Tier 4 — `public`

**정의**: 익명 또는 무료 공개 SaaS PII redaction API. 계약 없음. 토큰만 있으면 누구나 호출 가능. 데이터 처리 정책 불투명.

**네트워크 노출**: 인터넷.

**인증**: API key (벤더 발급) 또는 익명.

**대표 시나리오**:
- 빠른 프로토타입 / 실험 단계.
- 데모 또는 비-production 환경.

**왜 사용 비추천인가**:

`pii-remover`의 목적은 "PII가 LLM 등 외부 서비스로 평문 전달되지 않게 하는 것"이다. Tier 4 백엔드는 그 목적의 반대. 사용자의 PII가 공개 SaaS에 평문으로 전송된다는 점에서 LLM에 보내는 것과 보안적으로 동등하거나 더 나쁘다 (LLM은 적어도 응답이 사용자에게만 가지만, public PII redaction SaaS는 데이터를 학습에 사용할 가능성도 있음).

**그래도 써야 한다면**:
- 반드시 `backend.type: "tiered"` 사용 — 한국 PII는 절대 외부로 안 나감.
- `tls.pinning.enabled: true` + 벤더 공표 fingerprint 사용.
- `backend.trust_tier: "public"`로 명시 → 감사 로그에서 식별 가능.
- 가능한 빠른 시일 내 self-hosted 또는 vendor(DPA 있는) tier로 이전.

**구현 매핑**:
- 클라이언트 코드는 Tier 3와 동일 (`RemoteHttpBackend` + `TieredStrategy`).
- 차이는 `trust_tier` 라벨링 + 운영 정책 측면.

---

## 3. Tier 선택 가이드 (의사결정 흐름)

질문을 위에서 아래로 따라가며 첫 "예"에서 해당 Tier를 채택한다.

```
Q1. 내장 LocalRegexBackend로 충분한 한국 PII 5종 + 영문 일부면 OK인가?
    예 → Tier 1 (LocalRegexBackend만, OpfHttpBackend 없이)
    아니오 → Q2

Q2. ML 기반 검출이 필요한가?  (예: 영문 이름, 영문 주소, secret detection)
    예 → Q3
    아니오 → Tier 1 (LocalRegexBackend만)

Q3. 같은 호스트에 Docker로 OPF 백엔드를 띄울 수 있는가?
    예 → Tier 1 (OpfHttpBackend, localhost endpoint)
    아니오 → Q4

Q4. 사내 자체호스팅 GPU 서버가 있는가?  (혹은 가까운 미래에 마련 가능?)
    예 → Tier 2 (RemoteHttpBackend, self_hosted + TLS pinning + Bearer)
    아니오 → Q5

Q5. DPA/BAA 있는 벤더 SaaS를 쓸 수 있는가?  (한국 PII는 tiered로 보호)
    예 → Tier 3 (RemoteHttpBackend + TieredStrategy, vendor)
    아니오 → Q6

Q6. 빠른 데모 / 프로토타입용이고 며칠 안에 더 나은 옵션으로 이전 가능한가?
    예 → Tier 4 (TieredStrategy 필수, 단기간만)
    아니오 → backend.type: "single" + LocalRegexBackend만 사용 (Tier 1로 후퇴)
```

### 3.1 보안 vs 운영 부담 trade-off 표

| Tier | 보안 강도 | 운영 부담 | 한국 PII 안전 | 권장 시나리오 |
|---|---|---|---|---|
| 1 (local) | 매우 강 | 매우 낮음 | 안전 | 개인 / 단일 머신 / Docker 가능 |
| 2 (self_hosted) | 강 | 중 | 안전 | 사내 GPU 공유 / TLS pinning + Bearer |
| 3 (vendor + DPA) | 중 | 낮음 | tiered로 안전 | DPA 있는 SaaS / tiered 필수 |
| 4 (public) | 약 | 낮음 | tiered로 안전 | 임시 / 데모 / 단기 |

### 3.2 보안 옵션 매트릭스

| 옵션 | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| TLS verify (기본 true) | 무관 | **필수** | **필수** | **필수** |
| TLS pinning | 불필요 | 권장 | 권장(벤더 공표 시) | 권장 |
| Bearer 토큰 | 불필요 | **권장** | **필수** | **필수** |
| mTLS | 불필요 | 사내 PKI 있을 때 | 벤더 지원 시 | 불필요 |
| TieredStrategy | 옵션 | 옵션 | **필수** | **필수** |

### 3.3 의사결정 사례 — 가상의 조직별 매핑

| 조직 유형 | 권장 Tier | 보안 옵션 조합 | 비고 |
|---|---|---|---|
| 1인 개발자 (개인 노트북) | Tier 1 | LocalRegexBackend만 또는 localhost Docker | 가장 단순. 영문 ML이 필요하면 Docker 추가. |
| 한국 스타트업 (5-20명) | Tier 1 → Tier 2 | 초기 Tier 1, 팀이 커지면 Tier 2 + Bearer | 사내 GPU 서버 구축 시점에 마이그레이션. |
| 중견 IT 기업 (사내 PKI 보유) | Tier 2 | TLS pinning + Bearer 또는 mTLS | 인증서 회전 파이프라인 통합. |
| 금융/의료 (강한 컴플라이언스) | Tier 2 | TLS pinning + mTLS + audit log | DPA + 사내 PKI + 별도 vault encryption. |
| 빠른 PoC (단기 데모) | Tier 4 | TieredStrategy + Bearer | 일주일 안에 더 안전한 Tier로 이전 계획 명시. |
| 다국적 기업 (지역별 데이터 거주) | Tier 3 (지역별) | TieredStrategy + Bearer/api_key + pinning | 리전별로 다른 vendor 또는 self-hosted endpoint. |

---

## 4. 구체적 사용 예시

각 예시는 valid JSON 설정 + 동작 설명 + pros/cons.

### 4.1 예시 1: 로컬 정규식만 (Tier 1, 가장 단순)

검출 백엔드 없이 내장 정규식만 사용. Docker도 띄울 필요 없음.

#### 4.1.1 설정

`.pii-remover.json`:

```json
{
  "backend": {
    "type": "single",
    "endpoint": "",
    "trust_tier": "local",
    "auth": { "type": "none" },
    "tls": {
      "verify": true,
      "ca_bundle_path": null,
      "pinning": { "enabled": false, "sha256_fingerprint": null }
    },
    "timeout_ms": 2000,
    "retries": 0
  },
  "failure_policy": "closed"
}
```

`backend.endpoint`가 빈 문자열이면 `buildDefaultStrategy`는 `LocalRegexBackend` 하나만 가진 `SingleStrategy`를 만든다.

#### 4.1.2 동작

- 검출되는 카테고리: `rrn`, `biz_num`, `card`, `private_phone`(010 + 영문 패턴), `private_email`, `private_url`, `private_person`(한국 이름 휴리스틱).
- 검출 안 되는 것: 영문 이름, 영문 주소, 영문 secret(API key 패턴 등) — ML 백엔드가 필요한 것들.
- 지연: 모두 in-process, 평균 5ms 미만 (텍스트 길이에 선형).

#### 4.1.3 pros

- 네트워크 호출 0건. 사용자의 PII가 어떤 프로세스 경계도 넘지 않음.
- 설정 가장 단순.
- 오프라인 동작.

#### 4.1.4 cons

- 영문 이름/주소/secret 미검출. 코드 리뷰, 영문 documentation을 다루는 워크플로에서 누락 위험.
- 한국 이름 휴리스틱의 false negative — 흔치 않은 성씨, 두 글자 이름, 한자 표기는 약함 (자세한 한계는 [KOREAN_PII.md §5](./KOREAN_PII.md)).

#### 4.1.5 트러블슈팅

- "이메일은 잡히는데 영문 이름은 안 잡힌다" → 정상. LocalRegexBackend는 영문 NER 없음. ML 백엔드 필요 → 예시 2 또는 3으로 이전.
- "한국 이름이 잡혔다 안 잡혔다 한다" → 휴리스틱 한계. stopwords 갱신 또는 ML 보조 검토. KOREAN_PII.md §5 참조.
- "신용카드가 안 잡힌다" → LUHN 체크 실패 가능. 형식이 4-4-4-4가 아니거나 자릿수 부족하면 무시.
- "PII 없는 텍스트인데 마스킹된다" → false positive. 카테고리 옵션으로 일부 카테고리 비활성화 가능 (`detection.enabled_categories`).

---

### 4.2 예시 2: 사내 self-hosted + TLS pinning + Bearer (Tier 2)

사내 GPU 서버에 OPF compatible PII 검출 API를 띄우고, 사내망에서 TLS pinning + Bearer 토큰으로 호출.

#### 4.2.1 사전 작업

1. 사내 서버에 OPF 컨테이너 배포 ([ADR-0008](./ADR/0008-detection-backend-self-built-docker.md) 참조). 정식 인증서로 TLS 1.2+ 설정.
2. 인증서의 SHA-256 fingerprint 추출:

```powershell
# 서버 cert 다운로드 (PowerShell, OpenSSL 필요)
openssl s_client -showcerts -connect pii-backend.internal:443 -servername pii-backend.internal `
  </dev/null 2>$null `
  | openssl x509 -fingerprint -sha256 -noout
```

출력 예시: `sha256 Fingerprint=AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99`

`AA:BB:...` 부분만 복사. (`normalizeFingerprint`가 콜론/공백/대소문자 모두 정규화하므로 그대로 붙여 넣어도 됨.)

3. Bearer 토큰을 환경변수로 등록 (셸 RC 파일 또는 시크릿 매니저):

```powershell
$env:PII_API_TOKEN = "내부-발급-토큰-여기"
```

#### 4.2.2 설정

`.pii-remover.json`:

```json
{
  "backend": {
    "type": "single",
    "endpoint": "https://pii-backend.internal/redact",
    "trust_tier": "self_hosted",
    "auth": {
      "type": "bearer",
      "token_env": "PII_API_TOKEN"
    },
    "tls": {
      "verify": true,
      "ca_bundle_path": null,
      "pinning": {
        "enabled": true,
        "sha256_fingerprint": "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
      }
    },
    "timeout_ms": 3000,
    "retries": 2
  },
  "failure_policy": "closed"
}
```

#### 4.2.3 동작

- 시작 시점: `RemoteHttpBackend`가 instantiated. `tls.pinning.sha256_fingerprint`가 `buildPinningCheckServerIdentity`로 변환되어 fetch init에 주입.
- 첫 detect() 호출: Bun이면 `{ tls: { rejectUnauthorized: true, checkServerIdentity } }`, Node면 `{ dispatcher: undici.Agent(...) }`.
- 서버 인증서가 expected fingerprint와 일치하면 정상 동작. 일치하지 않으면 TLS handshake 실패 → 에러 throw → `failure_policy: "closed"`에 따라 `FailClosedError`로 사용자에게 차단 알림.
- Bearer 토큰은 `Authorization: Bearer ${PII_API_TOKEN}` 헤더로 전송. **에러 메시지나 로그에 토큰은 절대 출력되지 않음** (HTTP 상태코드 + statusText만).
- transient 에러(5xx, ECONNRESET, ETIMEDOUT 등) 시 최대 `retries: 2`회 재시도. 4xx는 즉시 throw (재시도 안 함).

#### 4.2.4 검증 실패 동작

서버가 다른 cert로 교체되었거나 MITM 공격이 있는 경우:

- Bun: `checkServerIdentity`가 `Error("TLS pinning: server certificate fingerprint mismatch")` 반환 → TLS handshake 실패.
- Node: undici Agent가 같은 콜백을 통해 거부 → connection reject.
- 사용자는 [WARN] PII detection failed (mode=closed, backend=remote-http(...)): TLS pinning: server certificate fingerprint mismatch 에러 메시지를 stderr로 받음.
- 마스킹 단계가 fail-closed로 차단 → LLM 호출 자체가 막힘. 명시적 bypass(`PII_REMOVER_BYPASS=1`)로만 우회 가능 ([ADR-0006](./ADR/0006-fail-closed-default.md)).

#### 4.2.5 pros

- 사내망 + TLS pinning = MITM 위협에 강함.
- Bearer 토큰 rotation 가능 (환경변수만 교체하고 프로세스 재시작).
- 한국 PII는 default로는 vendor 측 ML이 처리. 만약 더 강한 격리를 원하면 `backend.type: "tiered"`로 전환.

#### 4.2.6 cons

- 사내 PKI 인증서 로테이션 시 fingerprint도 갱신해야 함. 자동화 안 하면 갱신 시점에 모든 사용자 설정 변경 부담.
- 사내 GPU 서버 운영 인프라 필요.

#### 4.2.7 트러블슈팅

- "TLS pinning: server certificate fingerprint mismatch" 에러:
  - 인증서가 회전됐는데 config가 안 갱신된 경우 → 새 fingerprint 추출 후 config 갱신.
  - MITM 공격 가능성 → 보안 팀에 보고. 절대로 fingerprint를 그냥 갱신하지 말고 원인 분석부터.
- "Authorization 헤더가 안 보낸다" → `token_env`가 가리키는 환경변수가 빈 문자열 또는 미설정. 셸 RC 재로딩 또는 `pii-remover` 재시작 필요.
- "HTTP 401" 응답 → 토큰 만료 또는 무효. 새 토큰 발급 후 환경변수 갱신.
- "HTTP 503" 후 재시도 안 됨 → `retries: 0`으로 설정되어 있거나 retries 횟수를 초과. config 갱신.
- "ECONNREFUSED" → 백엔드 서버 다운 또는 endpoint URL 오타. health 체크 우선.

#### 4.2.8 인증서 회전 체크리스트

- [ ] 신규 인증서 발급 + 사내 서버 배포.
- [ ] 새 fingerprint 추출 (위 §4.2.1).
- [ ] 운영팀 위키에 새 fingerprint 기록 + 회전 날짜 명시.
- [ ] 모든 사용자에게 config 갱신 안내 (또는 자동 배포 시스템 가동).
- [ ] 구 인증서 만료 직전까지 둘 다 받아주는 dual-cert 기간 확보 (선택, 운영 복잡도와 trade-off).

---

### 4.3 예시 3: SaaS vendor + tiered 모드 (Tier 3)

DPA 있는 외부 SaaS PII detection API를 사용하되, 한국 PII는 절대 외부로 안 나가도록 `TieredStrategy`로 격리.

#### 4.3.1 사전 작업

1. 벤더와 DPA 체결. 5조건([§2.3](#23-tier-3--vendor)) 모두 확인.
2. 벤더 발급 API key를 환경변수로 등록:

```powershell
$env:PII_VENDOR_KEY = "벤더-발급-키"
```

3. 벤더가 인증서 fingerprint 공표 정책이 있다면 pinning 활성화 (강력 권장). 없으면 `tls.verify: true`만 유지.

#### 4.3.2 설정

`.pii-remover.json`:

```json
{
  "backend": {
    "type": "tiered",
    "endpoint": "https://api.vendor.example/v1/redact",
    "trust_tier": "vendor",
    "auth": {
      "type": "api_key",
      "token_env": "PII_VENDOR_KEY",
      "header_name": "X-Vendor-Api-Key"
    },
    "tls": {
      "verify": true,
      "ca_bundle_path": null,
      "pinning": {
        "enabled": true,
        "sha256_fingerprint": "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00"
      }
    },
    "timeout_ms": 5000,
    "retries": 1
  },
  "failure_policy": "closed",
  "detection": {
    "enabled_categories": [
      "private_person", "private_email", "private_phone",
      "private_address", "private_url", "account_number",
      "secret", "rrn", "biz_num", "card"
    ],
    "korean_heuristics": {
      "enabled": true,
      "surname_list_path": null,
      "stopwords_path": null
    }
  }
}
```

#### 4.3.3 동작 — placeholder 보호 메커니즘

`backend.type: "tiered"`일 때 `buildTieredStrategy`는 다음 파이프라인을 만든다:

1. **로컬 detect**: `LocalRegexBackend.detect(text, opts)`. 한국 PII 5종(rrn / biz_num / card / 010 phone / private_person) + 영문 일부(email / URL / 영문 phone / card) 잡아냄.
2. **redactSpans**: 로컬 검출 span들을 `\u00B7` (middle dot, U+00B7)로 길이 보존 치환. 예: `"주민 920101-1234562 끝"` → `"주민 ·············· 끝"`. **길이 보존이 보안 invariant** — 원격 검출이 반환한 offset이 원본 텍스트와 정확히 같은 위치를 가리키게 함.
3. **원격 detect**: `RemoteHttpBackend.detect(redacted_text, opts)`. 벤더 API는 placeholder만 보고 추가 검출 (영문 이름, 영문 주소 등).
4. **merge**: 로컬 결과 + 원격 결과를 `mergeDetections`로 union — longer-span 우선, FIFO ties.

원격에 전송되는 텍스트에는 **원본 한국 PII 문자열이 절대 존재하지 않음**. mock remote capture 테스트 4건이 이를 검증 (`tiered-strategy.test.ts`).

#### 4.3.4 시각 예시

원본 입력:
```
저자는 김철수이고 user@example.com 카드는 4242 4242 4242 4242 RRN 920101-1234562
```

`LocalRegexBackend` 검출:
- 김철수 → private_person (한국 이름 휴리스틱)
- user@example.com → private_email
- 4242 4242 4242 4242 → card
- 920101-1234562 → rrn

placeholder 치환 후 (원격에 전송되는 텍스트):
```
저자는 ···이고 ················ 카드는 ··················· RRN ··············
```

벤더 API는 이 redacted 텍스트만 본다. 한국 PII는 외부로 누출되지 않음.

#### 4.3.5 local 검출 실패 정책

`TieredStrategy.on_local_failure`는 로컬 검출 자체가 실패한 경우의 동작을 결정:

- `"skip_remote"` (default): warn 로깅 후 빈 detections 반환. **원격 호출 안 함** — 한국 PII가 redact되지 않은 원본 그대로 원격으로 가는 사고 방지.
- `"throw"`: `AggregateError`로 즉시 실패. strict CI 모드에 적합.

기본값은 `"skip_remote"` — Phase 5 결정. 코드베이스의 `failure_policy: "closed"`와 함께 사용 시 외부 PIIRemover 레벨에서 fail-closed가 한 번 더 작동.

#### 4.3.6 pros

- 한국 PII는 절대 외부로 안 나감 (실제 보안 invariant, 테스트로 검증).
- 영문 PII 검출 정확도는 벤더 ML 모델에 위탁 — 자체 운영 부담 없음.
- DPA 있는 벤더면 컴플라이언스도 해결.

#### 4.3.7 cons

- 두 번의 동기 호출(local → remote)이므로 지연이 `local + RTT` 합.
- 한국 PII 검출 정확도는 100% local에 의존 (한국 이름 휴리스틱의 false negative는 벤더가 잡을 수 없음, 왜냐면 placeholder만 봐서).
- 토큰 비용 발생 (벤더 측).

#### 4.3.8 placeholder 동작 검증 방법

운영 단계에서 한국 PII가 실제로 누출되지 않음을 확인하려면:

1. 벤더 API 호출 로그를 벤더 측에서 받아서 검사 (request body 로깅 정책이 SLA에 포함되어 있다면).
2. 로컬 머신에서 `mitmproxy` 같은 도구로 TLS 핸드셰이크 우회 + request body 캡처 (디버그 환경에서만).
3. 단위 테스트 — `packages/core/tests/tiered-strategy.test.ts`의 보안 블록 4건이 mock remote backend로 동등한 검증 수행. CI에서 자동 실행.

3번이 가장 실용적 — 코드베이스 단계에서 invariant 위반을 차단.

#### 4.3.9 트러블슈팅

- "X-Vendor-Api-Key 헤더가 안 가는 것 같다" → `header_name`이 소문자로 정규화돼 전송됨(`x-vendor-api-key`). HTTP 헤더는 case-insensitive라 정상 동작.
- "벤더가 'invalid api key' 응답" → 토큰 만료 또는 잘못된 환경변수 이름. token_env로 가리키는 값 확인.
- "벤더 응답에 detection이 비어 있다" → 벤더 측에서 placeholder만 보고 추가 검출할 게 없는 경우. local 검출만 vault에 들어가는 것은 정상.
- "지연이 너무 길다" → `timeout_ms`를 5000ms 이상으로. 그래도 timeout이면 벤더 SLA 검토 또는 self-hosted로 이전 고려.

---

### 4.4 예시 4: mTLS 클라이언트 인증서 (Tier 2 + 사내 PKI)

사내 PKI가 발급한 클라이언트 인증서로 self-hosted PII 백엔드 인증. Bearer 토큰 대신 TLS 레이어에서 신원 확인.

#### 4.4.1 사전 작업

1. 사내 PKI에서 클라이언트 인증서 발급:
   - `client.crt` (PEM 또는 DER)
   - `client.key` (private key, PEM)
   - 옵션: passphrase로 암호화된 key 사용 시 passphrase

2. 파일 경로 확정 (예: `~/.pii-remover/client.crt`, `~/.pii-remover/client.key`). 권한 0600 권장.

3. passphrase가 있다면 환경변수로 등록:

```powershell
$env:PII_CLIENT_KEY_PASS = "키-passphrase"
```

passphrase는 직접 노출하지 않고 env 이름만 config에 적는다.

#### 4.4.2 설정

`.pii-remover.json`:

```json
{
  "backend": {
    "type": "single",
    "endpoint": "https://pii-backend.internal/redact",
    "trust_tier": "self_hosted",
    "auth": {
      "type": "mtls",
      "mtls": {
        "cert_path": "C:/Users/me/.pii-remover/client.crt",
        "key_path": "C:/Users/me/.pii-remover/client.key",
        "passphrase_env": "PII_CLIENT_KEY_PASS"
      }
    },
    "tls": {
      "verify": true,
      "ca_bundle_path": "C:/Users/me/.pii-remover/internal-ca.pem",
      "pinning": { "enabled": false, "sha256_fingerprint": null }
    },
    "timeout_ms": 3000,
    "retries": 1
  },
  "failure_policy": "closed"
}
```

POSIX 환경에서는 forward slash 경로(`/home/me/.pii-remover/client.crt`)로 쓰면 됨.

#### 4.4.3 동작

- 시작 시점: `buildFetchTlsExtension`이 cert/key 파일을 sync `readFileSync`로 즉시 읽음. 파일 부재 시 init throw — fetch 호출 시점이 아니라 backend instantiation 시점에 fail-closed.
- passphrase가 `PII_CLIENT_KEY_PASS` env에 있으면 in-memory `passphrase`로 전달. env 미설정 시 passphrase 없이 시도 (인증서가 평문 key면 동작).
- Bun: `fetch(url, { tls: { cert, key, passphrase, ca, rejectUnauthorized: true } })`.
- Node: `undici.Agent({ connect: { cert, key, passphrase, ca, rejectUnauthorized: true } })`를 `dispatcher`로.
- 서버 측은 mTLS handshake에서 클라이언트 인증서 검증. 인증 헤더 별도 설정 없음.

#### 4.4.4 에러 메시지 정책 (security)

- cert 파일 부재: `TLS mTLS: cert file not readable at '...' (fail-closed at init per ADR-0006). code=ENOENT` — 파일 경로 자체는 operator 입력값이라 echo, `e.message` 본문은 escape하지 않음 (`describeReadError`로 syscall code만 추출).
- passphrase 잘못됨: TLS handshake 실패. **passphrase 값은 어떤 에러 메시지에도 노출 안 됨** — 내부 변수에만 존재, error message에는 비포함.
- mTLS 설정에 cert_path만 있고 key_path 없는 경우: `buildTlsRuntimeConfig`가 init 시점에 throw — 두 경로 모두 필수.

#### 4.4.5 pros

- TLS 레이어에서 신원 확인 → 애플리케이션 레이어 토큰 관리 부담 감소.
- 인증서 만료를 PKI가 중앙에서 관리 → 토큰 회전 인프라 불필요.
- 사내 PKI가 이미 있는 조직에서 자연스러운 통합.

#### 4.4.6 cons

- 인증서 발급 인프라 필요 (small/medium 조직에는 과한 운영 부담).
- 클라이언트 인증서가 디스크에 평문 저장 (passphrase로 일부 보호 가능, 그러나 passphrase 자체가 환경변수에 평문).
- 인증서 교체 시 모든 사용자 머신에 배포 자동화 필요.

#### 4.4.7 트러블슈팅

- "TLS mTLS: cert file not readable" 에러 — 경로 오타 또는 권한 문제. `Test-Path` 또는 `ls -l`로 확인.
- "code=ENOENT" — 파일 자체가 없음. 인증서 배포 누락.
- "code=EACCES" — 권한 부족. `chmod 600 ~/.pii-remover/client.key` 또는 Windows에서 사용자 읽기 권한 부여.
- 핸드셰이크가 성공하지만 백엔드가 403 — 클라이언트 인증서는 valid지만 백엔드 측 ACL이 거부. 인증서의 CN/SAN을 백엔드 ACL에 등록 필요.
- "key 파일이 암호화되어 있는데 passphrase가 안 통한다" — passphrase env 미설정 또는 다른 변수 이름 사용. 환경변수 이름 매칭 확인 후 셸 재시작.

#### 4.4.8 인증서 vs Bearer 토큰 — 어느 쪽을 쓸지

| 측면 | mTLS | Bearer |
|---|---|---|
| 신원 강도 | 강 (TLS 레이어) | 중 (HTTP 헤더) |
| 회전 자동화 | PKI 의존 (한 번 구축하면 자동) | 토큰 발급 시스템 의존 |
| 발급 운영 부담 | 높음 (PKI 인프라 필요) | 낮음 (간단한 토큰 시스템으로 가능) |
| 환경별 격리 | 인증서 분리 | 토큰 분리 |
| 유출 시 회복 | 인증서 revoke + 재발급 | 토큰 무효화 + 재발급 (빠름) |
| 디버깅 용이성 | 낮음 (TLS 레벨 에러는 모호) | 높음 (HTTP 401 명확) |

요약: 사내 PKI 있고 사용자 수가 많으면 mTLS, 그 외엔 Bearer가 운영 부담 적음.

---

## 5. 보안 권고

운영 단계에서 반복 확인할 체크리스트.

### 5.1 토큰 / passphrase 절대 평문 저장 금지

- `backend.auth.token`처럼 평문 토큰 필드는 schema에 **존재하지 않음**. 오직 `token_env`로 환경변수 이름만 참조 가능.
- mTLS passphrase도 `passphrase_env`로 환경변수 이름만. 평문 passphrase 필드 없음.
- 환경변수는 셸 RC 파일에 직접 적기보다 OS 시크릿 매니저(Windows Credential Manager, macOS Keychain, Linux secret-tool)나 1Password CLI 같은 도구로 주입 권장.
- CI runner에서는 secret-as-env 메커니즘 사용 (GitHub Actions `secrets`, GitLab CI `variables` masked).

### 5.2 TLS pinning은 production에서 강력 권장

- 사내망이라도 침해된 사내 PKI를 통한 MITM 공격 가능 → pinning이 보조 방어선.
- 벤더가 인증서 공표 정책을 가지고 있다면 무조건 활성화. 공표 정책이 없으면 pinning은 불가 (인증서 교체 시 깨짐).
- pinning fingerprint 정규화: `normalizeFingerprint`가 colon-separated / concatenated / 대소문자 / 공백 모두 통합. 그대로 `openssl x509 -fingerprint -sha256` 출력을 붙여 넣어도 동작.

### 5.3 mTLS는 사내 PKI가 있을 때만

- mTLS는 인증서 발급/회전/배포 인프라 없이는 운영 비용이 검증된 가치를 초과.
- 사내 PKI 없이 mTLS를 흉내내려고 self-signed cert를 손으로 배포하는 시나리오는 **금지** — 회전이 어렵고, 인증서 유출 시 사고 회복이 사실상 불가능.
- mTLS와 Bearer를 동시에 쓰는 것은 boundary 중복이지만, 무해함. Tier 2에서 인증 강도를 올리고 싶을 때 옵션.

### 5.4 `tls.verify: false`는 개발 전용

- self-signed cert 환경에서 임시로 도구를 돌릴 때만 사용.
- production config에 `verify: false`가 남아 있으면 MITM 공격에 완전히 노출.
- `buildFetchTlsExtension`은 `verify: false`인 경우에도 pinning callback은 정상 동작 (§4.2의 fingerprint 검증을 보조 방어선으로 활용 가능).

### 5.5 TieredStrategy placeholder는 보안 invariant — 길이 보존

- `redactSpans`는 placeholder × span length로 치환하여 **원본과 동일 길이**의 redacted 텍스트를 만듦.
- 길이가 보존되지 않으면 원격이 반환한 detection offset이 원본 텍스트와 어긋남 → 후속 merge 단계에서 잘못된 substring을 vault에 저장 → 복원 실패 또는 데이터 무결성 깨짐.
- placeholder는 default `\u00B7` (middle dot). 커스텀하려면 `TieredStrategyOptions.placeholder_char`로 단일 UTF-16 코드 단위만 허용 (multi-char 시 init throw).

### 5.6 4-Tier는 self-declared metadata — 백엔드 자기보고 무시

- `BackendClient.trust_tier`는 **클라이언트가 선언한 값**이 ground truth.
- 만약 백엔드 응답에 `trust_tier: "local"`이라 적혀 있어도 client config의 선언만 진실. ADR-0005 §2.5와 일관.
- 감사 로그에 trust_tier가 기록되면 그 값은 client config 출처. 백엔드 응답 출처가 아님.

### 5.7 `failure_policy: "closed"`와 함께 사용

- `failure_policy: "closed"` ([ADR-0006](./ADR/0006-fail-closed-default.md))는 TLS 핸드셰이크 실패 / 토큰 인증 실패 / 백엔드 다운 등을 모두 사용자 가시 에러로 변환.
- `failure_policy: "hybrid"`는 원격 실패 시 `LocalRegexBackend`로 fallback. 한국 PII는 fallback에서도 잡힘 — 영문 PII만 누락 위험.
- `failure_policy: "open"`은 detection을 그냥 건너뜀 → **production 금지**.

### 5.8 토큰 회전 정책

- Bearer 토큰은 단기 TTL + 자동 회전 권장. `token_env` 메커니즘은 토큰 교체 시 프로세스 재시작만으로 반영.
- 회전 빈도는 위협 모델에 따라: 사내망 90일, 인터넷 노출 30일 정도가 흔한 기준.
- 토큰 유출 의심 시 즉시 환경변수 갱신 + 백엔드 측 토큰 무효화.

### 5.9 감사 로그(audit log) 권고

- `pii-remover`는 v1에서 audit log를 기본으로 출력하지 않음 (opt-in 원칙).
- 운영 시 권장:
  - `logging.level: "info"` 이상으로 설정.
  - 호스트 통합 레이어(OpenCode plugin / Claude Code hook)에서 마스킹 호출 빈도, backend_name, trust_tier 등을 로그로 남기되 PII는 절대 미포함.
  - bypass 발동 빈도 추적 — `getBypassCount()` 함수 (`policy/bypass.ts`)로 query 가능. 잦은 bypass는 도구 무력화 신호.

### 5.10 본 도구가 보호하지 않는 PII 유형

- 음성, 영상, 이미지 내 PII는 v1 미지원. Phase 6의 vision 통합 후 처리. ([ADR-0009](./ADR/0009-vision-multimodal-v2.md))
- 첨부 파일(PDF 등) 내 PII는 미지원. Phase 6 이후.
- Binary 데이터, base64 인코딩된 PII는 미지원 — 텍스트 디코딩 후 마스킹 워크플로 외부에서 처리 필요.
- DB 연결 문자열, S3 URI 등에 임베드된 secret은 일부 패턴만 잡음. 종합적 secret detection은 별도 도구(예: detect-secrets) 권장.

### 5.11 인증서 / 토큰 누출 시 응급 절차

1. **즉시 폐기**: 의심되는 인증서를 백엔드 측에서 revoke. 토큰은 백엔드에서 무효화.
2. **로그 분석**: 마지막 valid 사용 시각부터 폐기 시점까지의 호출 로그를 백엔드에서 추출 → 비정상 호출 식별.
3. **사용자 통지**: 영향 받은 사용자에게 신규 토큰 / 인증서 발급 + 환경변수 갱신 안내.
4. **사후 분석**: 누출 경로 추적 (셸 히스토리, CI 로그, 디스크 백업 등).
5. **정책 갱신**: 재발 방지를 위한 회전 주기 단축 또는 더 엄격한 인증 방식 검토.

---

## 6. TLS 옵션 레퍼런스

`backend.tls` 및 `backend.auth.mtls` 필드 전체.

| 옵션 | 타입 | 기본값 | 설명 | 권장 사용 |
|---|---|---|---|---|
| `tls.verify` | `boolean` | `true` | 서버 인증서 chain 검증 활성화. false 시 self-signed cert도 허용. | production 항상 `true`. dev 임시 시나리오만 `false`. |
| `tls.ca_bundle_path` | `string \| null` | `null` | 커스텀 CA 번들 PEM 파일 경로. null이면 시스템 trust store 사용. | 사내 PKI 사용 시 필수. 외부 SaaS는 보통 불필요. |
| `tls.pinning.enabled` | `boolean` | `false` | SHA-256 fingerprint pinning 활성화. | Tier 2~4 권장. 벤더 공표 정책 있어야 운영 가능. |
| `tls.pinning.sha256_fingerprint` | `string \| null` | `null` | pinning 대상 fingerprint. colon-separated / concatenated / 대소문자 모두 허용. | `pinning.enabled: true`일 때 필수. |
| `auth.type` | `"none" \| "bearer" \| "api_key" \| "mtls"` | `"none"` | 인증 방식. | Tier에 따라 선택. |
| `auth.token_env` | `string` | (해당 없음) | bearer/api_key 시 토큰을 담을 환경변수 이름. | 평문 토큰 절대 금지 — 항상 env 이름. |
| `auth.header_name` | `string` | bearer는 `"Authorization"`, api_key는 `"x-api-key"` | 커스텀 헤더 이름. | 벤더가 X-Custom-Header 같은 비표준 이름 요구 시. |
| `auth.mtls.cert_path` | `string` | (해당 없음) | 클라이언트 인증서 PEM 파일 경로. | mTLS 사용 시 필수. |
| `auth.mtls.key_path` | `string` | (해당 없음) | 클라이언트 private key PEM 파일 경로. | mTLS 사용 시 필수. |
| `auth.mtls.passphrase_env` | `string` | (선택) | passphrase로 암호화된 key 사용 시 passphrase env. | 평문 key 사용 시 생략 가능. |
| `timeout_ms` | `number` | `2000` | 단일 HTTP 호출 timeout. | RTT가 큰 vendor는 3000-5000ms. |
| `retries` | `number` | `1` | transient error(5xx, 네트워크 오류, AbortError) 재시도 횟수. 4xx는 재시도 안 함. | Tier 2~3 권장 1-2, Tier 4는 0-1. |

### 6.1 fingerprint 형식 자동 정규화

`normalizeFingerprint`는 다음 입력을 모두 동일하게 취급:

```
AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
AA BB CC DD EE FF ... (whitespace 포함)
aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99
```

normalize 결과: colon 제거 + lowercase + whitespace 제거. strict 비교 전 양쪽 모두 정규화.

### 6.2 환경변수 의미 (token_env / passphrase_env)

`token_env: "VAR_NAME"`은 `process.env["VAR_NAME"]`에서 값을 읽는다. 다음 시점에 평가:

- `RemoteHttpBackend` instantiation 시점 (`buildRemoteAuth`에서 sync). 미설정 시 즉시 throw — fail-closed.
- 환경변수 값이 빈 문자열도 미설정으로 간주.

mTLS `passphrase_env`는 한 단계 더 lazy:

- `buildFetchTlsExtension` 호출 시점(=첫 detect 호출)에 평가.
- 환경변수 미설정 또는 빈 문자열이면 passphrase 없이 진행 — 평문 key 시나리오 지원. Tigers 환경에서는 fail-closed가 더 안전할 수 있으나, ADR-0005 결정에 따라 opt-in으로 처리.

---

## 7. 런타임 호환성

`pii-remover`는 Bun 1.0+, Node 18+에서 동작. TLS 옵션 처리는 두 런타임이 다르다 — `buildFetchTlsExtension`이 분기.

### 7.1 Bun 1.3+ — 네이티브 TLS 옵션

- `fetch(url, { tls: { ... } })`을 공식 지원 (`BunFetchRequestInitTLS`).
- 지원 필드: `cert`, `key`, `ca`, `passphrase`, `rejectUnauthorized`, `checkServerIdentity`.
- `checkServerIdentity` 콜백 시그니처: `(hostname: string, cert: PeerCertificate) => undefined | Error`.
- `pii-remover`가 Bun을 감지하면 (`globalThis.Bun !== undefined`) 자동으로 이 경로 사용.

### 7.2 Node 18+ — undici Agent + dispatcher

- 글로벌 `fetch`는 내부적으로 undici 기반. `fetch(url, { dispatcher: agent })` 형식으로 커스텀 TLS 설정 가능.
- `agent = new undici.Agent({ connect: { cert, key, ca, passphrase, rejectUnauthorized, checkServerIdentity } })`.
- **단**: Node 18-24에서 `undici` 모듈은 사용자 코드에서 `import 'undici'`로 노출되지 않음 (Node 내부 번들). 사용자가 `npm install undici`로 명시 설치 필요.
- 미설치 시 `buildFetchTlsExtension`은 다음과 같이 처리:
  - `tls.verify: true` + pinning/mTLS/custom CA 모두 미설정: 별도 dispatcher 없이 default fetch 사용 (TLS는 시스템 trust store 기반).
  - pinning/mTLS/custom CA 중 하나라도 설정: throw — `TLS: undici Agent is required for non-default TLS in Node runtime but 'undici' module is not importable`.
- Bun 런타임이 더 매끄러움 — 별도 설치 불필요.

### 7.3 `NODE_EXTRA_CA_CERTS` 환경변수 (양 런타임 모두 자동 인식)

- Node와 Bun 모두 부팅 시 `NODE_EXTRA_CA_CERTS` 환경변수가 가리키는 PEM 파일을 시스템 trust store에 추가.
- `tls.ca_bundle_path`를 명시하지 않아도 사내 root CA 인증서를 이 방식으로 신뢰 가능.
- `pii-remover`는 `NODE_EXTRA_CA_CERTS`를 직접 다루지 않음 — 런타임이 알아서 처리.

### 7.4 SHA-256 fingerprint 정규화

- `cert.fingerprint256`은 콜론 구분 대문자 16진수 (예: `AA:BB:...`).
- 사용자 설정의 fingerprint는 임의 형식 가능 → `normalizeFingerprint`로 통합 후 strict equality.
- 빈 문자열, whitespace만 있는 문자열은 fail-safe로 일치 안 함 (false 반환). 우연한 매치 방지.

### 7.5 인증서 파일 형식

- Bun과 undici 모두 PEM 형식 권장.
- DER 형식도 일부 시나리오에서 동작하나 PEM이 표준.
- private key는 unencrypted 또는 passphrase-encrypted 둘 다 지원. passphrase는 `mtls.passphrase_env`로.

### 7.6 Bun-only 시 운영 권장 — 단순화

mTLS / pinning / custom CA 중 하나라도 쓸 계획이면 Bun 런타임 사용을 강력 권장:

- `npm install undici` 같은 추가 단계 불필요.
- 동일 코드가 Bun 환경에서는 직접 동작 — 별도 환경별 설정 분기 없음.
- Bun 1.3+ 설치만 보장하면 됨.

Node 환경 강제 시:

- `npm install undici` (Node 24 기준 `undici@7.x` 권장).
- 또는 모든 TLS 옵션을 비활성화하고 시스템 trust store + `NODE_EXTRA_CA_CERTS`만 사용 → pinning/mTLS 불가.

### 7.7 fetch_impl 주입 — 테스트와 디버그

`RemoteHttpBackend`는 `fetch_impl` 옵션으로 fetch 함수 직접 주입 가능:

- 테스트: mock fetch로 모든 호출 캡처 (실제 네트워크 호출 없이 검증).
- 디버그: wrapper fetch로 모든 요청 / 응답을 로그로 (PII 미포함 확인 후).
- 프록시: HTTPS_PROXY 환경 변수 외에 직접 fetch 구현체를 갈아끼우는 시나리오.

기본값은 글로벌 `fetch`. 변경 시 TLS 옵션은 사용자 fetch_impl이 알아서 처리해야 함 — `tls` / `dispatcher` 키를 무시하면 보안 옵션이 동작 안 함.

### 7.8 호스트 통합과의 관계

`pii-remover/core`의 backend 설정은 다음 통합 레이어에서 공유:

- `@pii-remover/opencode-plugin`: OpenCode plugin 환경의 config loader가 같은 schema 사용.
- `@pii-remover/cli`: Bun compile 단일 바이너리. 같은 schema에서 backend 옵션 로드.
- `@pii-remover/proxy`: LLM 프록시. core를 임베드하므로 동일 backend 설정 적용.

따라서 한 곳에서 trust tier를 결정하면 모든 통합 레이어에서 같은 보안 보장. 호스트별로 backend tier가 달라지지 않음.

---

## 8. 알려진 한계

### 8.1 mTLS + pinning 조합 시 일부 환경에서 ECONNRESET 가능

- 일부 TLS termination 프록시(예: AWS NLB, Azure Application Gateway)는 mTLS + 클라이언트 측 pinning 조합에서 핸드셰이크 완료 직후 connection reset을 일으킬 수 있음.
- 백엔드를 직접 운영하는 Tier 2에서는 거의 발생하지 않음.
- 발생 시: `transient_network_error`로 분류되어 `retries` 횟수만큼 재시도 후 fail. CA bundle을 명시적으로 지정하면 해결되는 경우가 있음.

### 8.2 Bun에서 secureConnect post-hook 불가

- Node에서는 `tls.connect`의 `secureConnect` 이벤트로 추가 인증서 검증 hook 가능.
- Bun에서는 동등한 hook이 없음 — `checkServerIdentity` 콜백이 유일한 lifecycle 지점.
- 결과: pinning 외 추가 검증(예: CT log 확인, OCSP stapling 검사 등)이 Bun에서는 불가. Node + undici 환경으로 우회 가능하나 운영 복잡도 증가.

### 8.3 undici user-space 설치 필요할 수 있음

- 위 §7.2에서 설명한 대로 Node 18-24는 undici를 사용자 코드에 노출하지 않음.
- pinning/mTLS/custom CA 중 하나라도 쓰는 Node 시나리오는 `npm install undici` 필요.
- Bun 환경은 영향 없음.

### 8.4 `TieredStrategy`는 추가 backend 합성 미지원

- `PIIRemoverInitOptions.backends`로 외부 backend를 주입하는 메커니즘과 `backend.type: "tiered"`를 동시에 쓸 수 없음 — init 시점에 throw.
- 이유: tiered의 보안 모델(local → placeholder → remote) 위에 임의의 추가 backend를 합성하면 한국 PII 누출 invariant가 깨질 수 있음. 미래 확장에서 명시적 strategy composition API로 해결 예정.

### 8.5 한국 이름 휴리스틱 false negative는 placeholder 보호 밖

- `LocalRegexBackend`가 잡지 못한 한국 이름(흔치 않은 성씨, 두 글자 이름 등)은 placeholder로 치환되지 않음.
- Tier 3/4 시나리오에서 이런 이름은 redacted 텍스트에 그대로 남아 원격으로 전송됨.
- 완화: surname list 확장, stopwords 갱신, 또는 Phase 7의 KLUE-NER 통합 ([ADR-0007](./ADR/0007-korean-pii-strategy.md)).

### 8.6 OpfHttpBackend vs RemoteHttpBackend 자동 라우팅

- `buildRemoteBackend`는 endpoint가 `localhost` 또는 `127.0.0.1`이면 자동으로 `OpfHttpBackend`를 사용 (auth가 none/bearer이고 TLS 옵션 없을 때).
- 그 외 모든 경우는 `RemoteHttpBackend`.
- 라우팅 결정은 `isOpfWireEndpoint` 정규식 한 줄에 의존. URL을 `localhost`가 아닌 `[::1]`이나 hostname alias로 적으면 `RemoteHttpBackend` 경로로 빠짐. 기능 차이는 거의 없으나 default 동작이 달라질 수 있음.

### 8.7 TLS 옵션은 backend init 시점에 한 번만 로드

- cert/key/CA 파일을 변경해도 프로세스 재시작 전까지는 새 내용 반영 안 됨.
- 인증서 핫 리로드는 v1 미지원. 회전 시 프로세스 재시작 필요.

### 8.8 retries는 transient만 — 인증 실패는 즉시 fail

- 401/403/404 등 4xx는 재시도 안 함 — 토큰 잘못 설정 / endpoint 잘못 등은 빨리 fail해야 사용자가 알아챔.
- 5xx + 네트워크 오류(`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENETUNREACH`, `AbortError`)만 retry.
- `retries: 0`으로 명시하면 재시도 자체 비활성.

### 8.9 retries backoff 없음

- 현재 재시도는 즉시 재시도. 지수 backoff 없음.
- 백엔드가 rate limit으로 5xx를 반환하는 경우 재시도가 오히려 상황 악화 가능. 그래도 `retries: 0`으로 비활성화하거나 작은 값 권장.
- 향후 backoff + jitter 추가는 v1.x 후보.

### 8.10 timeout은 전체 호출 단위 — 핸드셰이크 별도 제어 불가

- `timeout_ms`는 fetch 전체 lifecycle에 적용 (DNS → TCP → TLS → HTTP request/response 모두 포함).
- TLS 핸드셰이크 단계만 별도 timeout 지정 불가. 핸드셰이크 느린 환경에서는 `timeout_ms`를 넉넉히 잡아야 함.

### 8.11 placeholder character 가시성

- `\u00B7` (middle dot)는 ASCII 텍스트 환경에서 일부 폰트로는 거의 공백처럼 보임 → 사용자가 redaction이 일어났는지 시각적으로 모를 수 있음.
- 디버그 환경에서 가시성 높이려면 `placeholder_char: "X"` 같은 ASCII 문자 사용.
- 운영에서는 default `\u00B7` 권장 (벤더 API가 ASCII X 시퀀스를 검출 trigger로 잘못 인식할 가능성 회피).

### 8.12 한국어 명확하지 않은 PII (예: 닉네임)

- 닉네임, 사용자명, 회사 내부 코드명 등은 PII 정의가 모호. LocalRegexBackend는 잡지 않음.
- Tier 3/4의 벤더 ML 모델이 이런 모호한 케이스를 어떻게 처리하는지는 벤더 의존.
- 회사 정책에 따라 카테고리 확장이 필요하면 [ADR-0010](./ADR/0010-pii-categories-opf-plus-korean.md) 검토 + 커스텀 detector 추가 (custom recognizer는 v2 후보).

---

## 9. 관련 ADR 및 코드

### 9.1 ADR 참조

| ADR | 주제 | 본 문서와의 관계 |
|---|---|---|
| [ADR-0005](./ADR/0005-backend-strategy-trust-tiers.md) | Backend Strategy 인터페이스 + 4-Tier 신뢰 모델 | 본 문서의 결정 베이스. |
| [ADR-0006](./ADR/0006-fail-closed-default.md) | fail-closed default + opt-in bypass | TLS init 실패 / 토큰 부재 시 동작 정의. |
| [ADR-0008](./ADR/0008-detection-backend-self-built-docker.md) | 자체 OPF Docker 이미지 빌드 (gh0stkey API 호환) | Tier 1(local) 시나리오의 표준 백엔드. |
| [ADR-0010](./ADR/0010-pii-categories-opf-plus-korean.md) | PII 카테고리 OPF 8 + 한국 확장 3 | placeholder 치환 대상 카테고리. |

### 9.2 코드 참조 — Phase 5 산출물

| 파일 | 책임 |
|---|---|
| `packages/core/src/backend/tls.ts` | TLS 런타임 옵션 빌더. `buildFetchTlsExtension`, `buildPinningCheckServerIdentity`, `normalizeFingerprint`, `fingerprintMatches`, `isBunRuntime`. |
| `packages/core/src/backend/remote-http.ts` | `RemoteHttpBackend`. 임의 원격 HTTPS endpoint 지원. none/bearer/api_key/mtls auth + TLS 헬퍼 통합. |
| `packages/core/src/backend/tiered-strategy.ts` | `TieredStrategy` + `redactSpans`. Phase 5 보안 invariant 구현체. |
| `packages/core/src/backend/opf-http.ts` | `OpfHttpBackend`. Tier 1 localhost 시나리오 (자동 라우팅). |
| `packages/core/src/backend/local-regex.ts` | `LocalRegexBackend`. 모든 tiered 모드의 local 단계. |
| `packages/core/src/backend/strategy.ts` | `SingleStrategy`, `MergeStrategy`, `mergeDetections`. |
| `packages/core/src/backend/client.ts` | `BackendClient` + `BackendHealth` 인터페이스. |
| `packages/core/src/config/schema.ts` | `BackendConfig`, `BackendAuthConfig`, `BackendAuthMtlsConfig`, `BackendTlsConfig`. `DEFAULT_CONFIG`는 Tier 1 가정. |
| `packages/core/src/pii-remover.ts` | `buildDefaultStrategy` — 위 모든 backend를 config에 따라 조립. tiered/api_key/mtls 분기. |

### 9.3 코드 참조 — 테스트

| 파일 | 검증 내용 |
|---|---|
| `packages/core/tests/tls.test.ts` | fingerprint normalize/compare, Bun/Node 분기, fail-closed init, 에러 메시지 비누출. |
| `packages/core/tests/remote-http.test.ts` | bearer/api_key/mtls 헤더, 401 비누출, 4xx 즉시 fail / 5xx 재시도, timeout, dual-key 응답 파싱. |
| `packages/core/tests/tiered-strategy.test.ts` | Korean PII 누출 방지(4건), local-failure 정책, remote-failure fallback, placeholder 길이 보존, merge 우선순위. |

### 9.4 외부 참조

- Bun fetch TLS 옵션: <https://bun.sh/reference/globals/BunFetchRequestInitTLS>
- undici Agent: <https://undici.nodejs.org/#/docs/api/Agent>
- TLS 1.2+ minimum: RFC 8446 (TLS 1.3) — production 권장.
- SHA-256 fingerprint 추출: `openssl x509 -fingerprint -sha256 -noout`.

### 9.5 운영 메모 — 도입 단계별 권고

| 시점 | 추천 행동 |
|---|---|
| 초기 도입 | Tier 1 (LocalRegexBackend만) — 검출 정확도 측정 + false positive 점검. |
| 1-2주 사용 후 | 영문 PII 누락이 신경 쓰이면 OPF Docker 컨테이너 추가 (여전히 Tier 1). |
| 팀 단위 확산 | Tier 2 + Bearer 검토. 사내 GPU 인프라 가용성 확인. |
| 컴플라이언스 요구 발생 | 4-Tier 신뢰표를 컴플라이언스 팀에 공유 + 적합한 Tier 선택. |
| 인증서 회전 시점 | 운영 메모 + fingerprint 갱신 절차 자동화. |
| 토큰 유출 사고 | §5.11 응급 절차 실행 + 사후 분석. |

### 9.6 본 문서 갱신 정책

- 본 문서는 **운영 가이드** — 결정 자체는 ADR-0005에서 관리. ADR이 바뀌면 본 문서도 영향 받음.
- 새 Tier 추가, 새 인증 방식 추가, 새 TLS 옵션 추가 시 본 문서의 §2, §4, §6에 반영.
- 트러블슈팅 사례 수집 시 §4의 각 예시 트러블슈팅 절에 누적.
- 운영팀에서 자주 받는 질문은 별도 FAQ 섹션으로 분리 검토.

### 9.7 본 문서가 다루지 않는 주제

다음 주제는 별도 문서에서:

- 한국 PII 검출 알고리즘 자체: [KOREAN_PII.md](./KOREAN_PII.md)
- 토큰 형식 및 vault 스키마: ADR-0002, ADR-0003
- 마스킹 / 복원 라운드트립 전체 흐름: [ARCHITECTURE.md](./ARCHITECTURE.md)
- 호스트별 통합 (OpenCode plugin, Claude Code hook): 각 패키지의 README
- 프록시 SSE 스트리밍 변환: ADR-0004 + ARCHITECTURE.md §12

본 문서는 backend trust tier 운영에만 집중한다.
