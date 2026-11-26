/**
 * Gemini 입력창 + 메뉴 도구 모드(동영상/이미지/음악) 전환 테스트 — jsdom 모형.
 * ⚠ 실제 gemini.google.com DOM 검증이 아닙니다.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installGeminiSimulator } from '../fixtures/gemini-dom/gemini-simulator.mjs';

const root = resolve(import.meta.dirname, '..');
const html = readFileSync(join(root, 'fixtures/gemini-dom/gemini-like.html'), 'utf8');
const selectorsSrc = readFileSync(join(root, 'extension/gemini-selectors.js'), 'utf8');
const domSrc = readFileSync(join(root, 'extension/gemini-dom.js'), 'utf8');

const FAST = { pollMs: 15, sendEnableWaitMs: 300, sendConfirmTimeoutMs: 400, firstResponseTimeoutMs: 1500, stableMs: 120, maxWaitMs: 3000, progressThrottleMs: 30, toolModeWaitMs: 300 };
const marker = '[GOMO 요청 testdummy12 · 이 줄은 답변에 쓰지 마세요]';

function setup(simOpts = {}, extraHtml = html) {
  const dom = new JSDOM(extraHtml, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const win = dom.window;
  win.eval(selectorsSrc); win.eval(domSrc);
  const sim = simOpts === null ? null : installGeminiSimulator(win, { intro: '확인', ...simOpts });
  const g = win.GomoGeminiDom.createGeminiDom({ doc: win.document, win, timing: FAST });
  return { win, doc: win.document, g, sim };
}

let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

await test('진단: 입력창 + 버튼은 잡히고, 사이드바 이미지/+ 새 노트북은 도구 버튼으로 쓰지 않음', async () => {
  const { g, doc } = setup();
  const r = g.probe();
  assert.equal(r.summary.toolMenuButton, 'button[data-test-id="open-tools-button"]');
  assert.equal(r.summary.activeToolMode, null);
  const area = g.findComposerArea();
  assert.ok(area && area.classList.contains('input-area'));
  const plus = g.findToolMenuButton(area);
  assert.equal(plus.el.getAttribute('data-test-id'), 'open-tools-button');
  assert.notEqual(plus.el.getAttribute('data-test-id'), 'sidebar-new-notebook');
  assert.ok(doc.querySelector('[data-test-id="sidebar-image"]'));
  assert.ok(doc.querySelector('[data-test-id="sidebar-new-notebook"]'));
  assert.equal(g.targetModeForStage('video'), 'video');
  assert.equal(g.targetModeForStage('image'), 'image');
  assert.equal(g.targetModeForStage('music'), 'music');
  assert.equal(g.targetModeForStage('analysis'), null);
  assert.equal(g.targetModeForStage('prompts'), null);
  assert.equal(g.targetModeForStage('source'), null);
});

await test('일반 상태에서 video 요청 → + 클릭 → 동영상 만들기 클릭 → 동영상 칩 확인 후 전송', async () => {
  const { g, sim, doc } = setup();
  const r = await g.submit({ prompt: '정원 산책 장면', marker, stage: 'video' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.ok(sim.plusClicks >= 1, '입력창 + 를 눌러야 함');
  assert.deepEqual(sim.menuItemClicks, ['동영상 만들기']);
  assert.equal(sim.toolMode, 'video');
  assert.equal(sim.sidebarClicks, 0, '사이드바를 누르면 안 됨');
  assert.equal(sim.clicks, 1);
  assert.ok(sim.sentTexts[0].includes('정원 산책 장면'));
  const chip = doc.querySelector('[data-test-id="tool-chip"]');
  assert.ok(chip, '동영상 칩이 붙어야 함');
  assert.match(chip.getAttribute('aria-label') + chip.textContent, /동영상/);
  assert.equal(g.readActiveToolMode().mode, 'video');
  assert.match(doc.querySelector('rich-textarea [contenteditable]').getAttribute('data-placeholder'), /동영상/);
});

await test('이미 동영상 칩이 켜진 상태에서 video 재요청 → 메뉴를 다시 열지 않고 전송', async () => {
  const { g, sim } = setup({ initialToolMode: 'video' });
  assert.equal(g.readActiveToolMode().mode, 'video');
  const r = await g.submit({ prompt: '같은 장면 다시', marker, stage: 'video' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.equal(sim.plusClicks, 0, '이미 켜져 있으면 + 를 누르지 않음');
  assert.deepEqual(sim.menuItemClicks, []);
  assert.equal(sim.toolMode, 'video');
  assert.equal(sim.clicks, 1);
  assert.equal(sim.sidebarClicks, 0);
});

await test('동영상 칩이 켜진 상태에서 image 요청 → 동영상 칩 해제 → 이미지 만들기 선택 후 전송', async () => {
  const { g, sim, doc } = setup({ initialToolMode: 'video' });
  const r = await g.submit({ prompt: '정원 정지 컷', marker, stage: 'image' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.ok(sim.chipDismisses + sim.menuItemClicks.filter((x) => x === '동영상 만들기').length >= 1, '동영상 칩을 해제해야 함');
  assert.ok(sim.menuItemClicks.includes('이미지 만들기'), '이미지 만들기를 선택해야 함');
  assert.equal(sim.toolMode, 'image');
  assert.equal(sim.clicks, 1);
  assert.equal(sim.sidebarClicks, 0);
  assert.match((doc.querySelector('[data-test-id="tool-chip"]')?.textContent || ''), /이미지/);
});

await test('동영상 칩이 켜진 상태에서 일반 텍스트(analysis/prompts) 요청 → 칩 해제 후 전송', async () => {
  const { g, sim, doc } = setup({ initialToolMode: 'video' });
  const r = await g.submit({ prompt: '이 작품을 분석해 주세요', marker, stage: 'analysis' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.equal(sim.toolMode, null);
  assert.equal(sim.clicks, 1);
  assert.ok(!doc.querySelector('[data-test-id="tool-chip"]') || doc.querySelector('.tool-chips').hidden);
  assert.equal(g.readActiveToolMode().mode, null);

  const { g: g2, sim: sim2 } = setup({ initialToolMode: 'video' });
  const r2 = await g2.submit({ prompt: '프롬프트를 만들어 주세요', marker, stage: 'prompts' });
  assert.equal(r2.sendState, 'sent', r2.message);
  assert.equal(sim2.toolMode, null);
  assert.equal(sim2.clicks, 1);
});

await test('video 요청에서 + 메뉴에 동영상 만들기가 없으면 not_sent로 안전 중단(프롬프트 미전송)', async () => {
  const { g, sim, doc } = setup({ noVideoMenu: true });
  const r = await g.submit({ prompt: '영상을 만들어 주세요', marker, stage: 'video' });
  assert.equal(r.sendState, 'not_sent');
  assert.equal(r.errorCode, 'TOOL_MODE_SELECT_FAILED');
  assert.equal(r.needsUser, true);
  assert.equal(r.toolModeReason, 'item_not_found');
  assert.match(r.message, /동영상 만들기/);
  assert.match(r.message, /항목을 찾지/);
  assert.equal(sim.clicks, 0);
  assert.equal(sim.sentTexts.length, 0);
  assert.equal(doc.querySelectorAll('user-query').length, 1, '새 질문이 올라가면 안 됨');
  assert.equal((doc.querySelector('rich-textarea [contenteditable]').textContent || '').trim(), '');
  assert.equal(doc.querySelector('.cdk-overlay-pane, [role="menu"], .gemini-tools-panel, .custom-popup'), null, '실패 후에도 메뉴는 닫혀야 함');
});

await test('사이드바에 이미지와 + 새 노트북이 있어도 입력창 쪽 + 만 정확히 선택', async () => {
  const { g, sim, doc } = setup();
  const r = await g.submit({ prompt: '음악 한 곡', marker, stage: 'music' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.equal(sim.sidebarClicks, 0);
  assert.ok(sim.plusClicks >= 1);
  assert.deepEqual(sim.menuItemClicks, ['음악 만들기']);
  assert.equal(sim.toolMode, 'music');
  const plus = g.findToolMenuButton(g.findComposerArea());
  assert.ok(plus.el.closest('.input-area'));
  assert.ok(!plus.el.closest('aside, nav'));
  assert.equal(doc.querySelector('[data-test-id="sidebar-new-notebook"]').getAttribute('aria-label'), '+ 새 노트북');
});

await test('image 요청에서 이미지 만들기 메뉴가 없어도 이전 칩이 없으면 부드럽게 전송(폴백)', async () => {
  const { g, sim } = setup({ noImageMenu: true });
  const r = await g.submit({ prompt: '정원 그림', marker, stage: 'image' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.equal(sim.clicks, 1);
  assert.equal(sim.toolMode, null);
});

await test('image 요청인데 동영상 칩 해제에 실패하면 전송하지 않음', async () => {
  const { g, sim, doc } = setup({ initialToolMode: 'video', noVideoMenu: true });
  // 칩/닫기 클릭이 무시되고, 메뉴에도 '동영상 만들기'가 없어 토글 해제도 실패
  const frozen = doc.querySelector('[data-test-id="tool-chip"]');
  frozen.addEventListener('click', (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, true);
  const dismiss = frozen.querySelector('.chip-dismiss');
  if (dismiss) dismiss.addEventListener('click', (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, true);
  const r = await g.submit({ prompt: '정원 그림', marker, stage: 'image' });
  assert.equal(r.sendState, 'not_sent');
  assert.equal(r.errorCode, 'TOOL_MODE_CLEAR_FAILED');
  assert.equal(r.needsUser, true);
  assert.equal(sim.clicks, 0);
  assert.equal(sim.sentTexts.length, 0);
  assert.equal(sim.toolMode, 'video');
});


await test('mat-icon 리가처(videocam)가 섞인 메뉴 항목도 매칭해 전송', async () => {
  const { g, sim, doc } = setup();
  const r = await g.submit({ prompt: '리가처 동영상', marker, stage: 'video' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.deepEqual(sim.menuItemClicks, ['동영상 만들기']);
  const sample = doc.createElement('button');
  sample.innerHTML = '<mat-icon>videocam</mat-icon><span>동영상 만들기</span>';
  assert.ok((sample.textContent || '').includes('videocam'), '원본 textContent에는 리가처가 남아 있음');
  assert.equal(sim.toolMode, 'video');
  assert.equal(sim.sidebarClicks, 0);
});

await test('role=menuitem 없는 일반 팝업(사이드바/대화 본문 제외)에서도 동영상 만들기 폴백 매칭', async () => {
  const { g, sim, doc } = setup({ plainPopup: true, popupAriaHidden: true });
  const r = await g.submit({ prompt: '폴백 동영상', marker, stage: 'video' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.deepEqual(sim.menuItemClicks, ['동영상 만들기']);
  assert.equal(sim.toolMode, 'video');
  assert.equal(sim.sidebarClicks, 0);
  assert.equal(sim.clicks, 1);
  assert.equal(doc.querySelector('.gemini-tools-panel, .custom-popup, [role="menu"]'), null, '전송 후 팝업은 닫혀야 함');
});

await test('칩에 mat-icon(movie)+동영상 라벨이 섞여 있어도 감지하고 텍스트 단계에서 해제', async () => {
  const { g, sim, doc } = setup({ initialToolMode: 'video' });
  const chip = doc.querySelector('[data-test-id="tool-chip"]');
  assert.ok(chip.querySelector('mat-icon'));
  assert.equal((chip.querySelector('mat-icon').textContent || '').trim(), 'movie');
  assert.ok((chip.textContent || '').includes('movie'), '원본 textContent에는 movie가 섞여 있음');
  assert.equal(g.readActiveToolMode().mode, 'video');
  assert.equal(g.readActiveToolMode().via, 'chip');
  const r = await g.submit({ prompt: '분석해 주세요', marker, stage: 'analysis' });
  assert.equal(r.sendState, 'sent', r.message);
  assert.equal(sim.toolMode, null);
  assert.equal(g.readActiveToolMode().mode, null);
  assert.equal(sim.clicks, 1);
});

console.log(`\n${checks} gemini-tool-mode (jsdom 모형) checks finished — 실제 Gemini DOM 검증 아님`);
if (process.exitCode) process.exit(process.exitCode);
