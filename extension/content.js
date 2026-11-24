/**
 * Content script for gemini.google.com
 * DOM 처리 로직은 gemini-dom.js, 셀렉터는 gemini-selectors.js에 있습니다.
 * ⚠ 실제 Gemini 화면 동작은 승희님 PC에서 검증 전까지 미검증입니다.
 */
(function () {
  if (window.__gomoGeminiContentLoaded) return; // scripting 재주입 시 중복 방지
  window.__gomoGeminiContentLoaded = true;

  const dom = window.GomoGeminiDom.createGeminiDom({ doc: document, win: window });
  let active = null; // { jobId, requestId, projectId }

  const ids = (m) => ({ jobId: m.jobId, requestId: m.requestId, projectId: m.projectId });
  const strip = (r) => { const { ctx, ok, ...rest } = r; return rest; };
  function emit(kind, m, extra) {
    try { chrome.runtime.sendMessage(Object.assign({ type: 'GEMINI_EVENT', kind }, ids(m), extra || {})); } catch (e) { /* SW 재시작 중 */ }
  }

  async function handleSubmit(msg) {
    if (active) {
      return { success: false, sendState: 'not_sent', errorCode: 'EXTENSION_BUSY', needsUser: true, message: '이 Gemini 탭에서 다른 GOMO 요청을 처리 중입니다.', ...ids(msg) };
    }
    if (!msg.jobId || !msg.requestId || !msg.projectId) {
      return { success: false, sendState: 'not_sent', errorCode: 'BAD_REQUEST', message: 'jobId/requestId/projectId 누락', ...ids(msg) };
    }
    active = ids(msg);
    let res;
    try {
      res = await dom.submit({ prompt: msg.prompt, marker: msg.marker });
    } catch (e) {
      active = null;
      return { success: false, sendState: 'uncertain', errorCode: 'SUBMIT_EXCEPTION', needsUser: true, message: String(e && e.message || e), ...ids(msg) };
    }
    if (res.sendState === 'not_sent') { active = null; return { ...strip(res), ...ids(msg) }; }
    // sent 또는 uncertain: 어느 쪽이든 응답이 오면 수집해서 보고(앱이 jobId/requestId/projectId로 수락 여부 결정)
    const ctx = res.ctx;
    void (async () => {
      try {
        const out = await dom.watch(ctx, (phase, info) => emit('progress', msg, { phase, info }));
        if (out.ok) emit('complete', msg, { text: out.text, codeBlocks: out.codeBlocks, isolation: out.isolation, completion: out.completion });
        else emit('error', msg, { errorCode: out.errorCode, message: out.message, needsUser: out.needsUser, partialText: out.partialText || '' });
      } catch (e) {
        emit('error', msg, { errorCode: 'WATCH_EXCEPTION', message: String(e && e.message || e), needsUser: true });
      } finally { active = null; }
    })();
    return { ...strip(res), ...ids(msg) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'SUBMIT_PROMPT') {
      handleSubmit(msg).then(sendResponse);
      return true; // 비동기 응답
    }
    if (msg.type === 'SELECTOR_PROBE') {
      try { sendResponse({ ok: true, report: dom.probe(), active }); } catch (e) { sendResponse({ ok: false, message: String(e) }); }
      return true;
    }
    if (msg.type === 'PING_CONTENT') {
      const p = dom.probe();
      sendResponse({ ok: true, hasInput: !!p.summary.composer, active });
      return true;
    }
  });
})();
