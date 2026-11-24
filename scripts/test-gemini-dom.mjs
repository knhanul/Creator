/**
 * Content script DOM 처리 테스트 — jsdom + Gemini "모형" fixture (fixtures/gemini-dom/).
 * ⚠ 이 테스트가 통과해도 실제 gemini.google.com에서 동작한다는 뜻은 아닙니다. 모형 기준 검증입니다.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installGeminiSimulator } from '../fixtures/gemini-dom/gemini-simulator.mjs';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const html = readFileSync(join(root, 'fixtures/gemini-dom/gemini-like.html'), 'utf8');
const selectorsSrc = readFileSync(join(root, 'extension/gemini-selectors.js'), 'utf8');
const domSrc = readFileSync(join(root, 'extension/gemini-dom.js'), 'utf8');
const { DEFAULT_BRIEF, makeProject } = loadTS(join(root, 'src/shared/workflow.ts'));
const { makeAIPrompt } = loadTS(join(root, 'src/shared/prompts.ts'));
const { decideAnalysisApply } = loadTS(join(root, 'src/shared/gemini-analysis.ts'));
const { makeRequestMarker } = loadTS(join(root, 'src/shared/gemini-protocol.ts'));

const FAST = { pollMs: 15, sendEnableWaitMs: 300, sendConfirmTimeoutMs: 400, firstResponseTimeoutMs: 1500, stableMs: 120, maxWaitMs: 3000, progressThrottleMs: 30 };
const analysisJSON = readFileSync(join(root, 'fixtures/ai-analysis.example.json'), 'utf8');
const project = makeProject('22222222-2222-2222-2222-222222222222', { ...DEFAULT_BRIEF, title: '새벽의 작은 정원', originalText: '새벽의 작은 정원에 빛이 내려앉았다.\n풀잎 사이로 부드러운 바람이 지나갔다.', genre: 'poetry' });
const prompt = makeAIPrompt(project, 'analysis');
const marker = makeRequestMarker('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

function setup(htmlText = html, simOpts = {}, extra = {}) {
  const dom = new JSDOM(htmlText, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const win = dom.window;
  if (extra.execCommand) {
    // 브라우저의 execCommand('insertText')를 흉내: 선택 영역(입력창 전체)을 텍스트로 교체
    win.document.execCommand = (cmd, _ui, value) => {
      const el = win.document.activeElement;
      if (!el || el.getAttribute('contenteditable') !== 'true') return false;
      if (cmd === 'insertText') { el.innerHTML = value.split('\n').map(l => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '<br>'}</p>`).join(''); el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText' })); extra.calls?.push(cmd); return true; }
      if (cmd === 'delete') { el.innerHTML = '<p><br></p>'; el.dispatchEvent(new win.InputEvent('input', { bubbles: true })); return true; }
      return false;
    };
  }
  win.eval(selectorsSrc); win.eval(domSrc);
  const sim = simOpts === null ? null : installGeminiSimulator(win, simOpts);
  const g = win.GomoGeminiDom.createGeminiDom({ doc: win.document, win, timing: FAST });
  return { win, doc: win.document, g, sim };
}

let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

await test('선택자 진단: 입력·전송 셀렉터 일치, 아무것도 보내지 않음', async () => {
  const { g, sim, doc } = setup();
  const r = g.probe();
  assert.equal(r.kind, 'gomo.selector-probe.v1');
  assert.equal(r.summary.composer, 'rich-textarea [contenteditable="true"][role="textbox"]');
  assert.equal(r.summary.sendButton, 'button[data-test-id="send-button"]');
  assert.equal(r.summary.sendEnabled, false);
  assert.equal(r.summary.stopButton, null);
  assert.equal(r.summary.modelResponses, 1);
  assert.equal(r.summary.signIn, false);
  assert.equal(sim.clicks, 0);
  assert.equal(doc.querySelectorAll('user-query').length, 1);
  assert.ok(r.groups.composer.every(x => x.verified === false), '실제 Gemini 미검증 표시 유지');
});

await test('짧은 테스트 프롬프트: 입력 확인 후 전송, 전송 증거 확인', async () => {
  const { g, sim } = setup(html, { intro: '안녕하세요! 테스트 응답입니다.' });
  const r = await g.submit({ prompt: '짧은 테스트입니다. "확인"이라고만 답해 주세요.', marker });
  assert.equal(r.sendState, 'sent');
  assert.ok(['user-query', 'stop-button', 'new-response'].includes(r.evidence));
  assert.equal(sim.clicks, 1);
  assert.equal(sim.sentTexts.length, 1);
  assert.ok(sim.sentTexts[0].startsWith('짧은 테스트입니다.'));
  assert.ok(sim.sentTexts[0].includes(marker), '요청 표식 포함');
  const out = await g.watch(r.ctx);
  assert.equal(out.ok, true);
  assert.equal(out.text, '안녕하세요! 테스트 응답입니다.');
  assert.equal(out.isolation, 'marker');
});

await test('execCommand(insertText) 경로 사용 + 여러 줄 원문 보존', async () => {
  const calls = [];
  const { g, sim } = setup(html, { intro: 'ok' }, { execCommand: true, calls });
  const r = await g.submit({ prompt, marker });
  assert.equal(r.sendState, 'sent');
  assert.equal(r.insertMethod, 'execCommand');
  assert.deepEqual(calls, ['insertText']);
  assert.ok(sim.sentTexts[0].includes('풀잎 사이로 부드러운 바람이 지나갔다.'));
  await g.watch(r.ctx);
});

await test('실제 기획 프롬프트 전체 흐름: 이전 대화 제외, 신규 응답만 수집 → JSON 추출 → creator.analysis.v1 검사 통과', async () => {
  const { g } = setup(html, { intro: '요청하신 분석입니다.', code: analysisJSON, thinking: true });
  const progress = [];
  const r = await g.submit({ prompt, marker });
  assert.equal(r.sendState, 'sent');
  const out = await g.watch(r.ctx, (phase, info) => progress.push(phase));
  assert.equal(out.ok, true);
  assert.ok(!out.text.includes('이전 대화의 답변'), '이전 응답 섞이지 않음');
  assert.ok(!out.text.includes('"fake":true'), '사고 과정(model-thoughts) 제외');
  assert.ok(!out.text.includes('content_copy'), '버튼/아이콘 텍스트 제외');
  assert.equal(out.codeBlocks.length, 1);
  assert.equal(JSON.parse(out.codeBlocks[0]).schema, 'creator.analysis.v1');
  assert.ok(progress.includes('collecting'));
  assert.ok(out.completion.stopSeen && out.completion.actions);
  const job = { jobId: 'j', projectId: project.id, kind: 'analysis', prompt, createdAt: new Date(Date.now() - 1000).toISOString(), resultText: out.text, codeBlocks: out.codeBlocks };
  const d = decideAnalysisApply(job, project);
  assert.equal(d.action, 'apply');
  assert.equal(d.project.analysis.styles.length, 3);
});

await test('응답 중간에 잠시 멈춰도(안정 시간 미만) 조기 완료하지 않음', async () => {
  const { g } = setup(html, { intro: '앞부분입니다. 그리고 이어지는 뒷부분이 있습니다. 끝.', pauseMs: 60 });
  const r = await g.submit({ prompt: '테스트', marker });
  const out = await g.watch(r.ctx);
  assert.equal(out.text, '앞부분입니다. 그리고 이어지는 뒷부분이 있습니다. 끝.');
});

await test('첫 메시지 후 대화 전체가 다시 그려져도 표식으로 이번 응답만 구분', async () => {
  const { g } = setup(html, { intro: '새 응답', rerender: true });
  const r = await g.submit({ prompt: '재렌더 테스트', marker });
  const out = await g.watch(r.ctx);
  assert.equal(out.ok, true);
  assert.equal(out.text, '새 응답');
  assert.equal(out.isolation, 'marker');
});

await test('전송 증거가 없으면 uncertain, 버튼은 한 번만 누름(자동 재전송 없음)', async () => {
  const { g, sim } = setup(html, { noEvidence: true });
  const r = await g.submit({ prompt: '테스트', marker });
  assert.equal(r.sendState, 'uncertain');
  assert.equal(r.errorCode, 'SEND_UNCERTAIN');
  assert.equal(sim.clicks, 1);
});

await test('전송 버튼이 활성화되지 않으면 NO_SEND_BUTTON(미전송) + 입력창 원상복구', async () => {
  const { g, sim, doc } = setup(html, { neverEnable: true });
  const r = await g.submit({ prompt: '테스트', marker });
  assert.equal(r.sendState, 'not_sent');
  assert.equal(r.errorCode, 'NO_SEND_BUTTON');
  assert.equal(sim.clicks, 0);
  assert.equal(doc.querySelector('rich-textarea [contenteditable]').textContent.trim(), '');
});

await test('로그인 안 됨 → LOGIN_REQUIRED, 입력·전송 안 함', async () => {
  const loginHtml = '<html><body><a href="https://accounts.google.com/ServiceLogin?continue=x" aria-label="Sign in">Sign in</a></body></html>';
  const { g } = setup(loginHtml, null);
  const r = await g.submit({ prompt: '테스트', marker });
  assert.equal(r.errorCode, 'LOGIN_REQUIRED');
  assert.equal(r.sendState, 'not_sent');
  assert.equal(r.needsUser, true);
});

await test('보안 확인(reCAPTCHA) 화면 → BLOCKED, 우회 시도 없음', async () => {
  const blocked = html.replace('<chat-app>', '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe><chat-app>');
  const { g, sim } = setup(blocked);
  const r = await g.submit({ prompt: '테스트', marker });
  assert.equal(r.errorCode, 'BLOCKED');
  assert.equal(sim.clicks, 0);
});

await test('입력창에 작성 중인 내용이 있으면 덮어쓰지 않음', async () => {
  const { g, doc, sim } = setup();
  doc.querySelector('rich-textarea [contenteditable]').innerHTML = '<p>내가 쓰던 글</p>';
  const r = await g.submit({ prompt: '테스트', marker });
  assert.equal(r.errorCode, 'COMPOSER_NOT_EMPTY');
  assert.equal(doc.querySelector('rich-textarea [contenteditable]').textContent, '내가 쓰던 글');
  assert.equal(sim.clicks, 0);
});

await test('Gemini가 이전 답변 생성 중이면 GEMINI_BUSY', async () => {
  const { g, doc } = setup();
  doc.querySelector('button[data-test-id="stop-button"]').hidden = false;
  const r = await g.submit({ prompt: '테스트', marker });
  assert.equal(r.errorCode, 'GEMINI_BUSY');
});

await test('응답이 끝나지 않으면 RESPONSE_TIMEOUT(사용자 확인 필요)', async () => {
  const { g } = setup(html, { intro: '끝나지 않는 응답', neverFinish: true });
  const r = await g.submit({ prompt: '테스트', marker });
  const out = await g.watch(r.ctx);
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'RESPONSE_TIMEOUT');
  assert.equal(out.needsUser, true);
});

console.log(`\n${checks} gemini-dom (jsdom 모형) checks finished — 실제 Gemini DOM 검증 아님`);
if (process.exitCode) process.exit(process.exitCode);
