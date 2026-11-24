# GOMO Create — Theme System

## 구조

```
src/renderer/theme/
  themes.ts       # 4종 테마 정의 + 의미 기반 토큰
  useTheme.ts     # React 훅 (적용 / 저장 / 시스템 연동)
  theme.test.mjs  # 기본 검증 테스트
```

## 테마 4종

| ID | 이름 | 기본 |
|----|------|------|
| `light-blue` | 화이트 블루 | **기본값** |
| `warm-cream` | 웜 크림 | |
| `silver-light` | 실버 라이트 | |
| `dark` | 다크 | 기존 다크 유지 |

## 저장

- `localStorage['creator-theme']` — 사용자가 직접 선택한 테마
- `localStorage['creator-theme-system-sync']` — `1`이면 Windows 시스템 테마 연동
- 브랜드 변경(GOMO → NUNI)과 무관한 키 사용
- 손상된 값은 무시하고 `light-blue`로 폴백

## 초기 적용 (깜빡임 방지)

`src/renderer/index.html` 상단 인라인 스크립트가 React 마운트 전에 `data-theme`을 설정합니다.  
CSS에 `[data-theme="..."]` 블록이 정의되어 있어 첫 페인트부터 올바른 색상이 적용됩니다.

`BrowserWindow.backgroundColor`는 `#F8FAFC`(화이트 블루 배경)으로 설정되어 있습니다.

## 시스템 테마 연동

환경 설정 → 화면 테마에서 체크박스:

- ON: `prefers-color-scheme: dark` → 다크, 그 외 → 화이트 블루
- 실행 중 변경 시 즉시 반영 (`matchMedia` listener)
- OFF: 마지막 수동 선택 테마 유지

## 향후 고모 편집실(NUNI) 적용 가이드

1. `src/renderer/theme/themes.ts`와 `useTheme.ts`를 그대로 복사
2. `index.html`의 조기 적용 스크립트 복사
3. CSS에서 `var(--color-*)` 토큰만 사용하도록 유지
4. 저장 키(`creator-theme`)는 변경하지 않음 — 사용자 설정이 프로그램 간 공유됨
5. `BrowserWindow.backgroundColor`만 해당 앱 기본 테마에 맞게 조정

## 검증 상태

| 항목 | 상태 |
|------|------|
| 최초 실행 시 화이트 블루 | 코드상 보장 (DEFAULT_THEME) |
| 4종 전환 | UI 구현 완료 |
| 설정 유지 (localStorage) | 구현 완료 |
| 재실행 후 복원 | 구현 완료 |
| Windows 시스템 연동 | `matchMedia` 구현 |
| 손상 설정 폴백 | 구현 완료 |
| 작품 데이터 유지 | 테마는 앱 설정, 프로젝트와 분리 |
| typecheck / build | 환경 제약으로 미실행 (의존성 설치 지연) |
| 실제 Electron 화면 검증 | **미검증** |
