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
    noImageIdleMs: 12000,       // 이미지 응답 생성 종료 후 이미지/텍스트가 모두 없을 때 대기 상한
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

    return { submit, watch, watchImage, watchVideo, watchMusic, findGeneratedImages, findGeneratedMedia, findImageDownloadButton, findMediaDownloadButton, extractImageData, probe, preflight, insertPrompt, extract, locateResponse, snapshot, normalize, blockText, find, findAll, label };
  }

  root.GomoGeminiDom = { createGeminiDom, DEFAULT_TIMING };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.GomoGeminiDom;
})(typeof globalThis !== 'undefined' ? globalThis : self);
