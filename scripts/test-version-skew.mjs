/**
 * 버전 불일치 회귀 테스트 — "jobId/requestId/projectId 누락" (실제 Windows 사례) 재현과 수정 확인.
 * 실제 확장 코드(extension/*.js)와 0.1.0 사본(fixtures/legacy/)을 가짜 chrome API 위에서 실행하고,
 * Gemini 탭은 jsdom 모형(fixtures/gemini-dom/)을 씁니다. 실제 Chrome/Gemini 검증이 아닙니다.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installGeminiSimulator } from '../fixtures/gemini-dom/gemini-simulator.mjs';
import { GeminiJobQueue } from '../src/main/gemini/job-queue.mjs';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const { createMessage, checkPeerVersions, classifySubmitResult, AUTOMATION_PROTOCOL } = loadTS(join(root, 'src/shared/gemini-protocol.ts'));
const { ERROR_GUIDE, guideFor } = loadTS(join(root, 'src/shared/gemini-analysis.ts'));
const { createAnalysisService } = loadTS(join(root, 'src/main/gemini/analysis-service.ts'));
const { DEFAULT_BRIEF, makeProject } = loadTS(join(root, 'src/shared/workflow.ts'));
const wait = (ms = 10) => new Promise(r => setTimeout(r, ms));

let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

// ── Gemini 탭 (jsdom 모형) ────────────────────────────────
const windows = [];
function geminiTab(kind) {
  const dom = new JSDOM(read('fixtures/gemini-dom/gemini-like.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const win = dom.window; windows.push(win);
  const listeners = []; const events = [];
  win.chrome = { runtime: { onMessage: { addListener: (f) => listeners.push(f) }, sendMessage: (m) => events.push(m) } };
  const sim = installGeminiSimulator(win, {});
  if (kind === 'new') { win.eval(read('extension/gemini-selectors.js')); win.eval(read('extension/gemini-dom.js')); win.eval(read('extension/content.js')); }
  else if (kind === 'legacy') win.eval(read('fixtures/legacy/content-0.1.0.js'));
  const composer = win.document.querySelector('rich-textarea [contenteditable]');
  return {
    win, sim, events, composerText: () => composer.textContent.trim(),
    // chrome.tabs.sendMessage 흉내: 수신자 없으면 lastError
    deliver(msg) {
      return new Promise((resolveRes) => {
        if (!listeners.length) return resolveRes({ err: 'Could not establish connection. Receiving end does not exist.' });
        let async = false; let done = false;
        const sendResponse = (r) => { if (!done) { done = true; resolveRes({ response: r }); } };
        for (const l of listeners) { if (l(msg, {}, sendResponse) === true) async = true; }
        if (!async && !done) resolveRes({ response: undefined });
      });
    }
  };
}

// ── 확장 백그라운드 (가짜 chrome API 위에서 실제 파일 실행) ─────────────
function background(file, tab, manifestVersion = '0.2.1') {
  const toHost = [];
  const nativeListeners = [];
  const port = { onMessage: { addListener: (f) => nativeListeners.push(f) }, onDisconnect: { addListener() {} }, postMessage: (m) => toHost.push(JSON.parse(JSON.stringify(m))) };
  const chrome = {
    runtime: {
      lastError: undefined,
      connectNative: () => port,
      getManifest: () => ({ version: manifestVersion }),
      onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }
    },
    downloads: { onChanged: { addListener() {} } },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    tabs: {
      query: (q, cb) => { const r = [{ id: 7, windowId: 1, active: true, title: 'Gemini', url: 'https://gemini.google.com/app' }]; if (cb) cb(r); return Promise.resolve(r); },
      update: async () => ({}),
      sendMessage: (tabId, msg, cb) => {
        tab.deliver(JSON.parse(JSON.stringify(msg))).then(({ err, response }) => {
          chrome.runtime.lastError = err ? { message: err } : undefined;
          try { cb(response); } finally { chrome.runtime.lastError = undefined; }
        });
      }
    },
    scripting: { executeScript: async () => { throw new Error('not used in this test'); } },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  vm.runInNewContext(read(file), { chrome, console: { log() {}, info() {}, error() {} }, setTimeout, clearTimeout, Promise, JSON });
  return {
    toHost,
    send: (m) => nativeListeners.forEach(f => f(JSON.parse(JSON.stringify(m)))),
    async next(type, ms = 3000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const m = toHost.find(x => x.type === type); if (m) return m; await wait(10); }
      throw new Error('timeout waiting ' + type);
    }
  };
}

const JOB = { jobId: 'job-11111111', requestId: 'req-22222222-3333', projectId: 'proj-44444444' };
// adapter.submitPrompt와 같은 모양의 요청
const submitReq = () => createMessage('PROMPT_SUBMIT_REQUEST', { prompt: '짧은 테스트 질문입니다.', stage: 'analysis', jobId: JOB.jobId, projectId: JOB.projectId, marker: '[GOMO 요청 222222223333 · 이 줄은 답변에 쓰지 마세요]' }, { ...JOB });

// ── 재현 ─────────────────────────────────────────────────
await test('재현: 이전 백그라운드(0.1.0) + 새 content script → 예전엔 "jobId/requestId/projectId 누락", 이제 EXTENSION_OUTDATED·미전송', async () => {
  const tab = geminiTab('new');
  const bg = background('fixtures/legacy/background-0.1.0.js', tab);
  bg.send(submitReq());
  const res = await bg.next('PROMPT_SUBMIT_RESULT');
  // 0.1.0 백그라운드는 content에 jobId만 넘기고(requestId·projectId 없음), 결과 봉투에도 jobId·projectId를 넣지 않음
  assert.equal(res.requestId, JOB.requestId);
  assert.equal(res.projectId, undefined);
  assert.equal(res.jobId, undefined);
  assert.equal(res.payload.errorCode, 'EXTENSION_OUTDATED');
  assert.equal(res.payload.sendState, 'not_sent');
  assert.doesNotMatch(res.payload.message, /^jobId\/requestId\/projectId 누락$/);
  // Gemini 화면은 건드리지 않음
  assert.equal(tab.sim.clicks, 0); assert.equal(tab.sim.sentTexts.length, 0); assert.equal(tab.composerText(), '');
  // 앱 쪽 해석: 이전 버전 + 명시적 미전송
  assert.deepEqual(classifySubmitResult(res, JOB), { kind: 'outdated', sendState: 'not_sent' });
});

await test('연결 확인: 0.1.0 백그라운드는 버전을 보고하지 않음 → EXTENSION_OUTDATED (전송 전에 차단)', async () => {
  const tab = geminiTab('new');
  const bg = background('fixtures/legacy/background-0.1.0.js', tab);
  bg.send(createMessage('GEMINI_STATUS_REQUEST', {}));
  const st = await bg.next('GEMINI_STATUS_RESULT');
  assert.equal(st.payload.extension, undefined);
  const issue = checkPeerVersions({ host: { protocol: 2, version: '0.2.1' }, extension: st.payload.extension ?? null, content: st.payload.content ?? null });
  assert.equal(issue.code, 'EXTENSION_OUTDATED');
  assert.match(ERROR_GUIDE.EXTENSION_OUTDATED.fix, /chrome:\/\/extensions/);
  assert.match(ERROR_GUIDE.EXTENSION_OUTDATED.fix, /서비스 워커/); assert.match(ERROR_GUIDE.EXTENSION_OUTDATED.fix, /GOMO background protocol 2 build 0\.2\.6/);
  assert.match(ERROR_GUIDE.EXTENSION_OUTDATED.fix, /Chrome을 완전히 종료/);
});

await test('이전 백그라운드 + 이전 content(둘 다 0.1.0): "성공"이라고 해도 전송 여부 불명으로 처리', async () => {
  const tab = geminiTab('legacy');
  const bg = background('fixtures/legacy/background-0.1.0.js', tab);
  bg.send(submitReq());
  const res = await bg.next('PROMPT_SUBMIT_RESULT');
  assert.equal(res.payload.success, true); // 0.1.0 content는 실제로 입력·클릭을 시도함
  assert.deepEqual(classifySubmitResult(res, JOB), { kind: 'outdated', sendState: 'uncertain' });
  assert.match(ERROR_GUIDE.EXTENSION_OUTDATED_UNCERTAIN.fix, /자동으로 다시 보내지 않습니다/);
});

await test('새 백그라운드 + 이전 content(탭 새로고침 안 함) → CONTENT_OUTDATED', async () => {
  const tab = geminiTab('legacy');
  const bg = background('extension/gomo-sw.js', tab);
  bg.send(createMessage('GEMINI_STATUS_REQUEST', {}));
  const st = await bg.next('GEMINI_STATUS_RESULT');
  assert.equal(st.payload.extension.protocol, AUTOMATION_PROTOCOL);
  assert.equal(st.payload.extension.version, '0.2.1');
  assert.equal(st.payload.content.state, 'outdated');
  assert.equal(checkPeerVersions({ host: { protocol: 2, version: 'x' }, extension: st.payload.extension, content: st.payload.content }).code, 'CONTENT_OUTDATED');
});

await test('최신 백그라운드 + 최신 content: 버전 일치, ids·protocol 전달, 결과 봉투에 ids 회신', async () => {
  const tab = geminiTab('new');
  const bg = background('extension/gomo-sw.js', tab);
  bg.send(createMessage('GEMINI_STATUS_REQUEST', {}));
  const st = await bg.next('GEMINI_STATUS_RESULT');
  assert.deepEqual(st.payload.content, { state: 'ok', protocol: AUTOMATION_PROTOCOL });
  assert.equal(checkPeerVersions({ host: { protocol: 2, version: '0.2.1' }, extension: st.payload.extension, content: st.payload.content }), null);
  bg.send(submitReq());
  const res = await bg.next('PROMPT_SUBMIT_RESULT', 5000);
  assert.equal(res.jobId, JOB.jobId); assert.equal(res.projectId, JOB.projectId); assert.equal(res.requestId, JOB.requestId);
  assert.equal(res.payload.requestId, JOB.requestId); assert.equal(res.payload.projectId, JOB.projectId);
  assert.equal(res.payload.sendState, 'sent', JSON.stringify(res.payload));
  assert.equal(tab.sim.sentTexts.length, 1);
  assert.deepEqual(classifySubmitResult(res, JOB), { kind: 'ok' });
  // 다른 작품의 결과는 여전히 거부
  assert.deepEqual(classifySubmitResult({ ...res, projectId: 'other' }, JOB), { kind: 'mismatch' });
});

await test('새 백그라운드: 앱 요청에 ids가 없으면 Gemini 탭에 보내지 않음', async () => {
  const tab = geminiTab('new');
  const bg = background('extension/gomo-sw.js', tab);
  bg.send(createMessage('PROMPT_SUBMIT_REQUEST', { prompt: 'x', stage: 'analysis', marker: 'm' }, { requestId: 'r-only' }));
  const res = await bg.next('PROMPT_SUBMIT_RESULT');
  assert.equal(res.payload.errorCode, 'BAD_REQUEST'); assert.equal(res.payload.sendState, 'not_sent');
  assert.equal(tab.sim.clicks, 0);
});

// ── Native Host (실제 host.mjs 실행) ─────────────────────────
await test('Native Host: HOST_INFO_REQUEST에 직접 응답(Chrome으로 넘기지 않음), 다른 메시지는 ids 그대로 전달', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gomo-host-'));
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\gomo-test-${process.pid}` : join(dir, 'p.sock');
  const fromHost = []; let sock;
  const server = createServer((s) => { sock = s; let buf = ''; s.on('data', (d) => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) if (l.trim()) fromHost.push(JSON.parse(l)); }); });
  await new Promise(r => server.listen(pipe, r));
  const child = spawn(process.execPath, [join(root, 'native-host/host.mjs')], { env: { ...process.env, GOMO_CREATE_PIPE: pipe, HOME: dir, USERPROFILE: dir }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = Buffer.alloc(0); child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
  try {
    for (let i = 0; i < 200 && !fromHost.length; i++) await wait(20);
    assert.equal(fromHost[0].type, 'HOST_HELLO'); assert.equal(fromHost[0].protocol, AUTOMATION_PROTOCOL);
    const info = createMessage('HOST_INFO_REQUEST', {});
    const big = submitReq(); big.payload.prompt = '한글 프롬프트 '.repeat(20000); // 여러 청크로 나뉘는 큰 메시지
    sock.write(JSON.stringify(info) + '\n' + JSON.stringify(big) + '\n');
    for (let i = 0; i < 200 && fromHost.length < 2; i++) await wait(20);
    const r = fromHost.find(m => m.type === 'HOST_INFO_RESULT');
    assert.equal(r.requestId, info.requestId); assert.equal(r.payload.protocol, AUTOMATION_PROTOCOL);
    for (let i = 0; i < 200 && out.length < 4; i++) await wait(20);
    const msgs = []; let o = 0;
    while (o + 4 <= out.length) { const len = out.readUInt32LE(o); if (o + 4 + len > out.length) break; msgs.push(JSON.parse(out.subarray(o + 4, o + 4 + len).toString('utf8'))); o += 4 + len; }
    assert.equal(msgs.some(m => m.type === 'HOST_INFO_REQUEST'), false);
    const fwd = msgs.find(m => m.type === 'PROMPT_SUBMIT_REQUEST');
    assert.ok(fwd, 'forwarded');
    assert.equal(fwd.jobId, JOB.jobId); assert.equal(fwd.requestId, JOB.requestId); assert.equal(fwd.projectId, JOB.projectId);
    assert.equal(fwd.payload.prompt, big.payload.prompt);
  } finally { child.kill(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});

await test('checkPeerVersions: Host 무응답(이전 Host) → HOST_OUTDATED, 안내에 재등록 명령 포함', () => {
  assert.equal(checkPeerVersions({ host: null, extension: { protocol: 2, version: '0.2.1' }, content: { state: 'ok', protocol: 2 } }).code, 'HOST_OUTDATED');
  assert.match(ERROR_GUIDE.HOST_OUTDATED.fix, /SETUP_GEMINI\.bat/);
  assert.equal(checkPeerVersions({ host: { protocol: 2, version: 'x' }, extension: { protocol: 2, version: '0.2.1' }, content: { state: 'none' } }), null); // 전송 때 주입
});

// ── 앱 쪽: 연결 확인에서 막히면 전송하지 않음 / 이전 버전 '성공'은 사용자 확인 ───────────
const tmp = mkdtempSync(join(tmpdir(), 'gomo-skew-'));
async function service(status, submitResult) {
  const project = makeProject(JOB.projectId, { ...DEFAULT_BRIEF, title: '작품', originalText: '원문입니다.\n둘째 줄.' });
  const queue = new GeminiJobQueue(join(tmp, `q${Math.random()}.json`)); await queue.load();
  const submits = [];
  const adapter = { getStatus: async () => status, submitPrompt: async (j) => { submits.push(j); return submitResult(j); }, requestResult: async () => ({ ok: true, message: '' }) };
  const svc = createAnalysisService({ queue, adapter, readProject: async () => structuredClone(project), saveProject: async (p) => p });
  return { svc, queue, submits };
}
const okStatus = { connected: true, hostRegistered: true, extensionConnected: true, geminiTabFound: true, loginState: 'unknown', message: '' };

await test('앱: 연결 확인에서 EXTENSION_OUTDATED → 보내지 않고 사용자 확인 필요 + 구체적 안내', async () => {
  const { svc, queue, submits } = await service({ ...okStatus, versionIssue: { code: 'EXTENSION_OUTDATED', message: 'Chrome 확장 프로그램이 이전 버전으로 실행 중입니다.' }, diagnosticText: '[GOMO 연결 진단] test' }, () => { throw new Error('must not submit'); });
  await svc.start(JOB.projectId); await svc.kick();
  const job = queue.list()[0];
  assert.equal(submits.length, 0);
  assert.equal(job.state, 'failed'); assert.equal(job.phase, 'needs_user'); assert.equal(job.errorCode, 'EXTENSION_OUTDATED');
  assert.equal(job.sendConfirmed, false);
  assert.match(guideFor(job).fix, /chrome:\/\/extensions/);
  assert.equal(job.diagnostics, '[GOMO 연결 진단] test'); // 모달의 '진단 정보'에 표시
});

await test('앱: 이전 버전 확장이 결과를 회신(전송 여부 불명) → needs_confirmation, 자동 재전송 없음', async () => {
  const { svc, queue, submits } = await service(okStatus, (j) => ({ success: false, uncertain: true, sendState: 'uncertain', needsUser: true, jobId: j.jobId, errorCode: 'EXTENSION_OUTDATED_UNCERTAIN', message: '' }));
  await svc.start(JOB.projectId); await svc.kick(); await svc.kick();
  const job = queue.list()[0];
  assert.equal(submits.length, 1);
  assert.equal(job.state, 'needs_confirmation'); assert.equal(job.errorCode, 'EXTENSION_OUTDATED_UNCERTAIN');
});

for (const w of windows) w.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${checks} version-skew checks finished (가짜 chrome API + jsdom 모형 — 실제 Chrome 검증 아님)`);
process.exit(process.exitCode || 0);
