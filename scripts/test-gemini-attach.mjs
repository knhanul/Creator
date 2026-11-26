/**
 * 기준 이미지를 Gemini 입력창에 첨부하는 확장 로직 테스트 (jsdom 모형).
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
const FAST = { pollMs: 15, sendEnableWaitMs: 300, sendConfirmTimeoutMs: 400, firstResponseTimeoutMs: 1500, stableMs: 120, maxWaitMs: 3000, progressThrottleMs: 30, toolModeWaitMs: 300, attachWaitMs: 180 };
const marker = '[GOMO 요청 attachtest1 · 이 줄은 답변에 쓰지 마세요]';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const REF = { name: 'S01_image.png', mimeType: 'image/png', dataUrl: PNG };

function showPreview(doc, area, fileName) {
  const host = area || doc.querySelector('.input-area');
  let preview = host.querySelector('[data-gomo-attached]');
  if (!preview) {
    preview = doc.createElement('div');
    preview.setAttribute('data-gomo-attached', '1');
    const img = doc.createElement('img');
    img.setAttribute('src', 'blob:https://gemini.google.com/fake');
    img.setAttribute('alt', fileName || 'attachment');
    preview.appendChild(img);
    const chip = doc.createElement('span');
    chip.textContent = fileName || 'S01_image.png';
    preview.appendChild(chip);
    host.appendChild(preview);
  }
}

function setup(simOpts = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const win = dom.window;
  win.eval(selectorsSrc); win.eval(domSrc);
  const sim = installGeminiSimulator(win, { intro: '확인', initialToolMode: 'video', ...simOpts });
  const g = win.GomoGeminiDom.createGeminiDom({ doc: win.document, win, timing: FAST });
  return { win, doc: win.document, g, sim };
}

let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

await test('1) input[type=file]에 파일을 넣으면 미리보기 확인 후 전송', async () => {
  const { g, sim, doc, win } = setup();
  const area = doc.querySelector('.input-area');
  const input = doc.createElement('input');
  input.type = 'file';
  input.setAttribute('accept', 'image/*');
  area.appendChild(input);
  input.addEventListener('change', () => showPreview(doc, area, 'S01_image.png'));
  const r = await g.submit({ prompt: '창가 커튼이 흔들린다', marker, stage: 'video', referenceImage: REF });
  assert.equal(r.sendState, 'sent', r.message);
  assert.equal(sim.clicks, 1);
  assert.ok(doc.querySelector('[data-gomo-attached]'));
  assert.ok(doc.querySelector('img[src^="blob:"]'));
  assert.ok(sim.sentTexts[0].includes('창가 커튼이 흔들린다'));
});

await test('2) file input이 없으면 paste 폴백으로 첨부 후 전송', async () => {
  const { g, sim, doc } = setup();
  const composer = doc.querySelector('rich-textarea [contenteditable]');
  const area = doc.querySelector('.input-area');
  composer.addEventListener('paste', (ev) => {
    const dt = ev.clipboardData;
    const hasFile = !!(dt && ((dt.files && dt.files.length) || (dt.items && dt.items.length)));
    if (hasFile || ev.type === 'paste') showPreview(doc, area, 'S01_image.png');
  });
  const r = await g.submit({ prompt: '같은 장면을 영상으로', marker, stage: 'video', referenceImage: REF });
  assert.equal(r.sendState, 'sent', r.message);
  assert.equal(sim.clicks, 1);
  assert.ok(doc.querySelector('[data-gomo-attached]'));
});

await test('3) 첨부가 실패하면 IMAGE_ATTACH_FAILED로 중단하고 전송하지 않음', async () => {
  const { g, sim, doc } = setup();
  const r = await g.submit({ prompt: '첨부가 안 되면 보내지 말 것', marker, stage: 'video', referenceImage: REF });
  assert.equal(r.sendState, 'not_sent');
  assert.equal(r.errorCode, 'IMAGE_ATTACH_FAILED');
  assert.equal(r.needsUser, true);
  assert.ok(r.message.includes('텍스트만으로 동영상 생성'));
  assert.equal(sim.clicks, 0, '전송 버튼을 누르면 안 됨');
  assert.equal(sim.sentTexts.length, 0);
  const text = doc.querySelector('rich-textarea [contenteditable]').textContent || '';
  assert.equal(text.includes('첨부가 안 되면 보내지 말 것'), false);
});

await test('attachImageToComposer 단독: file input 경로가 method=file-input', async () => {
  const { g, doc } = setup();
  const area = doc.querySelector('.input-area');
  const composer = doc.querySelector('rich-textarea [contenteditable]');
  const input = doc.createElement('input');
  input.type = 'file';
  area.appendChild(input);
  input.addEventListener('change', () => showPreview(doc, area, 'S01_image.png'));
  const r = await g.attachImageToComposer(composer, area, REF);
  assert.equal(r.ok, true);
  assert.equal(r.method, 'file-input');
});

console.log(`gemini-attach tests: ${checks} passed`);
