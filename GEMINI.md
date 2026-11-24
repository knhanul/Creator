# GOMO Create — Chrome Native Messaging Gemini 연동

## 개요

일반 Chrome에서 사용자가 직접 로그인한 Gemini 탭과 GOMO Create를 Native Messaging으로 연결합니다.

- Electron 실행 파일 자체를 Native Host로 등록하지 않습니다.
- localhost HTTP 서버를 사용하지 않습니다.
- Google 로그인 자동화·프로필 추출·WebView 임베딩을 하지 않습니다.
- 연결 실패 시에도 기존 기능은 정상 동작합니다.

## 구성 요소

| 경로 | 역할 |
|------|------|
| `extension/` | Chrome Manifest V3 확장 프로그램 |
| `native-host/host.mjs` | Native Messaging Host (stdin/stdout + Named Pipe) |
| `native-host/register.mjs` | Windows HKCU 레지스트리 등록/해제 |
| `src/shared/gemini-protocol.ts` | 공통 메시지 타입 |
| `src/main/gemini/adapter.ts` | Gemini Provider Adapter |
| `src/main/gemini/pipe-client.ts` | Electron ↔ Host Named Pipe 클라이언트 |
| `extension/gemini-selectors.js` | Gemini 화면 셀렉터 중앙 목록 (근거·검증 여부 표기) |
| `extension/gemini-dom.js` | 입력·전송·전송 증거·신규 응답 분리·완료 판별·선택자 진단 |
| `src/main/gemini/analysis-service.ts` | 「AI 기획 분석 시작」: 프롬프트 생성 → 큐 → 전송 → 응답 검증 → 작품 저장 |
| `src/shared/gemini-analysis.ts` | JSON 후보 선택·덮어쓰기 방지 판단·UI 단계·오류 안내 |
| `src/main/index.ts` | `gemini:status`, `gemini:ping`, `gemini:submit`, `gemini:analysis:*`, `gemini:probe` IPC |
| `src/preload/index.ts` | `window.studio.gemini` 노출 (`analysis`, `probe`, `onJobUpdate`) |
| `src/renderer/App.tsx` | 환경 설정 → AI 연결 UI(선택자 진단), 기획 분석 진행 배너 |
| `src/renderer/components/AIDialog.tsx` | 기획 분석 자동화 모달 (수동 연결은 접힌 보조 기능) |

## 개발 환경 실행

```bash
npm install
npm run dev
```

### Native Host 등록 (Windows)

```bash
npm run native:register
# 확장 프로그램 ID를 아는 경우
npm run native:register -- --extension-id=YOUR_EXTENSION_ID
npm run native:check
npm run native:unregister
```

등록 위치: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.gomo.create`  
Host 식별자 `com.gomo.create`는 브랜드 표시 문자열과 분리되어 있습니다.

### Chrome 확장 프로그램 설치

1. Chrome에서 `chrome://extensions` 열기
2. 개발자 모드 켜기
3. "압축해제된 확장 프로그램을 로드합니다" → `extension/` 폴더 선택
4. 표시된 확장 프로그램 ID를 복사
5. `npm run native:register -- --extension-id=<ID>` 로 허용 목록 갱신
6. Chrome 재시작

### Gemini 로그인

일반 Chrome에서 https://gemini.google.com/ 에 직접 로그인합니다.  
GOMO Create는 로그인 정보를 저장하거나 추출하지 않습니다.

### 연결 확인

1. GOMO Create 실행
2. 환경 설정 → AI 연결
3. **연결 상태 확인** 또는 **테스트 요청 (PING)** 클릭

## Phase 완료 상태

| Phase | 내용 | 상태 |
|-------|------|------|
| 1 | Native Messaging 기반 (Host, Extension, Pipe, PING/PONG, UI) | 코드 구현 완료 |
| 2 | Gemini 탭 검색 및 상태 전달 | 코드 구현 완료 (실탭 미검증) |
| 3 | 프롬프트 자동 전송 / 응답 수집 (기획 분석) | 구현 완료 · jsdom 모형 테스트 통과 · **실제 Gemini DOM 미검증** |
| 4 | 작업 큐·복구·기존 저장 연동 | 구현 완료 (Mock Provider 테스트 12건 통과) |
| 5 | 이미지/영상/음악 생성 | 미구현 (검증 후 확장) |

## 기획 분석 자동화 흐름

1. 「AI 기획 분석 시작」 → main이 작품을 읽어 `makeAIPrompt(project,'analysis')`로 프롬프트 생성
2. Phase 4 작업 큐에 등록(jobId·requestId·projectId) → 같은 작품의 진행 중 작업이 있으면 새로 보내지 않음
3. 연결 확인(Host·확장·Gemini 탭) → `PROMPT_SUBMIT_REQUEST`(요청 표식 포함) → 확장 → Gemini 탭 content script
4. content script: 로그인/보안 확인/입력창 비어 있음 확인 → 입력 → 입력 확인 → 전송 → 전송 증거 확인(`sent`/`not_sent`/`uncertain`)
5. 표식이 붙은 질문 바로 뒤의 **새** 응답 블록만 감시 → 중지 버튼 사라짐 + 텍스트 안정 + (동작 버튼 표시) → 완료
6. `RESPONSE_RECEIVED` → jobId·requestId·projectId 모두 일치할 때만 수락 → 코드 블록/텍스트에서 JSON 후보 → `applyAIResponse`(creator.analysis.v1 검사)
7. 작품 정보가 바뀌었거나 더 새로운 결과가 있으면 자동 적용 보류(사용자 확인) → 아니면 저장 → 화풍·연출안 선택으로 이동
8. 전송 여부 불명·응답 시간 초과·연결 끊김·앱 재시작은 모두 `사용자 확인 필요`로 두고 **자동 재전송하지 않음**. 완료 응답은 확장 프로그램이 최근 5개를 보관해 「응답 다시 가져오기」로 재전송 없이 받을 수 있음

실기 검증 절차: [docs/GEMINI_AUTOMATION_CHECKLIST.md](docs/GEMINI_AUTOMATION_CHECKLIST.md)

## 버전 확인 (연결 확인 단계)

`git pull` 후 앱·Native Host·확장(서비스 워커)·Gemini 탭(content script)이 각각 따로 갱신되므로, 연결 확인 때 각자 자동화 프로토콜 값(`AUTOMATION_PROTOCOL = 2`)을 보고합니다.

- 앱 → Host: `HOST_INFO_REQUEST` (Host가 직접 응답, Chrome으로 넘기지 않음). 무응답 = 이전 Host → `HOST_OUTDATED`
- 앱 → 확장: `GEMINI_STATUS_RESULT.payload.extension.protocol`. 없음 = 이전 서비스 워커 → `EXTENSION_OUTDATED`
- 확장 → 탭: `PING_CONTENT` 응답의 `protocol`. 없음 = 이전 content script → `CONTENT_OUTDATED`
- 하나라도 맞지 않으면 **전송하지 않고** 무엇을 갱신할지 안내. 전송 결과 봉투에 jobId·projectId가 없으면(이전 확장) 성공이라고 해도 '전송 여부 불명'으로 처리.
- 갱신 절차: `docs/GEMINI_AUTOMATION_CHECKLIST.md` 0번.

## 미검증 항목 (실환경 필요)

- 실제 Chrome에서 Native Host 등록 및 `connectNative` 성공
- PING/PONG 왕복이 Electron UI까지 도달하는지
- Gemini 탭 실제 감지
- Gemini 셀렉터 42개 전부(입력창·전송·중지·질문/응답 블록·코드 블록·동작 버튼·로그인/보안 신호) — `선택자 진단`으로 확인
- 입력 방식(execCommand insertText / 합성 paste / input 이벤트) 중 실제로 Gemini(Quill)가 받아들이는 방식
- 응답 완료 판별 타이밍과 신규 응답 분리(요청 표식 방식)
- 응답 텍스트·코드 블록 추출
- Downloads API 연동
- Windows 설치 프로그램에서의 Host 자동 등록

## 오류 시 확인

- `npm run native:check` 로 레지스트리 확인
- `%USERPROFILE%\.gomo-create\native-host.log` 확인 (stdout에 로그를 쓰지 않음)
- Chrome 확장 프로그램 콘솔에서 `connectNative` 오류 메시지 확인
- 확장 프로그램 ID가 Host manifest `allowed_origins`와 일치하는지 확인

## 보안 원칙

- Renderer에서 Node 직접 접근 없음 (preload 경유)
- 수신 메시지 스키마 검사
- 임의 셸 명령 실행 없음
- Google 인증 정보 저장/추출 없음
- Content Script는 Service Worker를 통해서만 Host와 통신
