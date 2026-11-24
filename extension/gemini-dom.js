/**
 * GOMO Gemini Connector — Gemini 웹 화면 DOM 처리 (입력·전송·신규 응답 분리·완료 판별·진단).
 *
 * - 셀렉터는 gemini-selectors.js 한 곳에서만 관리합니다.
 * - Google 로그인·보안 확인·자동화 제한을 우회하지 않습니다. 그런 신호가 보이면 즉시 중단하고
 *   "사용자 확인 필요" 오류 코드를 돌려줍니다.
 * - 사람 흉내(글자 단위 랜덤 지연 입력 등)를 하지 않습니다. 사용자가 붙여넣는 것과 같은 한 번의 입력만 합니다.
 * - 전송 성공 여부가 불분명하면 sendState='uncertain'으로 보고하고 절대 다시 누르지 않습니다.
 *
 * ⚠ 실제 Gemini DOM에서의 동작은 미검증입니다(테스트는 jsdom 모형 기준). SELECTOR_PROBE로 먼저 확인하세요.
 */
(function (root) {
  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'SECTION', 'CODE-BLOCK']);
  const STOP_LIKE = /(stop|중지|멈추|cancel)/i;
  const DEFAULT_TIMING = {
    pollMs: 400,
    sendEnableWaitMs: 4000,     // 입력 후 전송 버튼 활성화 대기
    sendConfirmTimeoutMs: 8000, // 클릭 후 "전송됨" 증거 대기
    firstResponseTimeoutMs: 120000, // 응답 블록이 나타나기까지
    stableMs: 2500,             // 텍스트 변화 없음 유지 시간
    maxWaitMs: 8 * 60 * 1000,   // 전체 응답 대기 상한
    progressThrottleMs: 1500
  };

  function createGeminiDom(opts) {
    const doc = opts.doc;
    const win = opts.win || doc.defaultView;
    const cfg = opts.selectors || root.GOMO_GEMINI_SELECTORS;
    const SEL = cfg.SELECTORS;
    const timing = Object.assign({}, DEFAULT_TIMING, opts.timing || {});
    const now = opts.now || (() => Date.now());
    const sleep = (ms) => new Promise((r) => win.setTimeout(r, ms));

    function normalize(s) { return String(s || '').replace(/[\u200b\u00a0]/g, ' ').replace(/\s+/g, ' ').trim(); }

    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      if (el.closest('[hidden],[aria-hidden="true"]')) return false;
      try {
        const st = win.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
      } catch { /* ignore */ }
      return true;
    }

    /** 그룹에서 처음으로 "보이는" 요소. 반환: {el, selector, index} | null */
    function find(group, scope, filter) {
      const list = SEL[group] || [];
      for (let i = 0; i < list.length; i++) {
        let nodes;
        try { nodes = (scope || doc).querySelectorAll(list[i].sel); } catch { continue; }
        for (const el of nodes) {
          if (!isVisible(el)) continue;
          if (filter && !filter(el)) continue;
          return { el, selector: list[i].sel, index: i };
        }
      }
      return null;
    }

    /** 그룹에서 결과가 있는 첫 셀렉터의 모든 요소(문서 순서) */
    function findAll(group, scope) {
      const list = SEL[group] || [];
      for (let i = 0; i < list.length; i++) {
        let nodes;
        try { nodes = Array.from((scope || doc).querySelectorAll(list[i].sel)); } catch { continue; }
        if (nodes.length) return { els: nodes, selector: list[i].sel, index: i };
      }
      return { els: [], selector: null, index: -1 };
    }

    function label(el) { return ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-test-id') || '') + ' ' + (el.className && el.className.baseVal === undefined ? el.className : '')).trim(); }
    function isEnabled(el) { return !el.disabled && el.getAttribute('aria-disabled') !== 'true'; }
    function findSend() { return find('sendButton', null, (el) => !STOP_LIKE.test(el.getAttribute('aria-label') || '') && !/\bstop\b/.test(String(el.className || ''))); }
    function findStop() { return find('stopButton'); }
    function findComposer() { return find('composer', null, (el) => el.getAttribute('contenteditable') !== 'false'); }

    function composerText(el) {
      if (!el) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      return blockText(el);
    }

    /** 블록 요소 경계에 줄바꿈을 넣는 텍스트 추출 (innerText 대체, jsdom/분리된 노드에서도 동일 동작) */
    function blockText(node) {
      let out = '';
      const walk = (n) => {
        if (n.nodeType === 3) { out += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        if (n.tagName === 'BR') { out += '\n'; return; }
        const block = BLOCK_TAGS.has(n.tagName);
        if (block && out && !out.endsWith('\n')) out += '\n';
        for (const c of n.childNodes) walk(c);
        if (block && !out.endsWith('\n')) out += '\n';
      };
      walk(node);
      return out.replace(/\n{3,}/g, '\n\n').trim();
    }

    function detectBlocked() {
      const hit = find('blocked');
      if (hit) return { code: 'BLOCKED', selector: hit.selector };
      const bodyText = doc.body ? (doc.body.textContent || '').slice(0, 20000) : '';
      if (cfg.BLOCKED_TEXT && cfg.BLOCKED_TEXT.test(bodyText) && !findComposer()) return { code: 'BLOCKED', selector: 'text' };
      return null;
    }

    function preflight() {
      const blocked = detectBlocked();
      if (blocked) return fail('BLOCKED', 'Google 보안 확인 또는 자동화 제한 화면이 표시되었습니다. 자동으로 우회하지 않습니다.', true);
      const composer = findComposer();
      if (!composer) {
        if (find('signIn')) return fail('LOGIN_REQUIRED', 'Gemini에 로그인되어 있지 않습니다.', true);
        return fail('NO_INPUT', 'Gemini 입력창을 찾지 못했습니다(셀렉터 미일치 가능).', true);
      }
      if (findStop()) return fail('GEMINI_BUSY', 'Gemini가 이전 답변을 생성하는 중입니다.', true);
      if (normalize(composerText(composer.el))) return fail('COMPOSER_NOT_EMPTY', 'Gemini 입력창에 작성 중인 내용이 있어 덮어쓰지 않았습니다.', true);
      return { ok: true, composer };
    }

    function fail(errorCode, message, needsUser) {
      return { ok: false, success: false, sendState: 'not_sent', errorCode, message, needsUser: !!needsUser };
    }

    function landed(el, expected, marker) {
      const got = normalize(composerText(el));
      const want = normalize(expected);
      if (!got) return false;
      if (marker && !got.includes(normalize(marker))) return false;
      if (!got.startsWith(want.slice(0, 40))) return false;
      return got.length >= Math.floor(want.length * 0.97);
    }

    function clearComposer(el) {
      try {
        if (el.tagName === 'TEXTAREA') { setNativeValue(el, ''); return; }
        el.focus();
        const sel = win.getSelection && win.getSelection();
        if (sel) sel.selectAllChildren(el);
        if (typeof doc.execCommand === 'function' && doc.execCommand('delete', false)) return;
      } catch { /* fall through */ }
      try { el.innerHTML = '<p><br></p>'; el.dispatchEvent(new win.Event('input', { bubbles: true })); } catch { /* ignore */ }
    }

    function setNativeValue(el, value) {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
    }

    /** 입력창에 텍스트를 넣고 실제로 들어갔는지 확인. 여러 방식을 순서대로 시도. */
    async function insertPrompt(el, text, marker) {
      const attempts = [];
      const verify = async () => { await sleep(60); return landed(el, text, marker); };
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.focus(); setNativeValue(el, text); attempts.push('native-value');
        if (await verify()) return { ok: true, method: 'native-value', attempts };
        return { ok: false, attempts };
      }
      // 1) execCommand('insertText') — 사용자가 타이핑/붙여넣기 한 것과 같은 편집 경로(Quill이 인식)
      try {
        el.focus();
        const sel = win.getSelection && win.getSelection();
        if (sel) sel.selectAllChildren(el);
        if (typeof doc.execCommand === 'function') {
          const ok = doc.execCommand('insertText', false, text);
          attempts.push('execCommand:' + ok);
          if (await verify()) return { ok: true, method: 'execCommand', attempts };
        } else attempts.push('execCommand:unavailable');
      } catch (e) { attempts.push('execCommand:error'); }
      // 2) 합성 paste 이벤트 (시스템 클립보드는 건드리지 않음)
      try {
        if (typeof win.DataTransfer === 'function' && typeof win.ClipboardEvent === 'function') {
          clearComposer(el); el.focus();
          const dt = new win.DataTransfer(); dt.setData('text/plain', text);
          el.dispatchEvent(new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          attempts.push('paste');
          if (await verify()) return { ok: true, method: 'paste', attempts };
        } else attempts.push('paste:unavailable');
      } catch { attempts.push('paste:error'); }
      // 3) beforeinput/input 이벤트 + DOM 직접 반영 (Quill은 DOM 변경을 감지해 모델을 갱신)
      try {
        clearComposer(el); el.focus();
        const before = new win.InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true });
        el.dispatchEvent(before);
        if (!(await verify())) {
          const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          el.innerHTML = text.split('\n').map((l) => `<p>${l ? esc(l) : '<br>'}</p>`).join('');
          el.dispatchEvent(new win.InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
        }
        attempts.push('input-event');
        if (await verify()) return { ok: true, method: 'input-event', attempts };
      } catch { attempts.push('input-event:error'); }
      return { ok: false, attempts };
    }

    function snapshot() {
      return {
        responses: new Set(findAll('modelResponse').els),
        queries: new Set(findAll('userQuery').els),
        responseCount: findAll('modelResponse').els.length
      };
    }

    async function waitFor(fn, timeoutMs) {
      const start = now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (now() - start >= timeoutMs) return null;
        await sleep(Math.min(timing.pollMs, 200));
      }
    }

    function markerQuery(marker, baseline) {
      if (!marker) return null;
      const m = normalize(marker);
      const qs = findAll('userQuery').els.filter((q) => normalize(q.textContent).includes(m));
      const fresh = qs.filter((q) => !baseline || !baseline.queries.has(q));
      return fresh[fresh.length - 1] || qs[qs.length - 1] || null;
    }

    /** 이번 요청의 응답 블록만 찾는다: 표식이 들어간 사용자 질문 바로 뒤 + 전송 전 스냅샷에 없던 노드 */
    function locateResponse(ctx) {
      const all = findAll('modelResponse').els;
      const fresh = all.filter((r) => !ctx.baseline.responses.has(r));
      const q = markerQuery(ctx.marker, ctx.baseline);
      if (q) {
        const after = fresh.filter((r) => q.compareDocumentPosition(r) & 4 /* FOLLOWING */);
        if (after.length) return { el: after[0], isolation: 'marker' };
        return null;
      }
      if (fresh.length) return { el: fresh[fresh.length - 1], isolation: 'baseline' };
      return null;
    }

    function extract(responseEl) {
      const body = find('responseBody', responseEl);
      const target = body ? body.el : responseEl;
      const clone = target.cloneNode(true);
      for (const ex of SEL.excludeFromText || []) {
        try { clone.querySelectorAll(ex.sel).forEach((n) => n.remove()); } catch { /* ignore */ }
      }
      const codes = findAll('codeBlock', responseEl).els
        .filter((c) => !(c.closest && c.closest('model-thoughts')))
        .map((c) => (c.textContent || '').trim()).filter(Boolean);
      return { text: blockText(clone), codeBlocks: codes, bodySelector: body ? body.selector : '(model-response 전체)' };
    }

    /**
     * 전송. 결과 sendState: 'sent' | 'not_sent' | 'uncertain'.
     * 'not_sent'는 클릭 전에 멈춘 경우에만 사용합니다. 클릭 후 증거가 없으면 'uncertain'.
     */
    async function submit(params) {
      const pre = preflight();
      if (!pre.ok) return pre;
      const composer = pre.composer.el;
      const text = params.marker ? `${params.prompt}\n\n${params.marker}` : params.prompt;
      const baseline = snapshot();
      const ins = await insertPrompt(composer, text, params.marker);
      if (!ins.ok) {
        clearComposer(composer);
        return Object.assign(fail('INSERT_FAILED', '입력창에 프롬프트를 넣지 못했습니다(입력 방식 미지원 가능). 전송하지 않았습니다.', true), { attempts: ins.attempts });
      }
      const btn = await waitFor(() => { const b = findSend(); return b && isEnabled(b.el) ? b : null; }, timing.sendEnableWaitMs);
      if (!btn) {
        clearComposer(composer);
        return Object.assign(fail('NO_SEND_BUTTON', '전송 버튼을 찾지 못했거나 비활성 상태입니다. 전송하지 않았습니다.', true), { insertMethod: ins.method });
      }
      const blockedNow = detectBlocked();
      if (blockedNow) return fail('BLOCKED', 'Google 보안 확인 화면이 나타나 전송을 중단했습니다.', true);
      btn.el.click();
      const ctx = { marker: params.marker, baseline, sentAt: now(), insertMethod: ins.method, sendSelector: btn.selector };
      const evidence = await waitFor(() => {
        if (markerQuery(params.marker, baseline)) return 'user-query';
        if (findStop()) return 'stop-button';
        if (locateResponse(ctx)) return 'new-response';
        return null;
      }, timing.sendConfirmTimeoutMs);
      if (evidence) {
        return { ok: true, success: true, sendState: 'sent', evidence, insertMethod: ins.method, sendSelector: btn.selector, ctx };
      }
      return {
        ok: false, success: false, sendState: 'uncertain', errorCode: 'SEND_UNCERTAIN', needsUser: true,
        message: '전송 버튼은 눌렀지만 Gemini 화면에서 전송 증거를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.',
        insertMethod: ins.method, sendSelector: btn.selector, ctx
      };
    }

    /**
     * 응답 완료까지 감시. onProgress(phase, info) 호출. 반환: {ok, text, codeBlocks, ...} 또는 {ok:false, errorCode}
     * 완료 판정: 중지 버튼 없음 + 텍스트가 stableMs 동안 변하지 않음 + (응답 동작 버튼 표시 또는 추가 안정 시간)
     */
    async function watch(ctx, onProgress) {
      const start = now();
      let lastText = null; let lastChange = now(); let stopSeen = false; let lastProgress = 0; let found = null;
      for (;;) {
        await sleep(timing.pollMs);
        const t = now();
        if (detectBlocked()) return { ok: false, errorCode: 'BLOCKED', needsUser: true, message: '응답 대기 중 Google 보안 확인 화면이 나타났습니다.' };
        const generating = !!findStop();
        if (generating) stopSeen = true;
        const loc = locateResponse(ctx);
        if (!loc) {
          if (t - start > timing.firstResponseTimeoutMs) return { ok: false, errorCode: 'NO_RESPONSE_NODE', needsUser: true, message: '전송 후 Gemini 응답 블록을 찾지 못했습니다.' };
          if (t - start > timing.maxWaitMs) return { ok: false, errorCode: 'RESPONSE_TIMEOUT', needsUser: true, message: '응답 대기 시간이 초과되었습니다.' };
          continue;
        }
        found = loc;
        const ex = extract(loc.el);
        if (ex.text !== lastText) { lastText = ex.text; lastChange = t; }
        if (onProgress && t - lastProgress >= timing.progressThrottleMs) {
          lastProgress = t;
          onProgress(ex.text ? 'collecting' : 'waiting', { chars: ex.text.length, generating, isolation: loc.isolation });
        }
        const stableFor = t - lastChange;
        const actions = !!find('responseActions', loc.el);
        const needStable = actions ? timing.stableMs : (stopSeen ? timing.stableMs * 2 : timing.stableMs * 3);
        if (!generating && ex.text && stableFor >= needStable) {
          return {
            ok: true, text: ex.text, codeBlocks: ex.codeBlocks, isolation: loc.isolation,
            completion: { stopSeen, actions, stableMs: stableFor }, bodySelector: ex.bodySelector
          };
        }
        if (t - start > timing.maxWaitMs) {
          return { ok: false, errorCode: 'RESPONSE_TIMEOUT', needsUser: true, message: '응답 완료를 확인하지 못했습니다(시간 초과).', partialText: found ? lastText : '' };
        }
      }
    }

    /** 아무것도 입력·전송하지 않고 셀렉터 일치 현황만 보고 */
    function probe() {
      const groups = {};
      for (const group of Object.keys(SEL)) {
        groups[group] = SEL[group].map((s) => {
          let count = 0; let visible = 0;
          try { const ns = doc.querySelectorAll(s.sel); count = ns.length; ns.forEach((n) => { if (isVisible(n)) visible++; }); } catch { count = -1; }
          return { selector: s.sel, count, visible, verified: s.verified };
        });
      }
      const composer = findComposer(); const send = findSend(); const stop = findStop();
      return {
        kind: 'gomo.selector-probe.v1',
        selectorsVersion: cfg.version,
        url: String(win.location && win.location.href || ''),
        title: doc.title,
        at: new Date().toISOString(),
        summary: {
          composer: composer ? composer.selector : null,
          composerEmpty: composer ? !normalize(composerText(composer.el)) : null,
          sendButton: send ? send.selector : null,
          sendEnabled: send ? isEnabled(send.el) : null,
          stopButton: stop ? stop.selector : null,
          userQueries: findAll('userQuery').els.length,
          modelResponses: findAll('modelResponse').els.length,
          signIn: !!find('signIn'),
          blocked: !!detectBlocked()
        },
        groups
      };
    }

    return { submit, watch, probe, preflight, insertPrompt, extract, locateResponse, snapshot, normalize, blockText, find, findAll, label };
  }

  root.GomoGeminiDom = { createGeminiDom, DEFAULT_TIMING };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.GomoGeminiDom;
})(typeof globalThis !== 'undefined' ? globalThis : self);
