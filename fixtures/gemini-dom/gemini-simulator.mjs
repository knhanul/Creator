/**
 * gemini-like.html 위에서 Gemini의 "겉보기 동작"을 흉내 내는 테스트용 시뮬레이터.
 * 실제 Gemini 동작과 다를 수 있습니다(모형). 입력 → 전송 버튼 활성화 → 질문/응답 블록 추가 → 스트리밍 → 완료.
 */
export function installGeminiSimulator(win, opts = {}) {
  const doc = win.document;
  const o = { chunkMs: 15, firstDelayMs: 40, thinking: false, noEvidence: false, neverEnable: false, neverFinish: false, rerender: false, pauseMs: 0, ...opts };
  const composer = doc.querySelector('rich-textarea [contenteditable]');
  const send = doc.querySelector('button[data-test-id="send-button"], button.send-button:not(.stop)');
  const stop = doc.querySelector('button[data-test-id="stop-button"]');
  const history = doc.getElementById('chat-history');
  const state = { sentTexts: [], clicks: 0, plusClicks: 0, sidebarClicks: 0, sidebarNewChatClicks: 0, menuItemClicks: [], chipDismisses: 0, newChatConfirmClicks: 0, toolMode: o.initialToolMode || null };
  const text = () => Array.from(composer.querySelectorAll('p')).map(p => p.textContent).join('\n').trim() || composer.textContent.trim();
  const refresh = () => { const has = !!text(); const en = has && !o.neverEnable; send.disabled = !en; send.setAttribute('aria-disabled', String(!en)); composer.classList.toggle('ql-blank', !has); };
  composer.addEventListener('input', refresh);
  installToolUi(doc, o, state, composer);
  send.addEventListener('click', () => {
    state.clicks++;
    if (send.disabled || o.noEvidence) return;
    const prompt = text();
    state.sentTexts.push(prompt);
    composer.innerHTML = '<p><br></p>'; refresh();
    const turn = doc.createElement('div'); turn.className = 'conversation-container';
    const uq = doc.createElement('user-query'); const qt = doc.createElement('div'); qt.className = 'query-text';
    for (const line of prompt.split('\n')) { const p = doc.createElement('p'); p.textContent = line; qt.appendChild(p); }
    uq.appendChild(qt); turn.appendChild(uq); history.appendChild(turn);
    send.hidden = true; stop.hidden = false;
    win.setTimeout(() => stream(turn), o.firstDelayMs);
  });
  function stream(turn) {
    if (o.rerender) {
      // 첫 메시지 후 새 대화 URL로 바뀌며 대화 전체가 새 노드로 다시 그려지는 경우를 흉내
      const clone = history.cloneNode(true); history.replaceWith(clone); clone.id = 'chat-history';
      turn = clone.lastElementChild;
    }
    const mr = doc.createElement('model-response');
    const mc = doc.createElement('message-content'); const md = doc.createElement('div'); md.className = 'markdown markdown-main-panel';
    if (o.thinking) { const th = doc.createElement('model-thoughts'); th.textContent = '생각 중… {"schema":"creator.analysis.v1","fake":true}'; mr.appendChild(th); }
    mc.appendChild(md); mr.appendChild(mc); turn.appendChild(mr);
    // o.intro: 설명 문단, o.code: 코드 블록 안 내용(JSON 등)
    const chunks = (str) => (str ? str.match(/[\s\S]{1,25}/g) : []) || [];
    const parts = [...chunks(o.intro ?? '응답입니다.').map(c => ['p', c]), ...chunks(o.code).map(c => ['code', c])];
    let i = 0; let paused = false;
    const intro = doc.createElement('p'); md.appendChild(intro);
    let codeEl = null;
    const tick = () => {
      if (i >= parts.length) {
        if (o.neverFinish) return;
        stop.hidden = true; send.hidden = false; refresh();
        const acts = doc.createElement('message-actions'); acts.innerHTML = '<button aria-label="Copy"><mat-icon>content_copy</mat-icon></button>'; mr.appendChild(acts);
        return;
      }
      if (o.pauseMs && !paused && i === Math.floor(parts.length / 2)) { paused = true; win.setTimeout(tick, o.pauseMs); return; }
      const [where, chunk] = parts[i++];
      if (where === 'code' && !codeEl) {
        const cb = doc.createElement('code-block');
        cb.innerHTML = '<div class="code-block-decoration"><span>JSON</span><button aria-label="Copy code"><mat-icon>content_copy</mat-icon></button></div><pre><code></code></pre>';
        md.appendChild(cb); codeEl = cb.querySelector('code');
      }
      if (where === 'code') codeEl.textContent += chunk; else intro.textContent += chunk;
      win.setTimeout(tick, o.chunkMs);
    };
    tick();
  }
  return state;
}


/** 입력창 왼쪽 + 메뉴와 도구 칩(동영상/이미지/음악) — 승희님 Gemini UI 모형 */
function installToolUi(doc, o, state, composer) {
  const plus = doc.querySelector('[data-test-id="open-tools-button"], .plus-button');
  const inputArea = doc.querySelector('.input-area, .composer-shell');
  if (!plus || !inputArea || !composer) return;

  let menuOpen = false;
  let menuEl = null;

  for (const el of doc.querySelectorAll('aside button, [data-test-id="sidebar-image"], [data-test-id="sidebar-new-notebook"], [data-test-id="sidebar-new-chat"]')) {
    el.addEventListener('click', () => {
      state.sidebarClicks++;
      const lab = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
      if (/새 채팅|new chat/i.test(lab)) state.sidebarNewChatClicks++;
    });
  }

  function placeholderOf() {
    return ({ video: '동영상을 설명하세요.', image: '이미지를 설명하세요.', music: '음악을 설명하세요.' })[state.toolMode] || 'Ask Gemini';
  }

  function applyComposerAttrs() {
    const ph = placeholderOf();
    composer.setAttribute('data-placeholder', ph);
    composer.setAttribute('aria-label', state.toolMode ? ph : 'Enter a prompt for Gemini');
  }

  function renderChip() {
    let wrap = inputArea.querySelector('.tool-chips');
    if (!wrap) {
      wrap = doc.createElement('div');
      wrap.className = 'tool-chips';
      plus.insertAdjacentElement('afterend', wrap);
    }
    wrap.innerHTML = '';
    if (!state.toolMode) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const labels = { video: '동영상', image: '이미지', music: '음악' };
    const chipIcons = { video: 'movie', image: 'image', music: 'music_note' };
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'tool-chip';
    chip.setAttribute('data-test-id', 'tool-chip');
    chip.setAttribute('aria-pressed', 'true');
    chip.setAttribute('aria-label', labels[state.toolMode]);
    const ic = doc.createElement('mat-icon');
    ic.className = 'material-icons';
    ic.textContent = chipIcons[state.toolMode];
    const span = doc.createElement('span');
    span.textContent = labels[state.toolMode];
    chip.appendChild(ic);
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'chip-dismiss';
    dismiss.setAttribute('aria-label', '제거');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      state.chipDismisses++;
      setMode(null);
    });
    chip.appendChild(span);
    chip.appendChild(dismiss);
    chip.addEventListener('click', (e) => {
      if (e.target === dismiss) return;
      setMode(null);
    });
    wrap.appendChild(chip);
  }

  function setMode(mode) {
    state.toolMode = mode || null;
    applyComposerAttrs();
    renderChip();
  }
  state.setToolMode = setMode;

  function closeNewChatDialog() {
    const dlg = state.newChatDialog;
    if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg);
    state.newChatDialog = null;
  }

  function startNewChat(mode) {
    closeNewChatDialog();
    const history = doc.getElementById('chat-history');
    if (history) history.innerHTML = '';
    setMode(mode);
  }

  function showNewChatDialog(pendingMode) {
    closeNewChatDialog();
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.className = 'cdk-overlay-pane new-chat-confirm';
    const title = doc.createElement('h2');
    title.textContent = o.newChatTitle || '새 채팅을 시작하시겠습니까?';
    const body = doc.createElement('p');
    body.textContent = o.newChatBody != null ? o.newChatBody : '이 도구를 선택하면 새 채팅이 시작됩니다. 언제든지 이 대화로 돌아올 수 있습니다.';
    const cancel = doc.createElement('button');
    cancel.textContent = o.newChatCancelLabel || '취소';
    cancel.addEventListener('click', () => { state.newChatCancelClicks = (state.newChatCancelClicks || 0) + 1; closeNewChatDialog(); });
    const confirm = doc.createElement('button');
    confirm.setAttribute('data-test-id', 'confirm-new-chat');
    confirm.textContent = o.newChatConfirmLabel || '새 채팅';
    confirm.addEventListener('click', () => {
      state.newChatConfirmClicks++;
      startNewChat(pendingMode);
    });
    const skip = doc.createElement('label');
    skip.textContent = '다시 묻지 않음';
    dlg.append(title, body, skip, cancel, confirm);
    doc.body.appendChild(dlg);
    state.newChatDialog = dlg;
  }

  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    menuOpen = false;
    plus.setAttribute('aria-expanded', 'false');
    plus.setAttribute('aria-label', '추가');
    const ic = plus.querySelector('mat-icon');
    if (ic) { ic.setAttribute('fonticon', 'add'); ic.textContent = 'add'; }
  }

  function menuMount() {
    if (o.shadowPopup) {
      let host = doc.getElementById('gomo-toolbox-host');
      if (!host) {
        host = doc.createElement('div');
        host.id = 'gomo-toolbox-host';
        doc.body.appendChild(host);
      }
      if (!host.shadowRoot) host.attachShadow({ mode: 'open' });
      return host.shadowRoot;
    }
    return doc.body;
  }

  function openMenu() {
    closeMenu();
    menuOpen = true;
    plus.setAttribute('aria-expanded', 'true');
    plus.setAttribute('aria-label', '닫기');
    const ic = plus.querySelector('mat-icon');
    if (ic) { ic.setAttribute('fonticon', 'close'); ic.textContent = 'close'; }
    const pane = doc.createElement('div');
    const plain = !!o.plainPopup || !!o.divOnlyItems;
    pane.className = o.blankPopup ? 'blank-tool-shell' : (plain ? 'gemini-tools-panel' : 'cdk-overlay-pane');
    if (o.popupAriaHidden) pane.setAttribute('aria-hidden', 'true');
    if (o.blankPopup) {
      menuMount().appendChild(pane);
      menuEl = pane;
      return;
    }
    const items = [
      '파일 업로드', 'Drive에서 파일 추가', '업로드 더보기',
      'Google 검색', '이미지 만들기', '동영상 만들기', '음악 만들기', 'Canvas', '개인 인텔리전스'
    ].filter((name) => !(o.noVideoMenu && name === '동영상 만들기') && !(o.noImageMenu && name === '이미지 만들기') && !(o.noMusicMenu && name === '음악 만들기'));
    const icons = { '동영상 만들기': 'videocam', '이미지 만들기': 'image', '음악 만들기': 'music_note', 'Google 검색': 'search' };
    const menu = doc.createElement('div');
    if (!plain) menu.setAttribute('role', 'menu');
    const onPick = (name) => {
      state.menuItemClicks.push(name);
      const map = { '이미지 만들기': 'image', '동영상 만들기': 'video', '음악 만들기': 'music' };
      closeMenu();
      const next = map[name];
      if (!next) return;
      if ((next === 'video' || next === 'music') && o.newChatConfirm) {
        showNewChatDialog(next);
        return;
      }
      setMode(state.toolMode === next ? null : next);
    };
    for (const name of items) {
      if (o.divOnlyItems) {
        const row = doc.createElement('div');
        const lab = doc.createElement('span');
        lab.textContent = name;
        row.appendChild(lab);
        row.addEventListener('click', () => onPick(name));
        menu.appendChild(row);
        continue;
      }
      const it = doc.createElement('button');
      if (!plain) it.setAttribute('role', 'menuitem');
      const ico = doc.createElement('mat-icon');
      ico.className = 'material-icons';
      ico.textContent = icons[name] || 'add';
      const lab = doc.createElement('span');
      lab.textContent = name;
      it.appendChild(ico);
      it.appendChild(lab);
      it.addEventListener('click', () => onPick(name));
      menu.appendChild(it);
    }
    pane.appendChild(menu);
    menuMount().appendChild(pane);
    menuEl = pane;
  }

  plus.addEventListener('click', () => {
    state.plusClicks++;
    if (menuOpen) closeMenu();
    else openMenu();
  });
  doc.addEventListener('keydown', (e) => {
    if (o.ignoreEscape) return;
    if (e.key === 'Escape' || e.keyCode === 27) closeMenu();
  });

  if (state.toolMode) setMode(state.toolMode);
}
