/**
 * GOMO Gemini Connector — 중앙 셀렉터 목록 (이 파일만 고치면 셀렉터를 갱신할 수 있습니다).
 *
 * 원칙
 *  - 접근성 역할(role)·aria-label·커스텀 요소 태그·data-test-id 같은 안정 속성을 우선합니다.
 *  - CSS 클래스(.ql-editor, .send-button 등)는 마지막 대체 수단으로만 씁니다.
 *  - 각 그룹은 위에서부터 순서대로 시도하며, "보이는" 첫 요소를 사용합니다.
 *  - verified 값은 "승희님 PC의 실제 Gemini 화면에서 확인했는가"입니다.
 *    이 저장소 작성 시점(2026-11-24)에는 실제 Gemini DOM에 접근하지 못했으므로 전부 false(미검증)입니다.
 *    실제 Chrome에서 '선택자 진단'(SELECTOR_PROBE) 결과로 확인한 뒤 true로 바꾸세요.
 *
 * 근거(공개 오픈소스 자료, 2026년 기준)
 *  [A] terrylica/cc-skills gemini-deep-research selectors.ts — 2026-03-04 확인:
 *      입력창 div.ql-editor[contenteditable] aria-label="Enter a prompt for Gemini",
 *      전송 button[aria-label="Send message"].send-button, 마이크 button[data-node-type="speech_dictation_mic_button"],
 *      응답 MESSAGE-CONTENT .markdown
 *  [B] samucamg/chat-bridge-overdrive docs/SELECTORS.en.md — 2026-11-07 실계정 확인:
 *      응답 model-response, 중지 button[aria-label*="Stop"/현지화], 입력 rich-textarea [contenteditable="true"],
 *      button[data-test-id="send-button"|"stop-button"], 사고과정 model-thoughts 제외
 *  [C] Eshaan-Nair/ArcRift PLATFORM_SELECTORS.md — 2026-05: user-query / model-response 커스텀 태그가
 *      클래스보다 안정적, 전송 button[aria-label="Send message"]
 */
(function (root) {
  const S = (sel, basis, verified = false) => ({ sel, basis, verified });

  const SELECTORS = {
    /** 프롬프트 입력창 (Quill 기반 contenteditable) */
    composer: [
      S('rich-textarea [contenteditable="true"][role="textbox"]', '[A][B] 커스텀 요소 rich-textarea + ARIA textbox'),
      S('rich-textarea [contenteditable="true"]', '[B] 커스텀 요소 + contenteditable'),
      S('[contenteditable="true"][role="textbox"][aria-label*="Gemini"]', '[A] aria-label "Enter a prompt for Gemini" (영문 UI)'),
      S('[contenteditable="true"][role="textbox"][aria-label*="prompt" i]', '[A] aria-label 영문 변형'),
      S('[contenteditable="true"][role="textbox"][aria-label*="프롬프트"]', '한국어 UI aria-label 추정 (근거 없음, 진단 필요)'),
      S('[contenteditable="true"][role="textbox"]', 'ARIA textbox 일반'),
      S('div.ql-editor[contenteditable="true"]', '[A][C] Quill 클래스 — 클래스 의존 대체 수단')
    ],
    /** 전송 버튼 (중지 버튼과 구분해야 함) */
    sendButton: [
      S('button[data-test-id="send-button"]', '[B] data-test-id'),
      S('button[aria-label="Send message"]', '[A][B][C] 영문 aria-label'),
      S('button[aria-label*="Send" i]', '[A] 영문 aria-label 부분 일치'),
      S('button[aria-label*="보내기"]', '한국어 UI "메시지 보내기" 추정 (진단 필요)'),
      S('button[aria-label*="전송"]', '한국어 UI 변형 추정 (진단 필요)'),
      S('button.send-button:not(.stop)', '[A][C] 클래스 — 대체 수단')
    ],
    /** 응답 생성 중 표시(중지 버튼). 보이면 "생성 중"으로 판단 */
    stopButton: [
      S('button[data-test-id="stop-button"]', '[B] data-test-id'),
      S('button[aria-label*="Stop" i]', '[B] 영문 "Stop response"'),
      S('button[aria-label*="중지"]', '한국어 UI "대답 생성 중지" 추정 (진단 필요)'),
      S('button[aria-label*="멈추"]', '한국어 UI 변형 추정 (진단 필요)'),
      S('button.send-button.stop', '클래스 — 대체 수단')
    ],
    /** 대화의 사용자 질문 블록 */
    userQuery: [
      S('user-query', '[B][C] 커스텀 요소'),
      S('[data-message-author="user"]', '[C] 데이터 속성')
    ],
    /** 대화의 모델 응답 블록 */
    modelResponse: [
      S('model-response', '[B][C] 커스텀 요소'),
      S('[data-message-author="model"]', '[A] 데이터 속성')
    ],
    /** 응답 블록 안에서 본문 텍스트 영역 */
    responseBody: [
      S('message-content .markdown', '[A] message-content 커스텀 요소 안의 markdown'),
      S('message-content', '[A] 커스텀 요소'),
      S('.model-response-text', '[B] 클래스 — 대체 수단')
    ],
    /** 응답 안의 코드 블록 (JSON은 보통 여기 들어감) */
    codeBlock: [
      S('code-block code', '코드 블록 커스텀 요소 추정 (진단 필요)'),
      S('pre code', 'HTML 표준 구조'),
      S('pre', 'HTML 표준 구조')
    ],
    /** 응답 본문에서 제외할 영역 (사고 과정 등) */
    excludeFromText: [
      S('model-thoughts', '[B] 사고 과정 블록'),
      S('[data-test-id="thinking-content"]', '[B]'),
      S('.code-block-decoration', '코드 블록 머리글(언어명·복사 버튼) — 클래스'),
      S('button', '버튼 라벨 제외'),
      S('mat-icon', '아이콘 글꼴 텍스트 제외')
    ],
    /** 응답 완료 후 나타나는 동작 버튼(복사 등). 보조 완료 신호 */
    responseActions: [
      S('message-actions', '커스텀 요소 추정 (진단 필요)'),
      S('button[data-test-id="copy-button"]', 'data-test-id 추정 (진단 필요)'),
      S('button[aria-label*="Copy" i]', '영문 aria-label'),
      S('button[aria-label*="복사"]', '한국어 aria-label 추정')
    ],
    /** Phase 5: 응답 블록 안에 생성된 이미지 요소 */
    generatedImage: [
      S('single-image.generated-image img', 'Gemini single-image.generated-image 커스텀 요소 안의 img (진단 필요)'),
      S('generated-image img', 'Gemini 생성 이미지 커스텀 요소 안의 img (진단 필요)'),
      S('single-image img', 'Gemini 단일 생성 이미지 커스텀 요소 안의 img (진단 필요)'),
      S('[data-test-id="generated-image"] img', 'data-test-id="generated-image" 안의 img (진단 필요)'),
      S('[data-test-id*="generated-image"] img', 'data-test-id 생성 이미지 (진단 필요)'),
      S('image-preview img', '이미지 미리보기 커스텀 요소 안의 img (진단 필요)'),
      S('message-content img.image', '응답 본문 안의 img.image (진단 필요)'),
      S('message-content img[src^="data:image/"]', '응답 본문 안의 data:image 이미지'),
      S('message-content img[src^="blob:"]', '응답 본문 안의 blob: 이미지'),
      S('message-content img[src*="googleusercontent.com"]', '응답 본문 안의 Google 호스팅 이미지'),
      S('message-content img[src*="ggpht.com"]', '응답 본문 안의 Google 이미지'),
      S('model-response img[src]', '모델 응답 안의 일반 img (아이콘 제외 필터와 함께 사용)')
    ],
    /** Phase 5: 생성 이미지 컨테이너 (img 태그가 지연 로드되거나 래퍼 안에 있을 때 감지 보조) */
    imageContainer: [
      S('single-image.generated-image', 'Gemini single-image.generated-image 컨테이너 (진단 필요)'),
      S('generated-image', 'Gemini generated-image 컨테이너 (진단 필요)'),
      S('single-image', 'Gemini single-image 컨테이너 (진단 필요)'),
      S('[data-test-id*="generated-image"]', 'data-test-id 생성 이미지 컨테이너 (진단 필요)')
    ],
    /** Phase 5: 이미지 생성 진행 중 표시(로딩 스피너·플레이스홀더) */
    imageGenerating: [
      S('generated-image [role="progressbar"]', '이미지 생성 진행 표시줄 (진단 필요)'),
      S('single-image [role="progressbar"]', 'single-image 생성 진행 표시줄 (진단 필요)'),
      S('model-response mat-progress-spinner', '응답 내 로딩 스피너 (진단 필요)'),
      S('[data-test-id*="image-loading"]', 'data-test-id 이미지 로딩 (진단 필요)'),
      S('.image-generation-loading', '이미지 로딩 클래스 대체 수단')
    ],
    /** Phase 5: 생성 이미지 다운로드 버튼 (dataUrl 추출 불가 시 클릭하여 chrome.downloads로 수신) */
    imageDownloadButton: [
      S('download-generated-image-button button', 'Gemini 전용 다운로드 커스텀 요소 내부 버튼 (진단 필요)'),
      S('download-generated-image-button', 'Gemini 전용 다운로드 커스텀 요소 (진단 필요)'),
      S('button[data-test-id="image-download-button"]', 'data-test-id="image-download-button" (진단 필요)'),
      S('button[data-test-id="generated-image-button"]', 'data-test-id="generated-image-button" (진단 필요)'),
      S('button[data-test-id*="download-image"]', 'data-test-id 이미지 다운로드 버튼 (진단 필요)'),
      S('generated-image button[data-test-id*="download"]', 'generated-image 안의 download data-test-id (진단 필요)'),
      S('single-image button[data-test-id*="download"]', 'single-image 안의 download data-test-id (진단 필요)'),
      S('generated-image button[aria-label*="Download" i]', '생성 이미지 다운로드 버튼 영문'),
      S('generated-image button[aria-label*="다운로드"]', '생성 이미지 다운로드 버튼 한국어'),
      S('single-image button[aria-label*="Download" i]', 'single-image 다운로드 버튼 영문'),
      S('single-image button[aria-label*="다운로드"]', 'single-image 다운로드 버튼 한국어'),
      S('model-response button[aria-label*="Download full size" i]', '원본 크기 다운로드 영문'),
      S('model-response button[aria-label*="Download image" i]', '이미지 다운로드 영문'),
      S('model-response button[aria-label*="원본 크기"]', '원본 크기 다운로드 한국어'),
      S('model-response button[aria-label*="전체 크기"]', '전체 크기 다운로드 한국어'),
      S('model-response button[aria-label*="이미지 다운로드"]', '이미지 다운로드 한국어'),
      S('model-response button[aria-label*="Download" i]', '모델 응답 내 Download 버튼 영문'),
      S('model-response button[aria-label*="다운로드"]', '모델 응답 내 다운로드 버튼 한국어')
    ],
    /** 로그인 필요 신호 (입력창이 없을 때만 의미 있음) */
    signIn: [
      S('a[href*="accounts.google.com/ServiceLogin"]', 'Google 로그인 링크'),
      S('a[href*="accounts.google.com"][aria-label*="Sign in" i]', '영문 로그인 링크'),
      S('a[href*="accounts.google.com"][aria-label*="로그인"]', '한국어 로그인 링크')
    ],
    /** 자동화 제한·보안 확인 신호 — 보이면 즉시 중단하고 사용자 확인 요청 */
    blocked: [
      S('iframe[src*="recaptcha"]', 'reCAPTCHA'),
      S('form[action*="sorry"]', 'Google "unusual traffic" 페이지')
    ]
  };

  /** 화면 문구 기반 차단 신호(정규식). 자동 우회하지 않고 중단만 합니다. */
  const BLOCKED_TEXT = /(unusual traffic|비정상적인 트래픽|자동화된 요청|automated queries)/i;

  const api = { SELECTORS, BLOCKED_TEXT, version: '2026-11-24' };
  root.GOMO_GEMINI_SELECTORS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
