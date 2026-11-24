# Gemini 기획 분석 자동화 — 실제 Chrome 검증 체크리스트

이 문서는 승희님 PC(Windows + 로그인된 Chrome + Gemini)에서 직접 확인할 항목입니다.
개발 환경(Linux)에서는 **jsdom으로 만든 Gemini 모형**과 **가짜 확장 프로그램**으로만 검증했습니다.
아래 항목을 통과하기 전까지 실제 Gemini 동작은 **미검증**입니다.

## 0. 준비 — `git pull` 할 때마다 (Windows)

앱·Native Host·확장 프로그램·Gemini 탭은 **각각 따로** 새 코드로 바뀝니다. 하나라도 이전 코드로 돌고 있으면
전에는 `jobId/requestId/projectId 누락` 같은 오류가 났고, 지금은 연결 확인 단계에서 무엇이 이전 버전인지 알려 주고 **보내지 않습니다**.

1. **저장소 갱신** — 저장소 폴더에서 PowerShell:
   ```powershell
   git pull
   npm install
   npm run build
   ```
2. **앱 완전히 종료 후 다시 실행** — 평소 실행 방식 그대로 (`npm run dev` 또는 `npm run preview`).
   설치한 exe를 쓰고 있다면 `npm run dist:win` 으로 만든 새 설치본을 다시 설치해야 합니다(이전 exe는 이전 코드).
3. **Chrome 확장 새로고침** — `chrome://extensions` (오른쪽 위 개발자 모드 켜기)
   - GOMO Gemini Connector 카드의 **↻ 새로고침**을 누릅니다.
   - 버전이 **0.2.1**인지 확인합니다. 다르면 다른 폴더를 불러온 것입니다 → 카드 「세부정보」의 「소스」 경로가
     `<저장소>\extension` 인지 확인하고, 아니면 제거 후 「압축해제된 확장 프로그램을 로드합니다」로 `<저장소>\extension` 을 다시 불러옵니다
     (이 경우 확장 ID가 바뀌므로 4번 필수).
   - 카드의 「서비스 워커」 링크 → 콘솔에 빨간 오류가 없는지 확인.
   - 카드에 표시된 **ID**(32자)를 메모해 둡니다.
   - 확장을 새로고침하면 Native Host도 새 코드로 다시 시작됩니다.
4. **Native Host** — 등록된 Host는 `%USERPROFILE%\.gomo-create\gomo-host.cmd` 가 **저장소의 `native-host\host.mjs`를 직접 실행**하는
   방식이라 `git pull` 만으로 코드가 바뀝니다(3번의 확장 새로고침으로 재시작). **다시 등록이 필요한 경우**: 저장소 폴더를 옮겼을 때,
   확장 ID가 바뀌었을 때, Node를 다시 설치했을 때, 또는 연결 확인에서 「Native Host가 이전 버전」이 계속 나올 때.
   ```powershell
   # 반드시 저장소 폴더에서 실행 (현재 폴더 기준으로 host.mjs 경로를 기록함)
   npm run native:register -- --extension-id=<3번에서 메모한 ID>
   npm run native:check
   type $env:USERPROFILE\.gomo-create\gomo-host.cmd   # 저장소의 native-host\host.mjs 경로인지 확인
   ```
   다시 등록했다면 Chrome을 **완전히 종료**(트레이 아이콘까지)한 뒤 다시 켭니다.
5. **Gemini 탭 새로고침** — 열려 있던 `gemini.google.com` 탭을 **F5**. 로그인 상태 확인, 입력창은 비워 둡니다.
6. **연결 상태 확인** — 앱 → 환경 설정 → AI 연결 → **연결 상태 확인**. 아래 「연결·진단 결과」가 이렇게 나와야 합니다:
   ```
   Gemini 탭이 감지되었습니다.
   앱 프로토콜 2
   Native Host: 0.2.1 (프로토콜 2)
   Chrome 확장: 0.2.1 (프로토콜 2)
   Gemini 탭 스크립트: 최신          (또는 "아직 없음(전송 때 자동 주입)")
   ```
   「이전 버전」/「응답 없음」이 보이면 그 줄 아래 **해결 방법**대로 한 뒤 다시 확인합니다.

| 화면 안내 코드 | 뜻 | 할 일 |
|---|---|---|
| `EXTENSION_OUTDATED` | 확장 서비스 워커가 이전 코드 | 3번 → 5번 |
| `CONTENT_OUTDATED` | Gemini 탭에 이전 스크립트 | 5번 |
| `HOST_OUTDATED` | Native Host가 이전 코드(버전 확인에 무응답) | 3번, 안 되면 4번 |
| `EXTENSION_OUTDATED_UNCERTAIN` | 이전 확장이 실제로 입력·전송했을 수 있음 | Gemini 화면 확인 → 「응답 기다리기」 또는 「다시 보내기」 (자동 재전송 없음) |

> 2026-11-24에 본 `jobId/requestId/projectId 누락` 오류는 **Gemini에 아무것도 입력·전송하지 않은 상태**에서 난 오류입니다.
> 위 0번을 마친 뒤 「AI 기획 분석 다시 시작」을 누르면 됩니다.

## 1. 선택자 진단 (아무것도 보내지 않음)

환경 설정 → AI 연결 → **선택자 진단 (전송 없음)** 클릭 → 결과 JSON의 **복사** 버튼으로 복사해 개발자에게 전달.

출력 형식(예):

```json
{
  "ok": true,
  "tab": { "id": 123, "title": "Gemini" },
  "report": {
    "kind": "gomo.selector-probe.v1",
    "selectorsVersion": "2026-11-24",
    "url": "https://gemini.google.com/app",
    "summary": {
      "composer": "rich-textarea [contenteditable=\"true\"][role=\"textbox\"]",
      "composerEmpty": true,
      "sendButton": "button[aria-label*=\"보내기\"]",
      "sendEnabled": false,
      "stopButton": null,
      "userQueries": 0,
      "modelResponses": 0,
      "signIn": false,
      "blocked": false
    },
    "groups": { "composer": [ { "selector": "...", "count": 1, "visible": 1, "verified": false } ], "...": [] }
  }
}
```

판정
- [ ] `summary.composer`가 null이 아님 (입력창 인식)
- [ ] `summary.sendButton`이 null이 아님 — 입력창이 비어 있으면 Gemini가 전송 버튼을 숨기거나 비활성화할 수 있으니, null이면 입력창에 글자 하나를 직접 쓴 상태로 한 번 더 진단(진단은 입력·전송하지 않음)
- [ ] 이전 대화가 있는 탭이면 `userQueries`/`modelResponses`가 대화 수와 맞음
- [ ] `signIn`=false, `blocked`=false
- [ ] Gemini 화면에 아무것도 입력·전송되지 않았음

## 2. 짧은 테스트 프롬프트 (먼저)

작품을 하나 새로 만들고 원문에 짧은 문장 2줄만 넣은 뒤 진행합니다(프롬프트가 짧아짐).

- [ ] 기획 분석 → **AI 기획 분석 시작** 한 번 클릭 → 모달이 열리고 단계가 `연결 확인 → 프롬프트 전송 중 → Gemini 응답 대기 → 응답 수집 중 → JSON 검증 중 → 분석 완료` 순으로 바뀜
- [ ] **탭 인식 후 실제 전송**: Chrome의 Gemini 탭이 앞으로 오고, 입력창에 프롬프트가 들어간 뒤 전송됨
- [ ] **Gemini 화면 전송 내용 확인**: Gemini 대화에 올라간 질문 끝에 `[GOMO 요청 xxxxxxxxxxxx · 이 줄은 답변에 쓰지 마세요]` 한 줄이 있고, 원문 줄바꿈이 보존됨
- [ ] **응답 완료 시점**: Gemini 답변이 다 끝난 뒤(중지 버튼이 사라진 뒤 약 3~5초) `JSON 검증 중`→`분석 완료`로 넘어감. 답변 도중에 완료로 넘어가지 않음
- [ ] 모달의 「Gemini 응답 원문 보기」에 이번 답변만 있음

## 3. 실제 작품 기획 프롬프트 (전체 자동화)

긴 원문이 있는 실제 작품으로 반복합니다.

- [ ] **이전 대화/신규 응답 구분**: 같은 Gemini 대화창에 이전 답변(특히 JSON 답변)이 있어도 이번 답변만 수집됨 (작업 ID가 응답 원문과 맞는지, 요약이 이번 작품 내용인지 확인)
- [ ] **JSON 추출·스키마 검사**: 응답 원문에 설명 문장이나 코드 블록이 섞여도 `분석 완료`가 됨. 실패 시 `오류 · Gemini 응답에서 올바른 creator.analysis.v1 JSON을 찾지 못했습니다`와 해결 방법이 보임
- [ ] **작품 데이터 반영**: `화풍·연출안 선택하기` 버튼 → 기획 분석 화면에 화풍 3안·연출 3안 표시. 앱을 껐다 켜도 유지
- [ ] **모달 닫기**: 진행 중에 모달을 닫아도 기획 분석 화면 상단에 `Gemini 기획 분석 · (현재 단계)` 배너가 보이고, 끝나면 자동 반영 + 알림 표시

## 4. 실패 상태 표시 (각 1회)

- [ ] Gemini 탭을 모두 닫고 시작 → `사용자 확인 필요 · 열려 있는 Gemini 탭이 없습니다` (아무것도 보내지 않음)
- [ ] Gemini 입력창에 글을 써 둔 채 시작 → `입력창에 작성 중인 내용이 있어 덮어쓰지 않았습니다` (쓰던 글 그대로)
- [ ] Gemini가 답변 생성 중일 때 시작 → `Gemini가 이전 답변을 아직 생성하고 있습니다`
- [ ] (가능하면) 로그아웃 상태 → `Gemini에 로그인되어 있지 않습니다`, 로그인 자동화 시도 없음
- [ ] Chrome 확장을 끈 상태 → `Chrome 확장 프로그램이 응답하지 않습니다` 또는 `Native Host가 앱에 연결되지 않았습니다`

## 5. 중복 전송 방지

- [ ] 「AI 기획 분석 시작」을 빠르게 두 번 클릭 → Gemini에 질문이 **한 번만** 올라감
- [ ] 진행 중 기획 분석 화면의 버튼은 `진행 상황 보기`로 바뀜
- [ ] `사용자 확인 필요(전송 여부 불명)` 상태에서 앱이 스스로 다시 보내지 않음. 「올라가지 않음 · 다시 보내기」를 눌러 확인창에 동의할 때만 재전송

## 6. 앱 재시작·연결 해제 시 보존

- [ ] 응답 대기 중 앱 종료 → 재시작 → 기획 분석 화면 배너 `사용자 확인 필요` → 모달의 「응답 다시 가져오기」(확장 프로그램에 보관된 응답 조회, 재전송 아님) → `분석 완료`
- [ ] 응답 대기 중 Chrome 확장 새로고침(연결 끊김) → `응답을 기다리는 중 Chrome 확장 연결이 끊겼습니다` 표시, 다시 연결되면 자동 조회
- [ ] 환경 설정 → Gemini 작업 큐에 작업 기록과 단계가 남아 있음

## 7. 회귀 (기존 기능)

- [ ] 작품 정보 수정·저장, 새 작품 만들기, 보관/복원
- [ ] 기획 분석 「상세·수동 연결」 → 「수동 연결 (복사·붙여넣기)」 펼치기 → 요청 복사 / JSON 붙여넣기 → 검사 후 적용
- [ ] 스토리보드·생성 프롬프트·최종 편집안의 AI 모달(수동 연결) 정상
- [ ] 화면 테마 4종(화이트 블루 기본, 웜 크림, 실버 라이트, 다크)에서 모달 색상 정상
- [ ] 환경 설정 → 연결 상태 확인 / 테스트 요청(PING) 정상

## 문제가 생기면

- 선택자 진단 결과 JSON + `%USERPROFILE%\.gomo-create\native-host.log` 마지막 부분
- Chrome `chrome://extensions` → GOMO Gemini Connector → 서비스 워커 콘솔 오류
- 셀렉터 수정은 `extension/gemini-selectors.js` 한 파일만 고치면 됩니다. 확인된 셀렉터는 `verified: true`로 바꿉니다.
