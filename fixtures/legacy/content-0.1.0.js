// 회귀 테스트용 사본: 커밋 b365733의 extension/content.js (확장 0.1.0). 실행 코드 아님.
/**
 * Content script for gemini.google.com
 * EXPERIMENTAL: DOM selectors are best-effort and must be verified on real Gemini.
 * Do not treat as production-ready until confirmed.
 */
(function () {
  const SELECTORS = {
    // Experimental — verify on live Gemini
    input: 'textarea, div[contenteditable="true"], rich-textarea',
    sendButton: 'button[aria-label*="Send"], button[data-testid*="send"], button.send-button'
  };

  function findInput() {
    return document.querySelector(SELECTORS.input);
  }

  function findSend() {
    return document.querySelector(SELECTORS.sendButton);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SUBMIT_PROMPT') {
      const input = findInput();
      if (!input) {
        sendResponse({ success: false, jobId: msg.jobId, errorCode: 'NO_INPUT', message: '입력창을 찾을 수 없습니다 (실험적 셀렉터).' });
        return true;
      }
      // Attempt to set value — experimental
      try {
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          input.value = msg.prompt;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          input.textContent = msg.prompt;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const btn = findSend();
        if (btn) btn.click();
        sendResponse({ success: true, jobId: msg.jobId, message: '전송 시도 완료 (실험적)' });
      } catch (e) {
        sendResponse({ success: false, jobId: msg.jobId, errorCode: 'SUBMIT_FAILED', message: String(e) });
      }
      return true;
    }
    if (msg.type === 'PING_CONTENT') {
      sendResponse({ ok: true, hasInput: !!findInput() });
      return true;
    }
  });
})();
