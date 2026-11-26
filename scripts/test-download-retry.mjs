/**
 * Gemini 다운로드 재시도 회귀 테스트 (실제 Windows 사례):
 * Gemini가 '다운로드됨'만 띄우고 Chrome에 파일이 오지 않음 → F5 하면 받아짐.
 * → 확장은 다운로드 항목이 몇 초 안에 생기지 않으면 탭을 새로고침하고 같은 파일을 한 번만 다시 받는다(재전송 없음).
 * 실제 extension/gomo-sw.js·gemini-dom.js를 가짜 chrome API·jsdom 위에서 실행합니다. 실제 Chrome/Gemini 검증이 아닙니다.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { installGeminiSimulator } from '../fixtures/gemini-dom/gemini-simulator.mjs';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const { makeRequestMarker } = loadTS(join(root, 'src/shared/gemini-protocol.ts'));
const wait = (ms = 10) => new Promise(r => setTimeout(r, ms));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

/** 가짜 Chrome 위에서 실제 서비스 워커 실행. onTabMessage(msg) 가 content script 역할 */
function background(onTabMessage) {
  const toHost = []; const nativeListeners = []; const runtimeListeners = [];
  const created = []; const changed = [];
  const items = new Map();
  let reloads = 0; let loadingUntil = 0; let nextId = 1;
  const port = { onMessage: { addListener: (f) => nativeListeners.push(f) }, onDisconnect: { addListener() {} }, postMessage: (m) => toHost.push(JSON.parse(JSON.stringify(m))) };
  const chrome = {
    runtime: {
      lastError: undefined, id: 'ekibpgmnknamcpplppceoaogmcbcabbo',
      connectNative: () => port, getManifest: () => ({ version: '0.2.6' }),
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener: (f) => runtimeListeners.push(f) }
    },
    downloads: {
      onCreated: { addListener: (f) => created.push(f) },
      onChanged: { addListener: (f) => changed.push(f) },
      search: (q, cb) => cb(items.has(q.id) ? [items.get(q.id)] : [])
    },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    tabs: {
      query: (q, cb) => { const r = [{ id: 7, windowId: 1, active: true, title: 'Gemini', url: 'https://gemini.google.com/app/abc' }]; if (cb) cb(r); return Promise.resolve(r); },
      update: async () => ({}),
      get: async () => ({ id: 7, status: Date.now() < loadingUntil ? 'loading' : 'complete' }),
      reload: async () => { reloads++; loadingUntil = Date.now() + 80; },
      sendMessage: (tabId, msg, cb) => {
        Promise.resolve(onTabMessage(JSON.parse(JSON.stringify(msg)), { reloads })).then((response) => {
          chrome.runtime.lastError = response === undefined ? { message: 'Could not establish connection. Receiving end does not exist.' } : undefined;
          try { cb(response); } finally { chrome.runtime.lastError = undefined; }
        });
      }
    },
    scripting: { executeScript: async () => { throw new Error('no inject'); } },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  const ctx = {
    chrome, console: { log() {}, info() {}, error() {} }, setTimeout, clearTimeout, Promise, JSON, Date, fetch: async () => ({ ok: false }), btoa,
    __GOMO_DOWNLOAD_START_MS: 150, __GOMO_DOWNLOAD_TIMEOUT_MS: 800, __GOMO_RELOAD_READY_MS: 2000, __GOMO_RECOLLECT_MS: 300
  };
  vm.runInNewContext(read('extension/gomo-sw.js'), ctx);
  return {
    toHost, get reloads() { return reloads; },
    send: (m) => nativeListeners.forEach(f => f(JSON.parse(JSON.stringify(m)))),
    /** content script → 서비스 워커 이벤트 */
    contentEvent: (m) => runtimeListeners.forEach(f => f(m, { tab: { id: 7 } }, () => {})),
    /** Chrome이 실제로 파일을 받음 */
    download(file = 'C:\\Users\\me\\Downloads\\Gemini_Generated_Image_x.png') {
      const id = nextId++;
      const item = { id, url: 'blob:https://gemini.google.com/1', mime: 'image/png', filename: file, startTime: new Date().toISOString() };
      items.set(id, item);
      created.forEach(f => f(item));
      setTimeout(() => changed.forEach(f => f({ id, state: { current: 'complete' } })), 20);
    },
    async next(type, ms = 4000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const m = toHost.find(x => x.type === type); if (m) return m; await wait(10); }
      throw new Error('timeout waiting ' + type + ' got ' + toHost.map(x => x.type).join(','));
    }
  };
}

const JOB = { jobId: 'job-1', requestId: 'req-1', projectId: 'proj-1', sceneId: 'S04' };
const marker = makeRequestMarker('12345678-aaaa-bbbb-cccc-1234567890ab');
const completeEvent = { type: 'GEMINI_EVENT', kind: 'complete', ...JOB, stage: 'image', marker, text: '', codeBlocks: [], downloadClicked: true, imageUrl: 'https://lh3.googleusercontent.com/gg/x' };

await test('다운로드가 시작조차 안 되면 탭을 새로고침하고 같은 이미지를 다시 받음 (재전송 없음)', async () => {
  const seen = [];
  let bg;
  bg = background((msg, st) => {
    seen.push(msg.type);
    if (msg.type === 'PING_CONTENT') return { ok: true, protocol: 2 };
    if (msg.type === 'COLLECT_MEDIA') {
      assert.equal(st.reloads, 1, '새로고침 뒤에만 다시 받기');
      assert.equal(msg.stage, 'image'); assert.equal(msg.marker, marker); assert.equal(msg.allowLatest, true);
      setTimeout(() => bg.download(), 30); // 새로고침한 페이지에서는 진짜로 받아짐
      return { ok: true, downloadClicked: true, imageUrl: 'https://lh3.googleusercontent.com/gg/x' };
    }
    return { ok: false };
  });
  bg.contentEvent(completeEvent); // 첫 클릭: Gemini는 '다운로드됨'만 표시, Chrome 다운로드 없음
  const res = await bg.next('RESPONSE_RECEIVED');
  assert.equal(res.payload.downloadPath, 'C:\\Users\\me\\Downloads\\Gemini_Generated_Image_x.png');
  assert.equal(res.payload.reloaded, true);
  assert.equal(res.sceneId, 'S04'); assert.equal(res.jobId, 'job-1');
  assert.equal(bg.reloads, 1);
  assert.ok(!seen.includes('SUBMIT_PROMPT'), '프롬프트를 다시 보내지 않음');
  assert.ok(bg.toHost.some(m => m.type === 'JOB_PROGRESS' && m.payload.info?.reloadRetry), '새로고침 재시도 진행 알림');
  assert.ok(!bg.toHost.some(m => m.type === 'ERROR'));
});

await test('새로고침 뒤에도 안 되면 한 번만 시도하고 수동 안내(ERROR)로', async () => {
  const bg = background((msg) => {
    if (msg.type === 'PING_CONTENT') return { ok: true, protocol: 2 };
    if (msg.type === 'COLLECT_MEDIA') return { ok: true, downloadClicked: true };
    return { ok: false };
  });
  bg.contentEvent(completeEvent);
  const err = await bg.next('ERROR');
  assert.equal(err.payload.needsUser, true);
  assert.equal(err.payload.reloadTried, true);
  assert.match(err.payload.code, /DOWNLOAD_(TIMEOUT|NOT_STARTED)/);
  await wait(300);
  assert.equal(bg.reloads, 1, '새로고침은 한 번만');
});

await test('다운로드가 제때 시작되면 새로고침하지 않음', async () => {
  const bg = background(() => ({ ok: true, protocol: 2 }));
  bg.contentEvent(completeEvent);
  setTimeout(() => bg.download('C:\\d\\a.png'), 40);
  const res = await bg.next('RESPONSE_RECEIVED');
  assert.equal(res.payload.downloadPath, 'C:\\d\\a.png');
  assert.equal(res.payload.reloaded, undefined);
  assert.equal(bg.reloads, 0);
});

await test('「다시 가져오기」(보관 응답 없음): 표식 응답에서 이미지를 다시 받음, 다른 응답으로 대체하지 않음', async () => {
  const bg = background((msg) => {
    if (msg.type === 'PING_CONTENT') return { ok: true, protocol: 2 };
    if (msg.type === 'COLLECT_MEDIA') { assert.equal(msg.marker, marker); assert.equal(msg.allowLatest, false); return { ok: true, imageDataUrl: PNG, mimeType: 'image/png', downloadClicked: false }; }
    return { ok: false };
  });
  bg.send({ protocolVersion: 1, type: 'RESULT_QUERY_REQUEST', requestId: 'q-1', timestamp: '', payload: { ...JOB, stage: 'image', marker } });
  const res = await bg.next('RESPONSE_RECEIVED');
  assert.equal(res.payload.imageDataUrl, PNG);
  assert.equal(res.payload.recollected, true);
  assert.equal(res.requestId, 'req-1'); assert.equal(res.sceneId, 'S04');
  assert.equal(bg.reloads, 0);
});

await test('「다시 가져오기」: 글 단계(분석 등)는 예전처럼 보관 응답만 찾음', async () => {
  const bg = background(() => ({ ok: true, protocol: 2 }));
  bg.send({ protocolVersion: 1, type: 'RESULT_QUERY_REQUEST', requestId: 'q-2', timestamp: '', payload: { jobId: 'j', requestId: 'r', projectId: 'p' } });
  const err = await bg.next('ERROR');
  assert.equal(err.payload.code, 'RESULT_NOT_FOUND');
  assert.equal(err.requestId, 'q-2');
});

// ── content 쪽: 이미 생성된 이미지를 표식 응답에서 다시 찾아 다운로드 버튼 클릭 ──
function geminiPage() {
  const dom = new JSDOM(read('fixtures/gemini-dom/gemini-like.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app', virtualConsole: new VirtualConsole() });
  const win = dom.window;
  win.eval(read('extension/gemini-selectors.js'));
  win.eval(read('extension/gemini-dom.js'));
  installGeminiSimulator(win, { intro: '', chunkMs: 5, firstDelayMs: 10 });
  const FAST = { pollMs: 15, sendEnableWaitMs: 300, sendConfirmTimeoutMs: 400, firstResponseTimeoutMs: 1500, stableMs: 60, noImageIdleMs: 180, maxWaitMs: 2500, progressThrottleMs: 30 };
  return { win, g: win.GomoGeminiDom.createGeminiDom({ doc: win.document, win, timing: FAST }) };
}
function addImage(win, onClick) {
  const responses = win.document.querySelectorAll('model-response');
  const latest = responses[responses.length - 1];
  const single = win.document.createElement('single-image');
  const img = win.document.createElement('img');
  img.setAttribute('src', 'https://lh3.googleusercontent.com/rd-gg/fake'); img.setAttribute('width', '1024'); img.setAttribute('height', '1024');
  single.appendChild(img);
  const wrap = win.document.createElement('download-generated-image-button');
  const btn = win.document.createElement('button');
  btn.setAttribute('data-test-id', 'image-download-button'); btn.setAttribute('aria-label', 'Download full size');
  btn.addEventListener('click', onClick);
  wrap.appendChild(btn); single.appendChild(wrap); latest.appendChild(single);
}

await test('collectMedia: 입력·전송 없이 표식 응답의 이미지 다운로드 버튼만 다시 누름', async () => {
  const { win, g } = geminiPage();
  const sub = await g.submit({ prompt: 'Generate a garden', marker });
  assert.equal(sub.sendState, 'sent');
  for (let i = 0; i < 100 && !win.document.querySelector('model-response'); i++) await wait(10);
  await wait(80);
  let clicks = 0; addImage(win, () => clicks++);
  const sendBtn = win.document.querySelector('button[data-test-id="send-button"]') || win.document.querySelector('button[aria-label="Send message"]');
  let sends = 0; if (sendBtn) sendBtn.addEventListener('click', () => sends++);
  const out = await g.collectMedia({ stage: 'image', marker, timeoutMs: 500 });
  assert.equal(out.ok, true);
  assert.equal(out.downloadClicked, true);
  assert.equal(out.isolation, 'marker');
  assert.equal(clicks, 1);
  assert.equal(sends, 0, '전송 버튼을 누르지 않음');
});

await test('collectMedia: 표식 질문이 없으면(allowLatest 아님) 다른 응답의 이미지를 가져오지 않음', async () => {
  const { win, g } = geminiPage();
  await g.submit({ prompt: 'Generate a garden', marker });
  for (let i = 0; i < 100 && !win.document.querySelector('model-response'); i++) await wait(10);
  await wait(80);
  let clicks = 0; addImage(win, () => clicks++);
  const other = makeRequestMarker('99999999-aaaa-bbbb-cccc-1234567890ab');
  const out = await g.collectMedia({ stage: 'image', marker: other, timeoutMs: 120 });
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'MEDIA_NOT_FOUND');
  assert.equal(clicks, 0);
  const latest = await g.collectMedia({ stage: 'image', marker: other, allowLatest: true, timeoutMs: 300 });
  assert.equal(latest.ok, true); assert.equal(latest.isolation, 'latest'); assert.equal(clicks, 1);
});

console.log(`${checks} download-retry checks passed`);
process.exit(process.exitCode || 0);
