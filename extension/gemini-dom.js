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
    toolModeWaitMs: 4000,       // + 메뉴 열림·도구 칩 전환 대기
    firstResponseTimeoutMs: 120000, // 응답 블록이 나타나기까지
    stableMs: 2500,             // 텍스트 변화 없음 유지 시간
    noImageIdleMs: 12000,       // 이미지 응답 생성 종료 후 이미지/텍스트가 모두 없을 때 대기 상한
    maxWaitMs: 8 * 60 * 1000,   // 전체 응답 대기 상한
    progressThrottleMs: 1500,
    attachWaitMs: 2500        // 기준 이미지 첨부 미리보기 확인 대기
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
    /** 전송 버튼 후보: 중지 버튼, 대화(답변) 안 버튼, 「공유 및 내보내기」처럼 '보내기'가 들어간 다른 버튼은 제외 */
    function isSendCandidate(el) {
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-test-id') || '');
      if (STOP_LIKE.test(el.getAttribute('aria-label') || '') || /\bstop\b/.test(String(el.className || ''))) return false;
      if (isInConversation(el) || isInSidebar(el)) return false;
      if (/(내보내기|공유|export|share)/i.test(label)) return false;
      return true;
    }
    function findSend() { return find('sendButton', null, isSendCandidate); }
    function findComposer() { return find('composer', null, (el) => el.getAttribute('contenteditable') !== 'false'); }

    /**
     * 사이드바 '중지' 포함 제목 오탐 방지:
     * 사이드바·대화 목록·더보기(more_vert) 메뉴 버튼은 절대 응답 생성 중지 버튼으로 보지 않는다.
     */
    function isNonStopMenuOrSidebar(el) {
      if (!el) return true;
      if (el.closest && el.closest('nav, aside, [role="navigation"], mat-sidenav, [data-test-id*="sidebar"], [data-test-id*="conversation"], .conversation-list, .sidenav')) {
        return true;
      }
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (/(더보기|more\s*options|more_vert|옵션|menu)/i.test(aria)) return true;
      try {
        const icons = el.querySelectorAll('mat-icon');
        for (const ic of icons) {
          const iconName = ((ic.getAttribute('fonticon') || '') + ' ' + (ic.textContent || '')).trim().toLowerCase();
          if (/\b(?:more_vert|more_horiz|menu)\b/.test(iconName)) return true;
        }
      } catch { /* ignore */ }
      return false;
    }

    /** 입력창(composer) 근처(같은 입력 영역 조상 4단계 이내)에 있는지 확인 */
    function isNearComposer(el, composerEl) {
      if (!el || !composerEl) return false;
      let cur = composerEl.parentElement;
      for (let depth = 0; depth < 4 && cur; depth++) {
        const tag = (cur.tagName || '').toUpperCase();
        if (tag === 'BODY' || tag === 'MAIN' || tag === 'CHAT-APP') break;
        if (cur.querySelector && cur.querySelector('model-response, user-query')) break;
        if (cur.contains(el)) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    /** 명확히 "응답 생성 중지" 의미의 버튼인지 확인 */
    function isExplicitStopButton(el) {
      if (!el) return false;
      const testId = (el.getAttribute('data-test-id') || '').trim();
      if (testId === 'stop-button') return true;
      if (el.classList && el.classList.contains('send-button') && el.classList.contains('stop')) return true;
      const aria = (el.getAttribute('aria-label') || '').trim();
      return /^(?:stop response|stop generating.*|대답 생성 중지|응답 중지|응답 생성 중지)$/i.test(aria);
    }

    function hasRenderSize(el) {
      // 실제 브라우저(레이아웃 엔진 활성)에서는 크기 0x0 요소 제외; jsdom 모형(clientWidth===0)에서는 생략
      if (doc.documentElement && doc.documentElement.clientWidth > 0) {
        return el.offsetWidth > 0 && el.offsetHeight > 0;
      }
      return true;
    }

    /**
     * 사이드바 '중지' 포함 제목 오탐 방지:
     * 실제 입력창 근처의 크기 있는 중지 버튼 또는 명확한 stop-button만 GEMINI_BUSY로 인정한다.
     */
    function findStop() {
      const comp = findComposer();
      const scope = comp ? (() => {
        let cur = comp.el.parentElement;
        let best = null;
        for (let depth = 0; depth < 4 && cur; depth++) {
          const tag = (cur.tagName || '').toUpperCase();
          if (tag === 'BODY' || tag === 'MAIN' || tag === 'CHAT-APP') break;
          if (cur.querySelector && cur.querySelector('model-response, user-query')) break;
          best = cur;
          cur = cur.parentElement;
        }
        return best;
      })() : null;

      const filter = (el) => {
        if (isNonStopMenuOrSidebar(el)) return false;
        if (!hasRenderSize(el)) return false;
        return isNearComposer(el, comp && comp.el) || isExplicitStopButton(el);
      };

      if (scope) {
        const near = find('stopButton', scope, filter);
        if (near) return near;
      }
      return find('stopButton', null, (el) => !isNonStopMenuOrSidebar(el) && hasRenderSize(el) && isExplicitStopButton(el));
    }

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


    const TOOL_MODE_DEFS = {
      video: {
        menu: [/동영상\s*만들기/, /동영상\s*생성/, /create\s*videos?/i, /^\s*video\s*$/i],
        chip: [/^(동영상|video)$/i],
        placeholder: [/동영상을 설명/, /describe\s+(a\s+)?video/i],
        selectName: '동영상 만들기',
        chipName: '동영상'
      },
      image: {
        menu: [/이미지\s*만들기/, /이미지\s*생성/, /create\s*images?/i, /^\s*image\s*$/i],
        chip: [/^(이미지|image)$/i],
        placeholder: [/이미지를 설명/, /describe\s+(an?\s+)?image/i],
        selectName: '이미지 만들기',
        chipName: '이미지'
      },
      music: {
        menu: [/음악\s*만들기/, /음악\s*생성/, /create\s*music/i, /create\s*audio/i, /^\s*music\s*$/i],
        chip: [/^(음악|music)$/i],
        placeholder: [/음악을 설명/, /describe\s+(the\s+)?music/i, /describe\s+(an?\s+)?(song|audio)/i],
        selectName: '음악 만들기',
        chipName: '음악'
      }
    };

    function targetModeForStage(stage) {
      if (stage === 'video' || stage === 'image' || stage === 'music') return stage;
      return null;
    }

    /** open Shadow DOM까지 재귀적으로 querySelectorAll */
    function queryAllDeep(root, selector) {
      const out = [];
      const seen = new Set();
      const visit = (node) => {
        if (!node) return;
        if (node.nodeType === 1 && node.matches) {
          try { if (node.matches(selector) && !seen.has(node)) { seen.add(node); out.push(node); } } catch { /* ignore */ }
        }
        let matches = [];
        try { if (node.querySelectorAll) matches = Array.from(node.querySelectorAll(selector)); } catch { matches = []; }
        for (const el of matches) {
          if (!seen.has(el)) { seen.add(el); out.push(el); }
        }
        let all = [];
        try { if (node.querySelectorAll) all = Array.from(node.querySelectorAll('*')); } catch { all = []; }
        for (const el of all) {
          if (el.shadowRoot) visit(el.shadowRoot);
        }
      };
      visit(root || doc);
      return out;
    }

    function walkElementsDeep(root, fn) {
      const visitTree = (node, includeSelf) => {
        if (!node) return;
        if (includeSelf && node.nodeType === 1) fn(node);
        let all = [];
        try { if (node.querySelectorAll) all = Array.from(node.querySelectorAll('*')); } catch { all = []; }
        const seen = new Set();
        for (const el of all) {
          if (seen.has(el)) continue;
          seen.add(el);
          fn(el);
          if (el.shadowRoot) visitTree(el.shadowRoot, false);
        }
      };
      const startNode = root || doc;
      visitTree(startNode, startNode.nodeType === 1);
    }

    function composedContains(root, el) {
      if (!root || !el) return false;
      try { if (root.contains && root.contains(el)) return true; } catch { /* ignore */ }
      let cur = el;
      const guard = new Set();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        if (cur === root) return true;
        const rn = cur.getRootNode && cur.getRootNode();
        if (rn && rn !== doc && rn.host) { cur = rn.host; continue; }
        cur = cur.parentElement || cur.parentNode;
      }
      return false;
    }

    function closestDeep(el, selector) {
      let cur = el;
      const guard = new Set();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        if (cur.nodeType === 1) {
          try { if (cur.matches && cur.matches(selector)) return cur; } catch { /* ignore */ }
          try { const hit = cur.closest && cur.closest(selector); if (hit) return hit; } catch { /* ignore */ }
        }
        const rn = cur.getRootNode && cur.getRootNode();
        if (rn && rn !== doc && rn.host) { cur = rn.host; continue; }
        cur = cur.parentElement || cur.parentNode;
      }
      return null;
    }

    function isInSidebar(el) {
      if (!el) return true;
      return !!closestDeep(el, 'nav, aside, bard-sidenav, [role="navigation"], mat-sidenav, [data-test-id*="sidebar"], [data-test-id*="conversation"], .conversation-list, .sidenav, .sidebar');
    }

    /** 대화(질문·답변) 안의 요소: 답변 아래 공유·내보내기·더보기·복사 버튼 등. 입력창 도구 버튼이 아님 */
    const CONVERSATION_SEL = 'model-response, user-query, #chat-history, message-actions, .response-container, response-container, infinite-scroller, [data-test-id*="conversation"]';
    function isInConversation(el) { return !!(el && closestDeep(el, CONVERSATION_SEL)); }
    /** 이 요소 안에 대화가 들어 있나 (입력 영역을 찾으며 위로 올라갈 때 여기서 멈춤) */
    function containsConversation(el) {
      try { return !!(el && el.querySelector && el.querySelector(CONVERSATION_SEL)); } catch { return false; }
    }
    /** 공유·내보내기·더보기·복사·평가 같은 답변 동작 버튼 라벨 */
    const NOT_TOOL_BUTTON_RE = /(공유|내보내기|share|export|더보기|more options|more_vert|복사|copy|좋아요|싫어요|good response|bad response|다시 생성|regenerate|수정|edit|듣기|listen|신고|report)/i;

    function isExcludedFromToolMenu(el) {
      if (!el) return true;
      if (isInSidebar(el)) return true;
      return !!closestDeep(el, 'model-response, user-query, #chat-history, bard-sidenav, [data-test-id*="conversation"]');
    }

    /** mat-icon 리가처("videocam", "movie")가 textContent에 섞이지 않도록 순수 라벨만 추출 */
    function visibleLabel(el) {
      if (!el) return { aria: '', text: '', all: '' };
      const aria = normalize(el.getAttribute('aria-label') || '');
      let text = '';
      try {
        const clone = el.cloneNode(true);
        try {
          clone.querySelectorAll('mat-icon, .material-icons, .material-symbols-outlined, .google-symbols, svg, [aria-hidden="true"]').forEach((n) => n.remove());
        } catch { /* ignore */ }
        text = normalize(clone.textContent || '');
      } catch {
        text = normalize(el.textContent || '');
      }
      return { aria, text, all: normalize([aria, text].filter(Boolean).join(' ')) };
    }

    function elementText(el) {
      return visibleLabel(el).all;
    }

    function labelCandidates(el, maxLen) {
      const v = visibleLabel(el);
      const cap = maxLen == null ? 40 : maxLen;
      return [v.aria, v.text, v.all].filter((s) => s && s.length <= cap);
    }

    function matchAny(text, regexes) {
      return regexes.some((re) => re.test(normalize(text)));
    }

    function menuLabelMatches(labels, mode) {
      const def = TOOL_MODE_DEFS[mode];
      if (!def) return false;
      return labels.some((s) => def.menu.some((re) => re.test(s)));
    }

    function clickableTarget(el) {
      if (!el) return el;
      const hit = closestDeep(el, 'button, [role="menuitem"], [role="menuitemradio"], [role="option"], [role="button"], a, mat-list-item, li');
      if (hit && !isInSidebar(hit)) return hit;
      let cur = el;
      for (let i = 0; i < 4 && cur; i++) {
        if (cur.nodeType === 1 && cur.hasAttribute && cur.hasAttribute('tabindex') && cur !== doc.body) return cur;
        const rn = cur.getRootNode && cur.getRootNode();
        if (rn && rn !== doc && rn.host && !cur.parentElement) { cur = rn.host; continue; }
        cur = cur.parentElement;
      }
      return el.parentElement || el;
    }

    /** 스크롤로 잘린 항목도 포함. 조상 aria-hidden은 오버레이가 그 안에 열리는 경우를 위해 보지 않음 */
    function isMenuItemDisplayed(el) {
      if (!el || !el.isConnected) return false;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
      try {
        const st = win.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
      } catch { /* ignore */ }
      if (doc.documentElement && doc.documentElement.clientWidth > 0) {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        const hasBox = (r && r.width > 0 && r.height > 0) || (el.offsetWidth > 0 && el.offsetHeight > 0);
        if (!hasBox) return false;
      }
      return true;
    }

    /** Angular/Material 호환: pointer/mouse 시퀀스 후 click은 한 번만 */
    function realClick(el) {
      if (!el) return;
      try {
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch { /* ignore */ }
      const opts = { bubbles: true, cancelable: true, composed: true, view: win, button: 0, buttons: 1 };
      const fire = (type) => {
        try {
          if (type.startsWith('pointer') && win.PointerEvent) el.dispatchEvent(new win.PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse' }, opts)));
          else el.dispatchEvent(new win.MouseEvent(type, opts));
        } catch { /* ignore */ }
      };
      fire('pointerdown');
      fire('mousedown');
      fire('pointerup');
      fire('mouseup');
      el.click();
    }

    function detectChipMode(el) {
      if (!el) return null;
      if (closestDeep(el, '[role="menu"], .cdk-overlay-pane, mat-menu, [contenteditable="true"], rich-textarea, [role="dialog"]')) return null;
      const parts = labelCandidates(el, 40);
      for (const t of parts) {
        if (/^(동영상|video)$/i.test(t)) return 'video';
        if (/^(이미지|image)$/i.test(t)) return 'image';
        if (/^(음악|music)$/i.test(t)) return 'music';
      }
      const all = parts.join(' ');
      if (!all || /(만들기|생성|업로드|create|노트북|notebook)/i.test(all)) return null;
      if (/(^|\s)(동영상|video)(\s|$)/i.test(all)) return 'video';
      if (/(^|\s)(이미지|image)(\s|$)/i.test(all)) return 'image';
      if (/(^|\s)(음악|music)(\s|$)/i.test(all)) return 'music';
      return null;
    }

    function findComposerArea(composerEl) {
      const comp = composerEl || (findComposer() && findComposer().el);
      if (!comp) return null;
      function shouldStop(el) {
        if (!el) return true;
        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || tag === 'CHAT-APP') return true;
        if (el.id === 'chat-history') return true;
        if (el.matches && el.matches('nav, aside, bard-sidenav, [role="navigation"], mat-sidenav, model-response, user-query, #chat-history')) return true;
        return false;
      }
      const list = SEL.composerArea || [];
      let cur = comp.parentElement;
      let last = null;
      while (cur && !shouldStop(cur)) {
        // 대화(이전 답변)까지 감싸는 상위 요소로는 올라가지 않는다 → 답변의 공유·내보내기 버튼을 + 로 오인하지 않음
        if (last && containsConversation(cur)) return last;
        last = cur;
        for (let i = 0; i < list.length; i++) {
          try { if (cur.matches(list[i].sel)) return cur; } catch { /* ignore */ }
        }
        const hasSend = find('sendButton', cur, isSendCandidate);
        const plusHit = findDeep('toolMenuButton', cur, (el) => !isInSidebar(el) && el !== comp && !composedContains(comp, el));
        if (hasSend || plusHit) return cur;
        cur = cur.parentElement;
      }
      return last;
    }

    function isComposerToolButton(el, area) {
      if (!el || !area || !composedContains(area, el)) return false;
      if (isInSidebar(el) || isInConversation(el)) return false;
      const id0 = (el.getAttribute('data-test-id') || '') + ' ' + (el.getAttribute('aria-label') || '');
      if (NOT_TOOL_BUTTON_RE.test(id0)) return false;
      if (closestDeep(el, 'rich-textarea, [contenteditable="true"]')) return false;
      const id = el.getAttribute('data-test-id') || '';
      if (id === 'send-button' || id === 'stop-button' || id === 'tool-chip') return false;
      if (el.getAttribute('data-node-type') === 'speech_dictation_mic_button') return false;
      if (el.classList && el.classList.contains('tool-chip')) return false;
      const t = elementText(el);
      if (/(노트북|notebook|새 대화|new chat|send message|메시지 보내기|전송|마이크|microphone|\bmic\b|stop response|생성 중지)/i.test(t) && !/닫기|close|추가|도구|tools|\+/i.test(t)) return false;
      return true;
    }

    function findDeep(group, scope, filter) {
      const list = SEL[group] || [];
      const root = scope || doc;
      for (let i = 0; i < list.length; i++) {
        const nodes = queryAllDeep(root, list[i].sel);
        for (const el of nodes) {
          if (!isVisible(el) && !isMenuItemDisplayed(el)) continue;
          if (filter && !filter(el)) continue;
          return { el, selector: list[i].sel, index: i };
        }
      }
      return null;
    }

    function findToolMenuButton(area) {
      if (!area) return null;
      const hit = findDeep('toolMenuButton', area, (el) => isComposerToolButton(el, area));
      if (hit) return hit;
      let found = null;
      walkElementsDeep(area, (el) => {
        if (found || (el.tagName || '').toLowerCase() !== 'button') return;
        if (!isVisible(el) && !isMenuItemDisplayed(el)) return;
        if (!isComposerToolButton(el, area)) return;
        const t = elementText(el);
        let icon = '';
        try {
          const ic = el.querySelector('mat-icon');
          icon = ic ? ((ic.getAttribute('fonticon') || '') + ' ' + (ic.textContent || '')) : '';
        } catch { /* ignore */ }
        if (/^\s*(\+|x|×)\s*$/i.test(t) || /추가|도구|업로드|\btools\b|\badd\b|\bplus\b|\bupload\b|닫기/i.test(t) || /\b(add|plus|close)(_\w+)?\b/i.test(icon) || el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-expanded') === 'true') {
          found = { el, selector: '(composer-area plus fallback)', index: -1 };
        }
      });
      return found;
    }

    function placeholderMode() {
      const c = findComposer();
      if (!c) return null;
      const nodes = [c.el];
      if (c.el.parentElement) nodes.push(c.el.parentElement);
      try {
        const wrap = c.el.closest('rich-textarea, .input-area, input-area, prompt-box');
        if (wrap && !nodes.includes(wrap)) nodes.push(wrap);
      } catch { /* ignore */ }
      const bits = [];
      for (const n of nodes) {
        if (!n || !n.getAttribute) continue;
        bits.push(n.getAttribute('data-placeholder'), n.getAttribute('placeholder'), n.getAttribute('aria-label'), n.getAttribute('aria-placeholder'));
      }
      const ph = bits.filter(Boolean).join(' ');
      for (const mode of ['video', 'image', 'music']) {
        if (matchAny(ph, TOOL_MODE_DEFS[mode].placeholder)) return mode;
      }
      return null;
    }

    function readActiveToolChip(area) {
      if (!area) return null;
      const seen = new Set();
      const candidates = [];
      const list = SEL.toolChip || [];
      for (let i = 0; i < list.length; i++) {
        for (const el of queryAllDeep(area, list[i].sel)) {
          if (!isVisible(el) || !composedContains(area, el) || isInSidebar(el) || seen.has(el)) continue;
          seen.add(el);
          candidates.push(el);
        }
      }
      walkElementsDeep(area, (el) => {
        const tag = (el.tagName || '').toLowerCase();
        const role = el.getAttribute('role') || '';
        if (tag !== 'button' && role !== 'button' && !((el.getAttribute('data-test-id') || '').includes('chip'))) return;
        if (!isVisible(el) || isInSidebar(el) || seen.has(el)) return;
        if (closestDeep(el, 'rich-textarea, [contenteditable="true"], [role="menu"], [role="dialog"]')) return;
        if (detectChipMode(el)) { seen.add(el); candidates.push(el); }
      });
      for (const el of candidates) {
        const mode = detectChipMode(el);
        if (mode) return { el, mode };
      }
      return null;
    }

    function readActiveToolMode(area) {
      const scope = area || findComposerArea();
      const chip = readActiveToolChip(scope);
      if (chip) return { mode: chip.mode, el: chip.el, via: 'chip' };
      const ph = placeholderMode();
      if (ph) return { mode: ph, el: null, via: 'placeholder' };
      return { mode: null, el: null, via: null };
    }

    /** 모든 toolMenuItem 셀렉터를 Shadow DOM 합집합으로 모은다 */
    function findToolMenuItems() {
      const seen = new Set();
      const out = [];
      const list = SEL.toolMenuItem || [];
      for (let i = 0; i < list.length; i++) {
        for (const el of queryAllDeep(doc, list[i].sel)) {
          if (seen.has(el) || !isMenuItemDisplayed(el) || isExcludedFromToolMenu(el)) continue;
          seen.add(el);
          out.push(el);
        }
      }
      return out;
    }

    const MENU_OPEN_HINTS = /파일 업로드(?! ?메뉴)|Drive에서 파일|업로드 더보기|Google 검색|이미지 만들기|동영상 만들기|음악 만들기|Create (an?\s+)?(image|video|music|videos?)/i;
    const NEW_CHAT_DIALOG_RE = /새 채팅을 시작하시겠습니까|이 도구를 선택하면 새 채팅|start a new chat\??|this tool will start a new chat|start new chat\?/i;
    const NEW_CHAT_CONFIRM_RE = /^(새 채팅|new chat|start new chat)$/i;

    function scanClickable(pred) {
      const out = [];
      const seen = new Set();
      const nodes = [
        ...queryAllDeep(doc, 'button'),
        ...queryAllDeep(doc, '[role="menuitem"]'),
        ...queryAllDeep(doc, '[role="menuitemradio"]'),
        ...queryAllDeep(doc, '[role="option"]'),
        ...queryAllDeep(doc, '[role="button"]'),
        ...queryAllDeep(doc, 'li'),
        ...queryAllDeep(doc, 'a'),
        ...queryAllDeep(doc, 'mat-list-item')
      ];
      for (const el of nodes) {
        if (seen.has(el) || !isMenuItemDisplayed(el) || isExcludedFromToolMenu(el)) continue;
        if (closestDeep(el, 'rich-textarea, [contenteditable="true"]')) continue;
        seen.add(el);
        const labels = labelCandidates(el, 40);
        if (!labels.length) continue;
        if (pred(labels, el)) out.push(el);
      }
      return out;
    }

    function hasOpenMenuHint() {
      if (scanClickable((labels) => labels.some((s) => MENU_OPEN_HINTS.test(s))).length) return true;
      let found = false;
      walkElementsDeep(doc, (el) => {
        if (found || !isMenuItemDisplayed(el) || isExcludedFromToolMenu(el)) return;
        if (closestDeep(el, 'rich-textarea, [contenteditable="true"], [role="dialog"]')) return;
        const labels = labelCandidates(el, 40);
        if (labels.some((s) => MENU_OPEN_HINTS.test(s))) found = true;
      });
      return found;
    }

    function isToolMenuOpen() {
      if (findToolMenuItems().length) return true;
      return hasOpenMenuHint();
    }

    /** 태그/role에 의존하지 않고, 순수 라벨이 목표와 일치하는 가장 안쪽 요소를 찾는다 */
    function findLabelElementDeep(mode) {
      const candidates = [];
      walkElementsDeep(doc, (el) => {
        if (!isMenuItemDisplayed(el) || isExcludedFromToolMenu(el)) return;
        if (closestDeep(el, 'rich-textarea, [contenteditable="true"], [role="dialog"]')) return;
        const labels = labelCandidates(el, 40);
        if (menuLabelMatches(labels, mode)) candidates.push(el);
      });
      if (!candidates.length) return null;
      const leaf = candidates.find((el) => !candidates.some((other) => other !== el && composedContains(el, other))) || candidates[candidates.length - 1];
      return clickableTarget(leaf);
    }

    function findMenuItemForMode(mode) {
      if (!TOOL_MODE_DEFS[mode]) return null;
      for (const el of findToolMenuItems()) {
        if (menuLabelMatches(labelCandidates(el, 40), mode)) return clickableTarget(el);
      }
      const found = scanClickable((labels) => menuLabelMatches(labels, mode));
      if (found.length) return clickableTarget(found[0]);
      return findLabelElementDeep(mode);
    }

    function menuSearchStats(mode) {
      const items = findToolMenuItems();
      const matches = mode ? (scanClickable((labels) => menuLabelMatches(labels, mode)).length) : 0;
      return { menuItemCount: items.length, labelMatches: matches };
    }

    function dialogText(el) {
      const v = visibleLabel(el);
      if (v.all && v.all.length > 0 && v.all.length <= 400) return v.all;
      let raw = '';
      try {
        const clone = el.cloneNode(true);
        try { clone.querySelectorAll('mat-icon, .material-icons, svg, [aria-hidden="true"]').forEach((n) => n.remove()); } catch { /* ignore */ }
        raw = normalize(clone.textContent || '');
      } catch { raw = normalize(el.textContent || ''); }
      return raw.slice(0, 400);
    }

    /** 「새 채팅을 시작하시겠습니까?」 확인 모달. 사이드바의 「새 채팅」은 절대 반환하지 않음 */
    function findNewChatConfirmDialog() {
      const hosts = [
        ...queryAllDeep(doc, '[role="dialog"]'),
        ...queryAllDeep(doc, 'mat-dialog-container'),
        ...queryAllDeep(doc, '[aria-modal="true"]'),
        ...queryAllDeep(doc, '.cdk-overlay-pane')
      ];
      const seen = new Set();
      for (const dlg of hosts) {
        if (seen.has(dlg) || isInSidebar(dlg)) continue;
        seen.add(dlg);
        const text = dialogText(dlg);
        if (!NEW_CHAT_DIALOG_RE.test(text)) continue;
        let button = null;
        const btns = [
          ...queryAllDeep(dlg, 'button'),
          ...queryAllDeep(dlg, '[role="button"]')
        ];
        for (const el of btns) {
          if (isInSidebar(el) || !isMenuItemDisplayed(el)) continue;
          const labels = labelCandidates(el, 40);
          if (labels.some((s) => NEW_CHAT_CONFIRM_RE.test(s))) { button = clickableTarget(el); break; }
        }
        if (button) return { dialog: dlg, button };
      }
      return null;
    }

    function isPlusExpanded(btn) {
      if (!btn || !btn.el) return false;
      const el = btn.el;
      if (el.getAttribute('aria-expanded') === 'true') return true;
      const t = elementText(el);
      let icon = '';
      try {
        const ic = el.querySelector('mat-icon');
        icon = ic ? ((ic.getAttribute('fonticon') || '') + ' ' + (ic.textContent || '')) : '';
      } catch { /* ignore */ }
      return /닫기|close|^\s*[×x]\s*$/i.test(t) || /\bclose\b/i.test(icon);
    }

    /** 열린 오버레이(메뉴·하단 시트)를 바깥 클릭으로 닫는다 */
    function clickOverlayBackdrop() {
      let clicked = false;
      for (const b of queryAllDeep(doc, '.cdk-overlay-backdrop, .mat-bottom-sheet-backdrop, .cdk-overlay-dark-backdrop')) {
        if (!isVisible(b) && !isMenuItemDisplayed(b)) continue;
        try { realClick(b); clicked = true; } catch { /* ignore */ }
      }
      return clicked;
    }
    /** + 를 눌렀는데 도구 메뉴가 아닌 다른 메뉴(공유·내보내기 하단 시트 등)가 열렸는가 */
    function isForeignMenuOpen() {
      const sheets = [...queryAllDeep(doc, 'mat-bottom-sheet-container'), ...queryAllDeep(doc, '.cdk-overlay-pane [role="menu"]'), ...queryAllDeep(doc, '.cdk-overlay-pane')];
      return sheets.some((el) => (isVisible(el) || isMenuItemDisplayed(el)) && !MENU_OPEN_HINTS.test(dialogText(el)) && !NEW_CHAT_DIALOG_RE.test(dialogText(el)));
    }

    function closeToolMenu(area, opts) {
      const force = !!(opts && opts.force);
      if (force) clickOverlayBackdrop();
      try {
        const ev = new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
        (doc.activeElement || doc.body || doc).dispatchEvent(ev);
        doc.dispatchEvent(ev);
      } catch { /* ignore */ }
      const btn = findToolMenuButton(area);
      if ((force || isToolMenuOpen() || isPlusExpanded(btn)) && (isToolMenuOpen() || isPlusExpanded(btn)) && btn) {
        try { realClick(btn.el); } catch { /* ignore */ }
      }
    }

    async function openToolMenu(area) {
      if (isToolMenuOpen()) return { ok: true };
      const btn = findToolMenuButton(area);
      if (!btn) return { ok: false, reason: 'no_plus_button' };
      try { realClick(btn.el); } catch { return { ok: false, reason: 'plus_click_failed' }; }
      const opened = await waitFor(() => (isToolMenuOpen() ? true : null), timing.toolModeWaitMs || 4000);
      if (!opened) {
        const foreign = isForeignMenuOpen();
        closeToolMenu(area, { force: true });
        if (foreign) return { ok: false, reason: 'wrong_menu_opened', stats: menuSearchStats() };
        return { ok: false, reason: 'menu_items_not_found', stats: menuSearchStats() };
      }
      return { ok: true };
    }

    async function clearToolMode(area, current) {
      const chip = readActiveToolChip(area);
      if (chip && chip.el) {
        const dismiss = findDeep('toolChipDismiss', chip.el) || (chip.el.parentElement ? findDeep('toolChipDismiss', chip.el.parentElement) : null);
        try {
          if (dismiss && dismiss.el) realClick(dismiss.el);
          else realClick(chip.el);
        } catch { /* ignore */ }
        const gone = await waitFor(() => (readActiveToolMode(findComposerArea() || area).mode === null ? true : null), timing.toolModeWaitMs || 4000);
        if (gone) { closeToolMenu(area); return true; }
      }
      const opened = await openToolMenu(area);
      if (opened.ok) {
        const item = findMenuItemForMode(current);
        if (item) {
          try { realClick(item); } catch { /* ignore */ }
          await acceptNewChatIfNeeded();
          const gone = await waitFor(() => (readActiveToolMode(findComposerArea()).mode === null ? true : null), timing.toolModeWaitMs || 4000);
          closeToolMenu(findComposerArea() || area);
          if (gone) return true;
        } else {
          closeToolMenu(area, { force: true });
        }
      }
      return readActiveToolMode(findComposerArea() || area).mode === null;
    }

    async function acceptNewChatIfNeeded() {
      const confirm = findNewChatConfirmDialog();
      if (!confirm || !confirm.button) return false;
      try { realClick(confirm.button); } catch { return false; }
      return true;
    }

    async function selectToolMode(area, target) {
      const opened = await openToolMenu(area);
      if (!opened.ok) {
        closeToolMenu(area, { force: true });
        return opened;
      }
      const item = findMenuItemForMode(target);
      if (!item) {
        const stats = menuSearchStats(target);
        const foreign = isForeignMenuOpen() && !hasOpenMenuHint();
        closeToolMenu(area, { force: true });
        return { ok: false, reason: foreign ? 'wrong_menu_opened' : 'item_not_found', stats };
      }
      try { realClick(item); } catch { closeToolMenu(area, { force: true }); return { ok: false, reason: 'item_click_failed' }; }
      let confirmClicked = false;
      const ok = await waitFor(() => {
        const confirm = findNewChatConfirmDialog();
        if (confirm && confirm.button && !confirmClicked) {
          confirmClicked = true;
          try { realClick(confirm.button); } catch { /* ignore */ }
          return null;
        }
        const fresh = findComposerArea() || area;
        if (readActiveToolMode(fresh).mode === target) return true;
        return null;
      }, timing.toolModeWaitMs || 8000);
      closeToolMenu(findComposerArea() || area);
      if (ok) return { ok: true, newChat: confirmClicked };
      return { ok: false, reason: confirmClicked ? 'chip_not_confirmed' : 'chip_not_confirmed', stats: menuSearchStats(target) };
    }

    function toolSelectFail(target, reason, stats) {
      const name = (TOOL_MODE_DEFS[target] && TOOL_MODE_DEFS[target].selectName) || '해당 도구';
      const details = {
        no_composer_area: '입력창 영역을 찾지 못했습니다',
        no_plus_button: '입력창 왼쪽 `+` 버튼을 찾지 못했습니다',
        plus_click_failed: '입력창 왼쪽 `+` 버튼을 클릭하지 못했습니다',
        menu_items_not_found: '`+` 메뉴는 열렸지만 메뉴 항목을 찾지 못했습니다',
        wrong_menu_opened: '`+` 대신 다른 메뉴(공유·내보내기 등)가 열려 닫았습니다',
        item_not_found: '`+` 메뉴는 열렸지만 `' + name + '` 항목을 찾지 못했습니다',
        item_click_failed: '`' + name + '` 항목을 클릭하지 못했습니다',
        chip_not_confirmed: '`' + name + '`를 눌렀지만 도구 칩이 켜진 것을 확인하지 못했습니다'
      };
      let detail = details[reason] || '';
      if (stats && (stats.menuItemCount != null || stats.labelMatches != null)) {
        const bits = [];
        if (stats.menuItemCount != null) bits.push('메뉴 후보 ' + stats.menuItemCount + '개');
        if (stats.labelMatches != null) bits.push('라벨 일치 ' + stats.labelMatches + '개');
        if (bits.length) detail = (detail ? detail + ', ' : '') + bits.join(', ');
      }
      const message = 'Gemini 입력창 왼쪽 `+`에서 `' + name + '`를 직접 선택한 뒤 다시 시도해 주세요.' + (detail ? ' (' + detail + ')' : '');
      return Object.assign(fail('TOOL_MODE_SELECT_FAILED', message, true), { toolModeReason: reason || null, toolModeStats: stats || null });
    }

    function toolClearFail(current) {
      const name = (TOOL_MODE_DEFS[current] && TOOL_MODE_DEFS[current].chipName) || '도구';
      return fail('TOOL_MODE_CLEAR_FAILED', 'Gemini 입력창에 `' + name + '` 도구가 켜져 있어 자동으로 해제하지 못했습니다. 입력창 아래 칩의 닫기를 누른 뒤 다시 시도해 주세요.', true);
    }

    /**
     * 전송 전 입력창 도구 모드를 목표(video/image/music/null)에 맞춘다.
     * 사이드바의 '이미지'·'+ 새 노트북'·'새 채팅'은 절대 누르지 않는다.
     */
    async function ensureToolMode(target) {
      const area = findComposerArea();
      if (!area) {
        if (target === 'video' || target === 'music') return toolSelectFail(target, 'no_composer_area');
        return { ok: true, mode: null, soft: true };
      }
      let cur = readActiveToolMode(area);
      if (cur.mode === target) return { ok: true, mode: target, already: true };

      if (cur.mode && cur.mode !== target) {
        const prev = cur.mode;
        const cleared = await clearToolMode(area, prev);
        if (!cleared || readActiveToolMode(findComposerArea() || area).mode) return toolClearFail(prev);
      }

      if (!target) return { ok: true, mode: null };

      const selected = await selectToolMode(findComposerArea() || area, target);
      const fresh = findComposerArea();
      if (selected.ok && readActiveToolMode(fresh).mode === target) return { ok: true, mode: target, newChat: selected.newChat };
      if (target === 'image') return { ok: true, mode: null, soft: true, toolModeReason: selected.reason };
      return toolSelectFail(target, selected.reason, selected.stats);
    }


    function fileFromReferenceImage(ref) {
      if (!ref || !ref.dataUrl) return null;
      const m = String(ref.dataUrl).match(/^data:([^;]+);base64,([\s\S]+)$/i);
      if (!m) return null;
      const mime = ref.mimeType || m[1] || 'image/png';
      let b64 = m[2].replace(/\s+/g, '');
      let raw;
      try {
        if (typeof win.atob === 'function') {
          const bin = win.atob(b64);
          raw = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
        } else if (typeof Buffer !== 'undefined') {
          raw = Uint8Array.from(Buffer.from(b64, 'base64'));
        }
      } catch { return null; }
      if (!raw || !raw.byteLength) return null;
      const name = ref.name || 'reference.jpg';
      try { return new win.File([raw], name, { type: mime }); }
      catch {
        try { return new File([raw], name, { type: mime }); }
        catch { return null; }
      }
    }

    function makeDataTransfer(file) {
      let dt = null;
      try { if (typeof win.DataTransfer === 'function') dt = new win.DataTransfer(); } catch { dt = null; }
      if (!dt) return null;
      try {
        if (dt.items && dt.items.add) dt.items.add(file);
      } catch { /* jsdom 등에서 실패할 수 있음 */ }
      return dt;
    }

    function hasAttachedPreview(area, fileName) {
      const root = area || doc;
      if (queryAllDeep(root, '[data-gomo-attached]').length) return true;
      const imgs = queryAllDeep(root, 'img');
      for (const img of imgs) {
        const src = (img.getAttribute && img.getAttribute('src')) || img.src || '';
        if (/^(blob:|data:)/i.test(src)) return true;
      }
      const want = normalize(fileName || '');
      if (!want) return false;
      const chips = queryAllDeep(root, 'button, [role="button"], [class*="chip"], [class*="attachment"], [class*="preview"], [class*="thumbnail"], span, div');
      for (const el of chips) {
        const t = normalize((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip') || '')) || elementText(el) || '');
        if (!t) continue;
        if (t === want || t.includes(want)) return true;
        if (/(첨부 제거|첨부 삭제|remove attachment|remove file|detach file)/i.test(t)) return true;
      }
      return false;
    }

    function setInputFiles(input, file) {
      const dt = makeDataTransfer(file);
      let assigned = false;
      if (dt && dt.files) {
        try { input.files = dt.files; assigned = !!(input.files && input.files.length); } catch { assigned = false; }
        if (!assigned) {
          try { Object.defineProperty(input, 'files', { configurable: true, value: dt.files }); assigned = true; } catch { /* ignore */ }
        }
      }
      if (!assigned) {
        try { Object.defineProperty(input, 'files', { configurable: true, value: { 0: file, length: 1, item: (i) => (i === 0 ? file : null) } }); assigned = true; } catch { /* ignore */ }
      }
      try { input.dispatchEvent(new win.Event('change', { bubbles: true })); } catch { /* ignore */ }
      try { input.dispatchEvent(new win.Event('input', { bubbles: true })); } catch { /* ignore */ }
      return assigned;
    }

    function attachData(ev, key, dt) {
      if (!dt) return ev;
      try { if (!ev[key]) Object.defineProperty(ev, key, { configurable: true, value: dt }); } catch { /* ignore */ }
      return ev;
    }
    function dispatchPasteOrDrop(target, type, file) {
      if (!target) return false;
      const dt = makeDataTransfer(file);
      try {
        if (type === 'paste') {
          let ev = null;
          try { if (typeof win.ClipboardEvent === 'function') ev = new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); } catch { ev = null; }
          if (!ev) ev = new win.Event('paste', { bubbles: true, cancelable: true });
          attachData(ev, 'clipboardData', dt);
          return target.dispatchEvent(ev);
        }
        let ev = null;
        try { if (typeof win.DragEvent === 'function') ev = new win.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); } catch { ev = null; }
        if (!ev) ev = new win.Event(type, { bubbles: true, cancelable: true });
        attachData(ev, 'dataTransfer', dt);
        return target.dispatchEvent(ev);
      } catch { return false; }
    }

    /**
     * Gemini 입력창에 기준 이미지를 첨부한다.
     * 1) input[type=file]  2) paste  3) drag/drop
     * 미리보기가 확인되지 않으면 실패(텍스트만 보내지 않음).
     */
    async function attachImageToComposer(composer, area, referenceImage) {
      const file = fileFromReferenceImage(referenceImage);
      if (!file) {
        return { ok: false, errorCode: 'IMAGE_ATTACH_FAILED', method: null, message: '기준 이미지 데이터가 올바르지 않습니다.' };
      }
      const scope = area || findComposerArea(composer) || composer;
      const waitMs = timing.attachWaitMs || 2500;
      const check = () => hasAttachedPreview(scope, file.name || referenceImage.name);

      const inputs = queryAllDeep(scope, 'input[type="file"]');
      for (const input of inputs) {
        try { setInputFiles(input, file); } catch { continue; }
        if (await waitFor(check, waitMs)) return { ok: true, method: 'file-input' };
      }

      try { if (composer && composer.focus) composer.focus(); } catch { /* ignore */ }
      dispatchPasteOrDrop(composer, 'paste', file);
      if (scope && scope !== composer) dispatchPasteOrDrop(scope, 'paste', file);
      if (await waitFor(check, waitMs)) return { ok: true, method: 'paste' };

      for (const evName of ['dragenter', 'dragover', 'drop']) {
        dispatchPasteOrDrop(composer, evName, file);
        if (scope && scope !== composer) dispatchPasteOrDrop(scope, evName, file);
      }
      if (await waitFor(check, waitMs)) return { ok: true, method: 'drop' };

      return {
        ok: false,
        errorCode: 'IMAGE_ATTACH_FAILED',
        method: null,
        message: '기준 이미지를 Gemini 입력창에 자동으로 첨부하지 못했습니다. 이미지를 직접 붙여넣거나 「… → 텍스트만으로 동영상 생성」을 이용해 주세요.'
      };
    }

    /**
     * 전송. 결과 sendState: 'sent' | 'not_sent' | 'uncertain'.
     * 'not_sent'는 클릭 전에 멈춘 경우에만 사용합니다. 클릭 후 증거가 없으면 'uncertain'.
     * 미디어 단계(video/image/music)는 전송 전에 입력창 + 메뉴에서 도구 모드를 맞춥니다.
     */
    async function submit(params) {
      const pre = preflight();
      if (!pre.ok) return pre;
      const modeRes = await ensureToolMode(targetModeForStage(params && params.stage));
      if (!modeRes.ok) return modeRes;
      const composerHit = findComposer();
      if (!composerHit) return fail('NO_INPUT', 'Gemini 입력창을 찾지 못했습니다(셀렉터 미일치 가능).', true);
      if (normalize(composerText(composerHit.el))) return fail('COMPOSER_NOT_EMPTY', 'Gemini 입력창에 작성 중인 내용이 있어 덮어쓰지 않았습니다.', true);
      const composer = composerHit.el;
      const area = findComposerArea(composer);
      if (params && params.referenceImage) {
        const attached = await attachImageToComposer(composer, area, params.referenceImage);
        if (!attached.ok) return fail('IMAGE_ATTACH_FAILED', attached.message || '기준 이미지를 Gemini 입력창에 자동으로 첨부하지 못했습니다. 이미지를 직접 붙여넣거나 「… → 텍스트만으로 동영상 생성」을 이용해 주세요.', true);
      }
      const usedComposer = (findComposer() && findComposer().el) || composer;
      const text = params.marker ? `${params.prompt}\n\n${params.marker}` : params.prompt;
      const baseline = snapshot();
      const ins = await insertPrompt(usedComposer, text, params.marker);
      if (!ins.ok) {
        clearComposer(usedComposer);
        return Object.assign(fail('INSERT_FAILED', '입력창에 프롬프트를 넣지 못했습니다(입력 방식 미지원 가능). 전송하지 않았습니다.', true), { attempts: ins.attempts });
      }
      const btn = await waitFor(() => { const b = findSend(); return b && isEnabled(b.el) ? b : null; }, timing.sendEnableWaitMs);
      if (!btn) {
        clearComposer(usedComposer);
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

    /** 응답 블록 안에서 생성된 이미지(<img>) 요소들을 찾는다 (아이콘·사고과정 내부 제외) */
    function findGeneratedImages(responseEl) {
      if (!responseEl) return [];
      const list = SEL.generatedImage || [];
      const seen = new Set();
      const out = [];
      for (let i = 0; i < list.length; i++) {
        let nodes;
        try { nodes = responseEl.querySelectorAll(list[i].sel); } catch { continue; }
        for (const img of nodes) {
          if (seen.has(img)) continue;
          seen.add(img);
          if (!isVisible(img)) continue;
          if (img.closest && img.closest('model-thoughts')) continue;
          let src = (img.getAttribute('src') || img.src || '').trim();
          if (!src) {
            const srcset = (img.getAttribute('srcset') || '').trim();
            if (srcset) src = srcset.split(',')[0].trim().split(/\s+/)[0] || '';
          }
          if (!src || src === 'about:blank') continue;
          // 아바타·아이콘 제외
          const altOrClass = ((img.getAttribute('alt') || '') + ' ' + (img.className || '')).toLowerCase();
          if (/\b(?:avatar|profile-icon|favicon)\b/.test(altOrClass)) continue;
          // 명시적 크기가 48px 미만인 작은 아이콘은 제외
          const w = Number(img.naturalWidth || img.width || img.getAttribute('width') || 0);
          const h = Number(img.naturalHeight || img.height || img.getAttribute('height') || 0);
          if ((w > 0 && w < 48) || (h > 0 && h < 48)) continue;
          if (img.complete === false && !src.startsWith('data:image/') && !img.getAttribute('width')) continue;
          out.push({ el: img, src, selector: list[i].sel });
        }
      }
      return out;
    }

    /** 마우스 호버 시에만 다운로드 오버레이 버튼을 활성화하는 UI에 대응 */
    function revealImageActions(responseEl, imgEl) {
      const targets = [];
      if (imgEl) {
        targets.push(imgEl);
        if (imgEl.parentElement) targets.push(imgEl.parentElement);
      }
      const container = find('imageContainer', responseEl);
      if (container && container.el) targets.push(container.el);
      if (responseEl) targets.push(responseEl);
      for (const t of targets) {
        try {
          t.dispatchEvent(new win.Event('mouseenter', { bubbles: true }));
          t.dispatchEvent(new win.Event('mouseover', { bubbles: true }));
        } catch { /* ignore */ }
      }
    }

    /**
     * 응답 블록 안에서 생성 이미지 다운로드 버튼을 찾는다.
     * 1) 보이는(isVisible) 활성 버튼 우선
     * 2) 호버 전 opacity:0 / visibility:hidden 상태인 다운로드 전용 버튼도 DOM에 연결되어 있으면 허용
     * 3) generated-image / single-image 내부의 mat-icon="download" 버튼 대체 탐색
     */
    function findImageDownloadButton(responseEl, imgEl) {
      if (!responseEl) return null;
      revealImageActions(responseEl, imgEl);
      const visibleBtn = find('imageDownloadButton', responseEl, (el) => isEnabled(el) && !(el.closest && el.closest('model-thoughts')));
      if (visibleBtn) return visibleBtn;

      const list = SEL.imageDownloadButton || [];
      for (let i = 0; i < list.length; i++) {
        let nodes;
        try { nodes = responseEl.querySelectorAll(list[i].sel); } catch { continue; }
        for (const el of nodes) {
          if (!el || !el.isConnected) continue;
          if (el.closest && el.closest('model-thoughts')) continue;
          const target = el.tagName === 'BUTTON' ? el : (el.querySelector && el.querySelector('button')) || el;
          if (!isEnabled(target)) continue;
          return { el: target, selector: list[i].sel, index: i };
        }
      }

      // mat-icon 텍스트 또는 fonticon이 download인 버튼 보조 탐색
      try {
        const icons = responseEl.querySelectorAll('generated-image mat-icon, single-image mat-icon, model-response mat-icon');
        for (const icon of icons) {
          const iconName = ((icon.getAttribute('fonticon') || '') + ' ' + (icon.textContent || '')).trim().toLowerCase();
          if (/\b(?:download|file_download|save_alt)\b/.test(iconName)) {
            const btn = icon.closest && icon.closest('button');
            if (btn && isEnabled(btn) && !(btn.closest && btn.closest('model-thoughts'))) {
              return { el: btn, selector: 'mat-icon[download]', index: -1 };
            }
          }
        }
      } catch { /* ignore */ }
      return null;
    }

    /** 생성된 <img>에서 base64 dataUrl 또는 원본 URL을 추출 */
    async function extractImageData(imgEl, src) {
      if (!src) return { imageDataUrl: undefined, imageUrl: '', mimeType: 'image/png', method: 'none' };
      if (src.startsWith('data:image/')) {
        const mimeMatch = src.match(/^data:(image\/[a-z0-9.+-]+);/i);
        return { imageDataUrl: src, imageUrl: src, mimeType: mimeMatch ? mimeMatch[1] : 'image/png', method: 'data-url' };
      }
      // 1) 페이지 컨텍스트 fetch (blob: 또는 CORS 허용 이미지)
      if (typeof win.fetch === 'function' && typeof win.FileReader === 'function') {
        try {
          const res = await win.fetch(src, { credentials: 'include' });
          if (res && res.ok) {
            const blob = await res.blob();
            if (blob && blob.size > 0 && (!blob.type || blob.type.startsWith('image/'))) {
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new win.FileReader();
                reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                reader.onerror = () => reject(new Error('FileReader failed'));
                reader.readAsDataURL(blob);
              });
              if (dataUrl && dataUrl.startsWith('data:image/')) {
                return { imageDataUrl: dataUrl, imageUrl: src, mimeType: blob.type || 'image/png', method: 'fetch-blob' };
              }
            }
          }
        } catch { /* fall through to canvas or url-only */ }
      }
      // 2) Canvas toDataURL 시도
      try {
        const w = Number(imgEl.naturalWidth || imgEl.width || 0);
        const h = Number(imgEl.naturalHeight || imgEl.height || 0);
        if (w >= 48 && h >= 48 && typeof doc.createElement === 'function') {
          const canvas = doc.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx2d = canvas.getContext && canvas.getContext('2d');
          if (ctx2d) {
            ctx2d.drawImage(imgEl, 0, 0);
            const dataUrl = canvas.toDataURL('image/png');
            if (dataUrl && dataUrl.startsWith('data:image/png;base64,') && dataUrl.length > 64) {
              return { imageDataUrl: dataUrl, imageUrl: src, mimeType: 'image/png', method: 'canvas' };
            }
          }
        }
      } catch { /* cross-origin canvas tainted; fallback to download button */ }
      return { imageDataUrl: undefined, imageUrl: src, mimeType: 'image/png', method: 'url-only' };
    }

    /**
     * Phase 5 개선(반자동 이미지 수신):
     * 1) 이번 요청의 응답 블록(locateResponse) 안에서 생성 이미지(또는 이미지 컨테이너/다운로드 버튼) 감지
     * 2) dataUrl 직접 추출 시도 → 성공 시 즉시 반환
     * 3) dataUrl 추출 실패/CORS 차단 시 다운로드 버튼(findImageDownloadButton)을 찾아 클릭하고 downloadClicked: true 반환
     * 4) 다운로드 버튼도 찾지 못하면 무한 대기하지 않고 downloadButtonMissing: true로 즉시 보고
     * 5) 생성이 끝났으나 이미지가 전혀 없으면 NO_IMAGE_GENERATED 또는 IMAGE_DETECT_FAILED로 즉시 전환 (응답 대기 멈춤 방지)
     */
    async function watchImage(ctx, onProgress) {
      const start = now();
      const noImageIdleLimit = timing.noImageIdleMs || Math.max(timing.stableMs * 4, 800);
      let lastSig = null; let lastChange = now(); let stopSeen = false; let lastProgress = 0; let found = null;
      for (;;) {
        await sleep(timing.pollMs);
        const t = now();
        if (detectBlocked()) return { ok: false, errorCode: 'BLOCKED', needsUser: true, message: '이미지 생성 대기 중 Google 보안 확인 화면이 나타났습니다.' };
        const stopActive = !!findStop();
        if (stopActive) stopSeen = true;
        const loc = locateResponse(ctx);
        if (!loc) {
          if (t - start > timing.firstResponseTimeoutMs) return { ok: false, errorCode: 'NO_RESPONSE_NODE', needsUser: true, message: '전송 후 Gemini 응답 블록을 찾지 못했습니다.' };
          if (t - start > timing.maxWaitMs) return { ok: false, errorCode: 'RESPONSE_TIMEOUT', needsUser: true, message: '이미지 생성 대기 시간이 초과되었습니다.' };
          continue;
        }
        found = loc;
        const imgLoading = !!find('imageGenerating', loc.el);
        const generating = stopActive || imgLoading;
        if (generating) stopSeen = true;

        const ex = extract(loc.el);
        const imgs = findGeneratedImages(loc.el);
        const hasContainer = !!find('imageContainer', loc.el);
        const dlBtnCandidate = (!generating && (imgs.length > 0 || hasContainer)) ? findImageDownloadButton(loc.el, imgs[0] && imgs[0].el) : null;
        const sig = `${ex.text}::${imgs.map((x) => x.src).join('|')}::${hasContainer ? 'C' : ''}`;
        if (sig !== lastSig) { lastSig = sig; lastChange = t; }

        if (onProgress && t - lastProgress >= timing.progressThrottleMs) {
          lastProgress = t;
          onProgress((imgs.length > 0 || hasContainer) ? 'collecting' : 'waiting', {
            chars: ex.text.length,
            images: imgs.length,
            hasContainer,
            generating,
            isolation: loc.isolation
          });
        }

        const stableFor = t - lastChange;
        const actions = !!find('responseActions', loc.el) || !!dlBtnCandidate;
        const needStable = actions ? timing.stableMs : (stopSeen ? timing.stableMs * 2 : timing.stableMs * 3);

        // 1) 이미지(또는 이미지 컨테이너)가 생성 완료되어 안정화된 경우
        if (!generating && (imgs.length > 0 || (hasContainer && dlBtnCandidate)) && stableFor >= timing.stableMs) {
          const picked = imgs[0] || null;
          const extracted = picked
            ? await extractImageData(picked.el, picked.src)
            : { imageDataUrl: undefined, imageUrl: '', mimeType: 'image/png', method: 'container-only' };

          // 1-A) dataUrl 직접 추출에 성공했고 크기가 안전한 경우(750KB 이하) 그대로 반환
          // 고해상도 이미지(>750KB)는 Native Messaging 부하를 피하고 원본 화질 확보를 위해 다운로드 버튼 경로를 우선 시도
          const dlBtn = dlBtnCandidate || findImageDownloadButton(loc.el, picked && picked.el);
          const preferDownloadBtn = Boolean(dlBtn && dlBtn.el && extracted.imageDataUrl && extracted.imageDataUrl.length > 750 * 1024);

          if (extracted.imageDataUrl && !preferDownloadBtn) {
            return {
              ok: true,
              text: ex.text,
              codeBlocks: ex.codeBlocks,
              isolation: loc.isolation,
              imageDataUrl: extracted.imageDataUrl,
              imageUrl: extracted.imageUrl,
              mimeType: extracted.mimeType,
              imageMethod: extracted.method,
              imageSelector: picked ? picked.selector : 'imageContainer',
              downloadClicked: false,
              completion: { stopSeen, actions, stableMs: stableFor }
            };
          }

          // 1-B) dataUrl 추출 실패(CORS 등) 또는 고해상도 대용량 → 다운로드 버튼을 찾아 클릭 시도
          if (dlBtn && dlBtn.el) {
            try {
              dlBtn.el.click();
              return {
                ok: true,
                text: ex.text,
                codeBlocks: ex.codeBlocks,
                isolation: loc.isolation,
                imageUrl: extracted.imageUrl,
                mimeType: extracted.mimeType,
                imageMethod: 'download-button',
                imageSelector: picked ? picked.selector : 'imageContainer',
                downloadClicked: true,
                downloadButtonSelector: dlBtn.selector,
                completion: { stopSeen, actions, stableMs: stableFor }
              };
            } catch { /* 클릭 예외 시 아래 대체 경로 */ }
          }

          // 1-B-2) 다운로드 버튼 클릭 실패 시 추출해 둔 dataUrl이라도 있으면 반환
          if (extracted.imageDataUrl) {
            return {
              ok: true,
              text: ex.text,
              codeBlocks: ex.codeBlocks,
              isolation: loc.isolation,
              imageDataUrl: extracted.imageDataUrl,
              imageUrl: extracted.imageUrl,
              mimeType: extracted.mimeType,
              imageMethod: extracted.method,
              imageSelector: picked ? picked.selector : 'imageContainer',
              downloadClicked: false,
              completion: { stopSeen, actions, stableMs: stableFor }
            };
          }

          // 1-C) 이미지는 감지되었으나 dataUrl도 안 되고 다운로드 버튼도 찾지 못한 경우 → 즉시 보고하여 수동 안내로 전환
          return {
            ok: true,
            text: ex.text,
            codeBlocks: ex.codeBlocks,
            isolation: loc.isolation,
            imageUrl: extracted.imageUrl,
            mimeType: extracted.mimeType,
            imageMethod: 'manual-needed',
            imageSelector: picked ? picked.selector : 'imageContainer',
            downloadClicked: false,
            downloadButtonMissing: true,
            completion: { stopSeen, actions, stableMs: stableFor }
          };
        }

        // 2) 이미지 없이 텍스트 응답만 완료된 경우 (정책 거부·설명 응답 등)
        if (!generating && imgs.length === 0 && !hasContainer && ex.text && stableFor >= needStable) {
          return {
            ok: false,
            errorCode: 'NO_IMAGE_GENERATED',
            needsUser: true,
            message: 'Gemini가 이미지를 생성하지 않고 텍스트로만 응답했습니다. 프롬프트 정책 제한 또는 모델 상태를 확인해 주세요.',
            partialText: ex.text
          };
        }

        // 3) 생성이 멈췄는데(텍스트도 없고 이미지 셀렉터도 안 맞음) 일정 시간 이상 변화가 없는 경우 → 무한 대기 방지!
        if (!generating && imgs.length === 0 && !hasContainer && !ex.text && stableFor >= noImageIdleLimit) {
          // 혹시 다운로드 버튼만이라도 응답 블록에 존재하는지 마지막으로 확인
          const fallbackDl = findImageDownloadButton(loc.el, null);
          if (fallbackDl && fallbackDl.el) {
            try {
              fallbackDl.el.click();
              return {
                ok: true,
                text: '',
                codeBlocks: [],
                isolation: loc.isolation,
                imageMethod: 'download-button-fallback',
                downloadClicked: true,
                downloadButtonSelector: fallbackDl.selector,
                completion: { stopSeen, actions: true, stableMs: stableFor }
              };
            } catch { /* ignore */ }
          }
          return {
            ok: false,
            errorCode: 'IMAGE_DETECT_FAILED',
            needsUser: true,
            message: 'Gemini에서 이미지가 생성되었습니다. 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.',
            partialText: ''
          };
        }

        if (t - start > timing.maxWaitMs) {
          return { ok: false, errorCode: 'RESPONSE_TIMEOUT', needsUser: true, message: '이미지 생성 완료를 제시간에 확인하지 못했습니다(시간 초과).', partialText: found ? ex.text : '' };
        }
      }
    }

    /**
     * Phase 5 확장: 동영상/음악 생성 요소 탐색.
     * 주의: Gemini 웹의 동영상(Veo)·음악(Lyria) 생성은 계정 등급·지역·UI 변경에 따라 불안정하거나 제한될 수 있습니다.
     */
    function findGeneratedMedia(responseEl, kind) {
      if (!responseEl) return [];
      const group = kind === 'video' ? 'generatedVideo' : 'generatedAudio';
      const list = SEL[group] || [];
      const seen = new Set();
      const out = [];
      for (let i = 0; i < list.length; i++) {
        let nodes;
        try { nodes = responseEl.querySelectorAll(list[i].sel); } catch { continue; }
        for (const el of nodes) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (el.closest && el.closest('model-thoughts')) continue;
          const mediaEl = el.tagName === 'SOURCE' && el.parentElement ? el.parentElement : el;
          const src = (
            el.getAttribute('src') ||
            el.src ||
            mediaEl.getAttribute('src') ||
            mediaEl.currentSrc ||
            (mediaEl.querySelector && mediaEl.querySelector('source[src]') && mediaEl.querySelector('source[src]').getAttribute('src')) ||
            ''
          ).trim();
          out.push({ el: mediaEl, src, selector: list[i].sel });
        }
      }
      return out;
    }

    /** 응답 블록 안에서 동영상/음악 다운로드 버튼 탐색 */
    function findMediaDownloadButton(responseEl, mediaEl) {
      if (!responseEl) return null;
      revealImageActions(responseEl, mediaEl);
      const visibleBtn = find('mediaDownloadButton', responseEl, (el) => isEnabled(el) && !(el.closest && el.closest('model-thoughts')));
      if (visibleBtn) return visibleBtn;

      const list = SEL.mediaDownloadButton || [];
      for (let i = 0; i < list.length; i++) {
        let nodes;
        try { nodes = responseEl.querySelectorAll(list[i].sel); } catch { continue; }
        for (const el of nodes) {
          if (!el || !el.isConnected) continue;
          if (el.closest && el.closest('model-thoughts')) continue;
          const target = el.tagName === 'BUTTON' ? el : (el.querySelector && el.querySelector('button')) || el;
          if (!isEnabled(target)) continue;
          return { el: target, selector: list[i].sel, index: i };
        }
      }
      // mat-icon="download" 보조 탐색
      try {
        const icons = responseEl.querySelectorAll('model-response mat-icon, generated-video mat-icon, generated-audio mat-icon');
        for (const icon of icons) {
          const iconName = ((icon.getAttribute('fonticon') || '') + ' ' + (icon.textContent || '')).trim().toLowerCase();
          if (/\b(?:download|file_download|save_alt)\b/.test(iconName)) {
            const btn = icon.closest && icon.closest('button');
            if (btn && isEnabled(btn) && !(btn.closest && btn.closest('model-thoughts'))) {
              return { el: btn, selector: 'mat-icon[download]', index: -1 };
            }
          }
        }
      } catch { /* ignore */ }
      return null;
    }

    /** 작은 data:/blob: 미디어만 직접 dataUrl 추출 시도 (대용량 동영상·오디오는 다운로드 버튼 우선) */
    async function extractMediaData(src, kind) {
      const defaultMime = kind === 'video' ? 'video/mp4' : 'audio/mpeg';
      if (!src) return { mediaDataUrl: undefined, mediaUrl: '', mimeType: defaultMime, method: 'none' };
      if (src.startsWith('data:video/') || src.startsWith('data:audio/')) {
        const mimeMatch = src.match(/^data:((?:video|audio)\/[a-z0-9.+-]+);/i);
        return { mediaDataUrl: src, mediaUrl: src, mimeType: mimeMatch ? mimeMatch[1] : defaultMime, method: 'data-url' };
      }
      if (src.startsWith('blob:') && typeof win.fetch === 'function' && typeof win.FileReader === 'function') {
        try {
          const res = await win.fetch(src, { credentials: 'include' });
          if (res && res.ok) {
            const blob = await res.blob();
            if (blob && blob.size > 0 && blob.size <= 750 * 1024) {
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new win.FileReader();
                reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                reader.onerror = () => reject(new Error('FileReader failed'));
                reader.readAsDataURL(blob);
              });
              if (dataUrl && /^data:(?:video|audio)\//i.test(dataUrl)) {
                return { mediaDataUrl: dataUrl, mediaUrl: src, mimeType: blob.type || defaultMime, method: 'fetch-blob' };
              }
            }
          }
        } catch { /* fall through to download button */ }
      }
      return { mediaDataUrl: undefined, mediaUrl: src, mimeType: defaultMime, method: 'url-only' };
    }

    /**
     * Phase 5 확장(반자동 동영상·배경음악 수신):
     * - 생성 완료 감지 → 다운로드 버튼 클릭 시도 → chrome.downloads로 파일 경로 확보
     * - 작은 dataUrl 추출이 되면 그것도 허용
     * - 일정 시간 내 미디어/버튼 미발견 시 무한 대기하지 않고 needsUser로 즉시 전환
     */
    async function watchMedia(ctx, kind, onProgress) {
      const start = now();
      const noMediaIdleLimit = timing.noImageIdleMs || Math.max(timing.stableMs * 4, 800);
      const containerGroup = kind === 'video' ? 'videoContainer' : 'audioContainer';
      const noMediaCode = kind === 'video' ? 'NO_VIDEO_GENERATED' : 'NO_MUSIC_GENERATED';
      const labelKo = kind === 'video' ? '동영상' : '배경음악';
      let lastSig = null; let lastChange = now(); let stopSeen = false; let lastProgress = 0; let found = null;

      for (;;) {
        await sleep(timing.pollMs);
        const t = now();
        if (detectBlocked()) return { ok: false, errorCode: 'BLOCKED', needsUser: true, message: `${labelKo} 생성 대기 중 Google 보안 확인 화면이 나타났습니다.` };
        const stopActive = !!findStop();
        if (stopActive) stopSeen = true;
        const loc = locateResponse(ctx);
        if (!loc) {
          if (t - start > timing.firstResponseTimeoutMs) return { ok: false, errorCode: 'NO_RESPONSE_NODE', needsUser: true, message: '전송 후 Gemini 응답 블록을 찾지 못했습니다.' };
          if (t - start > timing.maxWaitMs) return { ok: false, errorCode: 'RESPONSE_TIMEOUT', needsUser: true, message: `${labelKo} 생성 대기 시간이 초과되었습니다.` };
          continue;
        }
        found = loc;
        const loading = !!find('imageGenerating', loc.el);
        const generating = stopActive || loading;
        if (generating) stopSeen = true;

        const ex = extract(loc.el);
        const medias = findGeneratedMedia(loc.el, kind);
        const hasContainer = !!find(containerGroup, loc.el);
        const dlBtnCandidate = (!generating && (medias.length > 0 || hasContainer)) ? findMediaDownloadButton(loc.el, medias[0] && medias[0].el) : null;
        const sig = `${ex.text}::${medias.map((x) => x.src || x.selector).join('|')}::${hasContainer ? 'C' : ''}`;
        if (sig !== lastSig) { lastSig = sig; lastChange = t; }

        if (onProgress && t - lastProgress >= timing.progressThrottleMs) {
          lastProgress = t;
          onProgress((medias.length > 0 || hasContainer) ? 'collecting' : 'waiting', {
            chars: ex.text.length,
            mediaCount: medias.length,
            hasContainer,
            generating,
            isolation: loc.isolation
          });
        }

        const stableFor = t - lastChange;
        const actions = !!find('responseActions', loc.el) || !!dlBtnCandidate;
        const needStable = actions ? timing.stableMs : (stopSeen ? timing.stableMs * 2 : timing.stableMs * 3);

        // 1) 동영상/음악 요소 또는 컨테이너가 안정적으로 나타난 경우
        if (!generating && (medias.length > 0 || (hasContainer && dlBtnCandidate)) && stableFor >= timing.stableMs) {
          const picked = medias[0] || null;
          const dlBtn = dlBtnCandidate || findMediaDownloadButton(loc.el, picked && picked.el);
          const extracted = picked ? await extractMediaData(picked.src, kind) : { mediaDataUrl: undefined, mediaUrl: '', mimeType: kind === 'video' ? 'video/mp4' : 'audio/mpeg', method: 'container-only' };

          // 1-A) 작은 dataUrl 직접 추출 성공 시(다운로드 버튼이 없거나 750KB 이하)
          if (extracted.mediaDataUrl && (!dlBtn || extracted.mediaDataUrl.length <= 750 * 1024)) {
            return {
              ok: true,
              text: ex.text,
              codeBlocks: ex.codeBlocks,
              isolation: loc.isolation,
              mediaDataUrl: extracted.mediaDataUrl,
              mediaUrl: extracted.mediaUrl,
              mimeType: extracted.mimeType,
              mediaMethod: extracted.method,
              downloadClicked: false,
              completion: { stopSeen, actions, stableMs: stableFor }
            };
          }

          // 1-B) 다운로드 버튼 클릭 시도 (chrome.downloads로 로컬 파일 경로 수신)
          if (dlBtn && dlBtn.el) {
            try {
              dlBtn.el.click();
              return {
                ok: true,
                text: ex.text,
                codeBlocks: ex.codeBlocks,
                isolation: loc.isolation,
                mediaUrl: extracted.mediaUrl,
                mimeType: extracted.mimeType,
                mediaMethod: 'download-button',
                downloadClicked: true,
                downloadButtonSelector: dlBtn.selector,
                completion: { stopSeen, actions, stableMs: stableFor }
              };
            } catch { /* fallback below */ }
          }

          if (extracted.mediaDataUrl) {
            return {
              ok: true,
              text: ex.text,
              codeBlocks: ex.codeBlocks,
              isolation: loc.isolation,
              mediaDataUrl: extracted.mediaDataUrl,
              mediaUrl: extracted.mediaUrl,
              mimeType: extracted.mimeType,
              mediaMethod: extracted.method,
              downloadClicked: false,
              completion: { stopSeen, actions, stableMs: stableFor }
            };
          }

          // 1-C) 미디어는 감지했으나 다운로드 버튼을 못 찾음 → 즉시 수동 안내로 전환
          return {
            ok: true,
            text: ex.text,
            codeBlocks: ex.codeBlocks,
            isolation: loc.isolation,
            mediaUrl: extracted.mediaUrl,
            mimeType: extracted.mimeType,
            mediaMethod: 'manual-needed',
            downloadClicked: false,
            downloadButtonMissing: true,
            completion: { stopSeen, actions, stableMs: stableFor }
          };
        }

        // 2) 미디어 없이 텍스트만 완료된 경우
        if (!generating && medias.length === 0 && !hasContainer && ex.text && stableFor >= needStable) {
          return {
            ok: false,
            errorCode: noMediaCode,
            needsUser: true,
            message: `Gemini가 ${labelKo}을(를) 생성하지 않고 텍스트로만 응답했습니다. Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.`,
            partialText: ex.text
          };
        }

        // 3) 생성 종료 후 텍스트·미디어 셀렉터 모두 비어 정체된 경우 → 무한 대기 방지
        if (!generating && medias.length === 0 && !hasContainer && !ex.text && stableFor >= noMediaIdleLimit) {
          const fallbackDl = findMediaDownloadButton(loc.el, null);
          if (fallbackDl && fallbackDl.el) {
            try {
              fallbackDl.el.click();
              return {
                ok: true,
                text: '',
                codeBlocks: [],
                isolation: loc.isolation,
                mediaMethod: 'download-button-fallback',
                downloadClicked: true,
                downloadButtonSelector: fallbackDl.selector,
                completion: { stopSeen, actions: true, stableMs: stableFor }
              };
            } catch { /* ignore */ }
          }
          return {
            ok: false,
            errorCode: 'MEDIA_DETECT_FAILED',
            needsUser: true,
            message: 'Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.',
            partialText: ''
          };
        }

        if (t - start > timing.maxWaitMs) {
          return { ok: false, errorCode: 'RESPONSE_TIMEOUT', needsUser: true, message: `${labelKo} 생성 완료를 제시간에 확인하지 못했습니다(시간 초과).`, partialText: found ? ex.text : '' };
        }
      }
    }

    function watchVideo(ctx, onProgress) { return watchMedia(ctx, 'video', onProgress); }
    function watchMusic(ctx, onProgress) { return watchMedia(ctx, 'music', onProgress); }

    /**
     * 재전송 없이, 이미 대화에 있는 생성 미디어를 다시 찾아 받는다.
     *  - 쓰는 곳: Gemini가 '다운로드됨'만 띄우고 파일이 오지 않을 때 탭을 새로고침한 뒤 다시 받기, 앱의 「다시 가져오기」
     *  - marker가 있으면 그 표식이 들어간 질문 바로 뒤 응답만 본다(다른 장면 이미지를 잘못 가져오지 않게)
     *  - allowLatest: 표식 질문을 못 찾으면 가장 최근 미디어 응답을 쓴다(같은 탭에서 방금 끝난 작업의 재시도일 때만)
     *  - 프롬프트는 절대 입력·전송하지 않는다
     */
    async function collectMedia(params) {
      const p = params || {};
      const stage = p.stage === 'video' || p.stage === 'music' ? p.stage : 'image';
      const kind = stage === 'music' ? 'music' : stage;
      const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : (timing.recollectTimeoutMs || 20000);
      const start = now();
      let lastMissing = null;
      for (;;) {
        const all = findAll('modelResponse').els;
        let candidates = [];
        let isolation = 'latest';
        const q = p.marker ? markerQuery(p.marker, null) : null;
        if (q) {
          const after = all.filter((r) => q.compareDocumentPosition(r) & 4 /* FOLLOWING */);
          candidates = after.length ? [after[0]] : [];
          isolation = 'marker';
        } else if (!p.marker || p.allowLatest) {
          candidates = all.slice().reverse();
        }
        for (const el of candidates) {
          if (find('imageGenerating', el) || findStop()) continue; // 아직 만드는 중
          const ex = extract(el);
          if (kind === 'image') {
            const imgs = findGeneratedImages(el);
            const hasContainer = !!find('imageContainer', el);
            if (!imgs.length && !hasContainer) continue;
            const picked = imgs[0] || null;
            const extracted = picked ? await extractImageData(picked.el, picked.src) : { imageDataUrl: undefined, imageUrl: '', mimeType: 'image/png', method: 'container-only' };
            const dlBtn = findImageDownloadButton(el, picked && picked.el);
            const base = { ok: true, text: ex.text, codeBlocks: ex.codeBlocks, isolation, imageUrl: extracted.imageUrl, mimeType: extracted.mimeType, recollected: true };
            if (extracted.imageDataUrl && (!dlBtn || extracted.imageDataUrl.length <= 750 * 1024)) {
              return { ...base, imageDataUrl: extracted.imageDataUrl, imageMethod: extracted.method, downloadClicked: false };
            }
            if (dlBtn && dlBtn.el) {
              try { dlBtn.el.click(); return { ...base, imageMethod: 'download-button', downloadClicked: true, downloadButtonSelector: dlBtn.selector }; } catch { /* 아래 */ }
            }
            if (extracted.imageDataUrl) return { ...base, imageDataUrl: extracted.imageDataUrl, imageMethod: extracted.method, downloadClicked: false };
            lastMissing = { ...base, imageMethod: 'manual-needed', downloadClicked: false, downloadButtonMissing: true };
          } else {
            const medias = findGeneratedMedia(el, kind);
            const hasContainer = !!find(kind === 'video' ? 'videoContainer' : 'audioContainer', el);
            if (!medias.length && !hasContainer) continue;
            const picked = medias[0] || null;
            const extracted = picked ? await extractMediaData(picked.src, kind) : { mediaDataUrl: undefined, mediaUrl: '', mimeType: kind === 'video' ? 'video/mp4' : 'audio/mpeg', method: 'container-only' };
            const dlBtn = findMediaDownloadButton(el, picked && picked.el);
            const base = { ok: true, text: ex.text, codeBlocks: ex.codeBlocks, isolation, mediaUrl: extracted.mediaUrl, mimeType: extracted.mimeType, recollected: true };
            if (extracted.mediaDataUrl && (!dlBtn || extracted.mediaDataUrl.length <= 750 * 1024)) {
              return { ...base, mediaDataUrl: extracted.mediaDataUrl, mediaMethod: extracted.method, downloadClicked: false };
            }
            if (dlBtn && dlBtn.el) {
              try { dlBtn.el.click(); return { ...base, mediaMethod: 'download-button', downloadClicked: true, downloadButtonSelector: dlBtn.selector }; } catch { /* 아래 */ }
            }
            if (extracted.mediaDataUrl) return { ...base, mediaDataUrl: extracted.mediaDataUrl, mediaMethod: extracted.method, downloadClicked: false };
            lastMissing = { ...base, mediaMethod: 'manual-needed', downloadClicked: false, downloadButtonMissing: true };
          }
          break; // 표식 응답(또는 가장 최근 미디어 응답) 하나만 본다
        }
        if (now() - start >= timeoutMs) {
          if (lastMissing) return lastMissing;
          return { ok: false, errorCode: 'MEDIA_NOT_FOUND', needsUser: true, message: 'Gemini 대화에서 생성된 파일을 다시 찾지 못했습니다. Gemini에서 직접 받아 「가져와서 연결」을 눌러 주세요.' };
        }
        await sleep(Math.max(50, Math.min(timing.pollMs, 400)));
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
      const area = findComposerArea(composer && composer.el);
      const plus = area ? findToolMenuButton(area) : null;
      const activeTool = readActiveToolMode(area);
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
          toolMenuButton: plus ? plus.selector : null,
          activeToolMode: activeTool.mode,
          toolChipVia: activeTool.via,
          userQueries: findAll('userQuery').els.length,
          modelResponses: findAll('modelResponse').els.length,
          signIn: !!find('signIn'),
          blocked: !!detectBlocked()
        },
        groups
      };
    }

    return { submit, watch, watchImage, watchVideo, watchMusic, collectMedia, findGeneratedImages, findGeneratedMedia, findImageDownloadButton, findMediaDownloadButton, extractImageData, probe, preflight, insertPrompt, extract, locateResponse, snapshot, normalize, blockText, find, findAll, label, ensureToolMode, readActiveToolMode, targetModeForStage, findComposerArea, findToolMenuButton, attachImageToComposer, hasAttachedPreview };
  }

  root.GomoGeminiDom = { createGeminiDom, DEFAULT_TIMING };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.GomoGeminiDom;
})(typeof globalThis !== 'undefined' ? globalThis : self);
