# 브랜드 변경 가이드 (GOMO → NUNI)

현재 사용자에게 보이는 제품군은 **고모 미디어공방**, 제품 이름은 **고모 창작실**입니다. 향후 NUNI로 바꿀 예정이므로 NUNI 이름/로고를 초기 UI·설치 화면에 노출하지 않습니다.

## 수정할 곳

1. `src/shared/brand.ts` — 브랜드 코드, 제품군·제품의 한글/영문 표시, 홍보 문구, 강조 색상.
2. `src/renderer/styles/app.css` — 토큰 이외의 고정 CSS 색상/로고를 브랜드 변수로 차차 정리.
3. `resources/brand-logo.svg` — 새 로고로 교체.
4. `package.json` — 설치 프로그램의 `productName` 변경 (필요 시 Windows 설치 관리 정책 검토).
5. `src/renderer/index.html` — 창 탭 제목(현재 브랜딩 직접 텍스트).

## 바꾸면 안 되는 값

- `StudioProject.id` UUID
- `schema=creator.project.v1`
- `schema=creator.handoff.v1`
- `userData`의 `creator-workspace` 저장 네임스페이스
- 파일 간 연결 ID, 미디어 상대 경로

Windows `appId` 변경은 이미 설치된 EXE의 업데이트와 데이터 이전에 영향을 줄 수 있으므로 기존 값을 유지하거나 버전 간 마이그레이션을 준비하세요.

### 다음 리팩토링 목표

실제 제품 디자인이 확정되면 `src/renderer/styles/tokens.css`와 React `BrandProvider`를 만들어 색상/아이콘/문구를 중앙에서 관리하고, GOMO/NUNI 프로필을 별도 JSON으로 분리합니다.
