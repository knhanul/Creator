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
| `src/main/index.ts` | `gemini:status`, `gemini:ping`, `gemini:submit` IPC |
| `src/preload/index.ts` | `window.studio.gemini` 노출 |
| `src/renderer/App.tsx` | 환경 설정 → AI 연결 UI |

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
| 3 | 프롬프트 자동 전송 / 응답 수집 | 실험적 구현 (DOM 셀렉터 미검증) |
| 4 | 작업 큐·복구·기존 저장 연동 | 구조만 준비 |
| 5 | 이미지/영상/음악 생성 | 미구현 (검증 후 확장) |

## 미검증 항목 (실환경 필요)

- 실제 Chrome에서 Native Host 등록 및 `connectNative` 성공
- PING/PONG 왕복이 Electron UI까지 도달하는지
- Gemini 탭 실제 감지
- 입력창 셀렉터 동작 여부 (실험적)
- 응답 텍스트 추출
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
