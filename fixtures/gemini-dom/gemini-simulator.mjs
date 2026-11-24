/**
 * gemini-like.html 위에서 Gemini의 "겉보기 동작"을 흉내 내는 테스트용 시뮬레이터.
 * 실제 Gemini 동작과 다를 수 있습니다(모형). 입력 → 전송 버튼 활성화 → 질문/응답 블록 추가 → 스트리밍 → 완료.
 */
export function installGeminiSimulator(win, opts = {}) {
  const doc = win.document;
  const o = { chunkMs: 15, firstDelayMs: 40, thinking: false, noEvidence: false, neverEnable: false, neverFinish: false, rerender: false, pauseMs: 0, ...opts };
  const composer = doc.querySelector('rich-textarea [contenteditable]');
  const send = doc.querySelector('button[data-test-id="send-button"]');
  const stop = doc.querySelector('button[data-test-id="stop-button"]');
  const history = doc.getElementById('chat-history');
  const state = { sentTexts: [], clicks: 0 };
  const text = () => Array.from(composer.querySelectorAll('p')).map(p => p.textContent).join('\n').trim() || composer.textContent.trim();
  const refresh = () => { const has = !!text(); const en = has && !o.neverEnable; send.disabled = !en; send.setAttribute('aria-disabled', String(!en)); composer.classList.toggle('ql-blank', !has); };
  composer.addEventListener('input', refresh);
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
