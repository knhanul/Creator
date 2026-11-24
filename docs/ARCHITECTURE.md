# 고모 창작실 아키텍처 v0.1

## 원칙

- UI는 새로운 Electron/React/TypeScript 데스크톱 애플리케이션으로 작성한다. 기존 HTML 프롬프트 제조기 화면을 재사용하지 않는다.
- UI와 엔진 로직, 파일 저장, AI 제공자 접근은 독립한다.
- AI 서비스는 교체 가능한 어댑터(`AIProviderAdapter`)로 정의하고, **현재는 수동 연결만 제공**한다.
- 스튜디오 자체에서 사람 목소리 녹음·FFmpeg 렌더링·Whisper 인식 기능을 구현하지 않는다. 기존 더빙 프로그램에 맡긴다.
- 가시적 브랜드 표시와 내부 프로젝트 식별자(`creator.project.v1`)를 분리한다.

## 계층

```text
Electron Renderer (React + TypeScript)
  ├─ 공통 디자인·화면 (src/renderer)
  ├─ useStudio() 데이터 연결
  └─ AI 워크벤치 (현재 수동 JSON)
          │ window.studio (한정된 IPC)
Electron Preload (src/preload)
          │ ipcRenderer ↔ ipcMain
Electron Main (src/main)
  ├─ 파일 복사/보관/내보내기
  ├─ custom gomo-asset:// 미디어 로드
  └─ 프로젝트 JSON 영구 저장
          │
Shared domain (src/shared)
  ├─ work item / schema / validation
  ├─ AI provider interface
  ├─ edit blueprint / dubbing draft export
  └─ brand configuration
```

## 로컬 파일 보안

- Electron `nodeIntegration=false`, `contextIsolation=true`, 새 창·외부 페이지 탐색 제한.
- 원본 사용자 파일은 `dialog.showOpenDialog`로 명시적으로 선택할 때만 **작품 폴더에 복사**.
- media protocol은 프로젝트에 등록된 UUID+media ID를 조회한 경우에만 로컬 파일 제공.
- 프로젝트 내부 저장 경로 검사로 traversal 방지.
- 저장 시 revision 검증으로 덮어쓰기 충돌 감지.
- 보관은 삭제가 아니다.

## 프로젝트 저장 스키마

`StudioProject` 타입은 `src/shared/types.ts`를 기준으로 한다. 문서는 타입/코드와 동기화할 것.

- `brief`: 권리 정보 포함 원문 및 타깃
- `analysis`: 작품 분석·화풍·연출 대안
- `selection`: 사용자가 최종 승인한 화풍/연출 ID
- `scenes`: 스토리보드, 생성 프롬프트, 참조 파일 ID
- `assets`: 프로젝트에 실제 복사된 물리 파일의 ID/경로
- `assembly`: 클립 순서/길이/전환/BGM/자막 정책
- `ai`: 단계별 원본 JSON과 검증 상태

AI 단계 JSON의 예시는 `fixtures/` 참조.

## 향후 Gemini 통합 설계

추가할 계층: `adapters/ai/` + `chrome-extension/` + Windows Native Messaging host.

```text
React Editor → Workflow Engine → AIProviderAdapter → Windows Native Host
                                                      ↕
                                  Chrome Extension → Gemini Web UI
```

먼저 연결 상태/프롬프트·JSON 왕복을 검증한 뒤 이미지/영상/음악 제어로 확장한다. 현재 **기획 분석 단계만** Gemini 자동 전송·응답 수집이 구현되어 있고(GEMINI.md), 실제 Gemini 화면에서의 검증은 docs/GEMINI_AUTOMATION_CHECKLIST.md 절차로 진행한다. Google 로그인·보안 확인·이용 제한은 우회하지 않는다.

## dubbing 출력

`toComposerDraft`는 사용자 요구에 맞는 파일을 준비하기 위한 독립 변환 함수다. 공개 README의 v2 JSON 필드를 참고했으나 모든 옵션·파일 형식을 실제 설치 프로그램과 통합 검증한 상태는 아니다. 구현 전용 예시로 취급하고 연동 테스트에서 개선할 것.
