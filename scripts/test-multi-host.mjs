/**
 * 실제 연결 경로 통합 테스트: 앱(adapter + pipe-client) ↔ 실제 native-host/host.mjs 프로세스 ↔ 실제 서비스 워커 파일(가짜 chrome API 위).
 * Chrome이 확장의 connectNative()마다 Host를 하나씩 띄우는 것을 그대로 흉내 냅니다(확장 인스턴스 = Host 프로세스 1개).
 * 2026-11-24 Windows 사례 재현: 확장 카드는 0.2.1인데 앱은 "보고된 프로토콜: 없음"(Host는 최신으로 응답).
 * 실제 Chrome/Windows 검증이 아닙니다.
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'gomo-mh-'));
const HOME = join(dir, 'home'); mkdirSync(HOME);
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

/** 확장 인스턴스 1개: 서비스 워커 파일을 vm에서 실행. Chrome처럼 connectNative() 호출마다 실제 host.mjs 프로세스를 하나씩 띄움.
 *  startup=true: 브라우저 시작처럼 onStartup 리스너도 실행 */
const children = [];
function extensionInstance(bgFile, { manifestVersion, pipe, id = 'cifkogmhgmohlgeafcdpkjbkdikdpfpi', startup = false }) {
  const mine = [];
  function connectNative() {
    const child = spawn(process.execPath, [join(root, 'native-host/host.mjs'), `chrome-extension://${id}/`], { env: { ...process.env, GOMO_CREATE_PIPE: pipe, HOME, USERPROFILE: HOME }, stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child); mine.push(child);
    const listeners = [];
    let out = Buffer.alloc(0);
    child.stdout.on('data', (d) => {
      out = Buffer.concat([out, d]);
      while (out.length >= 4) { const n = out.readUInt32LE(0); if (out.length < 4 + n) break; const m = JSON.parse(out.subarray(4, 4 + n).toString('utf8')); out = out.subarray(4 + n); listeners.forEach(f => f(m)); }
    });
    return {
      onMessage: { addListener: (f) => listeners.push(f) }, onDisconnect: { addListener() {} },
      postMessage: (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); }
    };
  }
  const startupListeners = [];
  const chrome = {
    runtime: { id, lastError: undefined, connectNative, getManifest: () => ({ version: manifestVersion }), onInstalled: { addListener() {} }, onStartup: { addListener: (f) => startupListeners.push(f) }, onMessage: { addListener() {} } },
    downloads: { onChanged: { addListener() {} } },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    tabs: {
      query: (q, cb) => { const r = [{ id: 7, windowId: 1, active: true, title: 'Gemini', url: 'https://gemini.google.com/app' }]; if (cb) cb(r); return Promise.resolve(r); },
      update: async () => ({}),
      // 탭에 content script 없음(새로고침 전) → 수신자 없음
      sendMessage: (tabId, msg, cb) => setTimeout(() => { chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }; try { cb(undefined); } finally { chrome.runtime.lastError = undefined; } }, 5)
    },
    scripting: { executeScript: async () => { throw new Error('not used'); } },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  vm.runInNewContext(readFileSync(join(root, bgFile), 'utf8'), { chrome, console: { log() {}, info() {}, error() {} }, setTimeout, clearTimeout, Promise, JSON, Date });
  if (startup) startupListeners.forEach(f => f());
  return { hosts: () => mine.length, stop: () => { for (const c of mine) c.stdin.end(); } };
}

/** 앱 쪽 코드 묶음 로드. version='current' 또는 git 커밋(그 시점의 adapter/pipe-client/protocol) */
function loadApp(rev, pipe) {
  if (rev === 'current') {
    process.env.GOMO_CREATE_PIPE = pipe;
    return loadTS(join(root, 'src/main/gemini/adapter.ts'));
  }
  const base = join(dir, 'app-' + rev);
  for (const f of ['src/main/gemini/adapter.ts', 'src/main/gemini/pipe-client.ts', 'src/shared/gemini-protocol.ts']) {
    mkdirSync(join(base, f, '..'), { recursive: true });
    let src = execFileSync('git', ['show', `${rev}:${f}`], { cwd: root, encoding: 'utf8' });
    if (f.endsWith('pipe-client.ts')) src = src.replace(/const PIPE = [^\n]+/, `const PIPE = ${JSON.stringify(pipe)};`);
    writeFileSync(join(base, f), src);
  }
  return loadTS(join(base, 'src/main/gemini/adapter.ts'));
}
const pipeFor = (name) => process.platform === 'win32' ? `\\\\.\\pipe\\gomo-mh-${process.pid}-${name}` : join(dir, name + '.sock');
async function settle(adapter) { await adapter.getStatus(); await wait(1500); } // 서버 시작 → Host 재접속(2초 주기) 기다림

// ── 재현 (수정 전 앱 0e47d20) ─────────────────────────────
const hasOld = (() => { try { execFileSync('git', ['cat-file', '-e', '0e47d20:src/main/gemini/pipe-client.ts'], { cwd: root }); return true; } catch { return false; } })();
if (hasOld) await test('재현(수정 전 앱 0e47d20): 최신 확장 Host + 나중에 붙은 이전 확장 Host → Host는 최신인데 "보고된 프로토콜: 없음"', async () => {
  const pipe = pipeFor('old');
  const { geminiAdapter } = loadApp('0e47d20', pipe);
  await geminiAdapter.getStatus(); // 서버 열기
  const fresh = extensionInstance('extension/gomo-sw.js', { manifestVersion: '0.2.2', pipe });
  await wait(2500);
  const stale = extensionInstance('fixtures/legacy/background-0.2.0.js', { manifestVersion: '0.2.1', pipe }); // 다른 프로필/이전 서비스 워커
  await wait(2500);
  const s = await geminiAdapter.getStatus();
  assert.equal(s.versions.host.protocol, 2, 'Host는 최신으로 응답(HOST_OUTDATED 아님)');
  assert.equal(s.versionIssue?.code, 'EXTENSION_OUTDATED');
  assert.match(s.message, /보고된 프로토콜: 없음, 필요: 2/);
  fresh.stop(); stale.stop();
});

// ── 수정 후 ─────────────────────────────────────────────
const pipe = pipeFor('new');
const { geminiAdapter } = loadApp('current', pipe);
const { pipeClient } = loadTS(join(root, 'src/main/gemini/pipe-client.ts'));

await test('수정: 같은 상황에서 자동화 지원 확장의 Host를 골라 정상 판정 + 진단에 Host 2개 표시', async () => {
  await geminiAdapter.getStatus();
  const fresh = extensionInstance('extension/gomo-sw.js', { manifestVersion: '0.2.2', pipe });
  await wait(2500);
  const stale = extensionInstance('fixtures/legacy/background-0.2.0.js', { manifestVersion: '0.2.1', pipe });
  await wait(2500);
  const s = await geminiAdapter.getStatus();
  assert.equal(s.versionIssue, null, s.diagnosticText);
  assert.equal(s.versions.extension.protocol, 2);
  assert.equal(s.diagnostics.hosts.length, 2);
  assert.match(s.diagnosticText, /Host 연결 2개/);
  assert.match(s.diagnosticText, /\(사용 중\)/);
  assert.match(s.diagnosticText, /호출 확장: chrome-extension:\/\/cifkogmhgmohlgeafcdpkjbkdikdpfpi\//);
  assert.match(s.diagnosticText, /확장 HELLO: 버전 0\.2\.1 프로토콜 없음/); // 이전 인스턴스도 보임
  assert.match(s.diagnosticText, /Host 로그 파일: .*host\.log/);
  // 확장 포트가 닫히면 Host가 종료되고 앱 연결 목록에서도 빠짐
  stale.stop();
  for (let i = 0; i < 100 && pipeClient.connections().hosts.length > 1; i++) await wait(30);
  assert.equal(pipeClient.connections().hosts.length, 1);
  fresh.stop();
  for (let i = 0; i < 100 && pipeClient.connections().hosts.length > 0; i++) await wait(30);
  assert.equal(pipeClient.connections().hosts.length, 0);
});

await test('이전 서비스 워커만 있을 때: EXTENSION_OUTDATED + "카드 버전 0.2.1인데 서비스 워커가 이전 코드" 설명', async () => {
  const stale = extensionInstance('fixtures/legacy/background-0.2.0.js', { manifestVersion: '0.2.1', pipe });
  await wait(2500);
  const s = await geminiAdapter.getStatus();
  assert.equal(s.versionIssue?.code, 'EXTENSION_OUTDATED');
  assert.match(s.versionIssue.message, /카드 버전은 0\.2\.1인데 서비스 워커 코드가 버전을 보고하지 않습니다/);
  assert.match(s.diagnosticText, /버전 정보 없음 → 이전 서비스 워커 코드/);
  stale.stop(); for (let i = 0; i < 100 && pipeClient.connections().hosts.length; i++) await wait(30);
});

await test('2026-11-24 16:42 Windows 진단 재현: 카드 0.2.2인데 0.1.0 background.js 실행 → 같은 ID Host 2개 + HELLO 0.1.0', async () => {
  // 0.1.0 background.js는 최상위 connect()와 onStartup에서 각각 connectNative → 브라우저 시작 때 Host 2개
  const stale = extensionInstance('fixtures/legacy/background-0.1.0.js', { manifestVersion: '0.2.2', pipe, startup: true });
  await wait(2500);
  assert.equal(pipeClient.connections().hosts.length, 2, '0.1.0 코드는 Host를 2개 띄움');
  const s = await geminiAdapter.getStatus();
  assert.equal(s.versionIssue?.code, 'EXTENSION_OUTDATED');
  assert.match(s.versionIssue.message, /0\.1\.0 코드입니다/);
  assert.match(s.versionIssue.message, /같은 확장 ID\(chrome-extension:\/\/cifkogmhgmohlgeafcdpkjbkdikdpfpi\/\)의 Host가 2개/);
  assert.match(s.diagnosticText, /확장 HELLO: 버전 0\.1\.0 프로토콜 없음/);
  stale.stop(); for (let i = 0; i < 100 && pipeClient.connections().hosts.length; i++) await wait(30);
});

await test('새 서비스 워커(gomo-sw.js)는 브라우저 시작 때도 Host를 1개만 띄움', async () => {
  const ext = extensionInstance('extension/gomo-sw.js', { manifestVersion: '0.2.5', pipe, startup: true });
  await wait(2500);
  assert.equal(ext.hosts(), 1);
  const s = await geminiAdapter.getStatus();
  assert.equal(s.versionIssue, null, s.diagnosticText);
  assert.match(s.diagnosticText, /빌드 0\.2\.5 파일 gomo-sw\.js/);
  ext.stop(); for (let i = 0; i < 100 && pipeClient.connections().hosts.length; i++) await wait(30);
});

await test('0.2.1 확장(이 수정 직전 버전)과도 정상 판정 — 봉투에 버전 필드가 없어도 payload.extension으로 확인', async () => {
  const ext = extensionInstance('fixtures/legacy/background-0.2.1.js', { manifestVersion: '0.2.1', pipe });
  await wait(2500);
  const s = await geminiAdapter.getStatus();
  assert.equal(s.versionIssue, null, s.diagnosticText);
  ext.stop(); for (let i = 0; i < 100 && pipeClient.connections().hosts.length; i++) await wait(30);
});

await test('확장이 상태 요청에 응답하지 않음 → EXTENSION_NO_REPLY (버전 문제로 오진하지 않음)', async () => {
  // Host만 있고 Chrome 쪽은 아무 답도 하지 않는 경우(서비스 워커 멈춤 등)
  const child = spawn(process.execPath, [join(root, 'native-host/host.mjs')], { env: { ...process.env, GOMO_CREATE_PIPE: pipe, HOME, USERPROFILE: HOME }, stdio: ['pipe', 'pipe', 'ignore'] });
  children.push(child);
  await wait(2500);
  const s = await geminiAdapter.getStatus();
  assert.equal(s.versionIssue?.code, 'EXTENSION_NO_REPLY');
  assert.match(s.diagnosticText, /확장 상태 응답: 5초 안에 응답 없음/);
  child.stdin.end(); for (let i = 0; i < 100 && pipeClient.connections().hosts.length; i++) await wait(30);
});

await test('Host 로그: 메시지 종류·버전만 남고 프롬프트 본문은 남지 않음', async () => {
  const log = join(HOME, '.gomo-create', 'host.log');
  assert.ok(existsSync(log));
  const text = readFileSync(log, 'utf8');
  assert.match(text, /type=GEMINI_STATUS_RESULT/);
  assert.match(text, /type=HOST_INFO_REQUEST/);
  assert.doesNotMatch(text, /gemini\.google\.com\/app/); // 탭 URL 같은 payload 내용도 없음
});

for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} multi-host checks finished (실제 host.mjs + 서비스 워커, 가짜 chrome API — 실제 Chrome/Windows 검증 아님)`);
process.exit(process.exitCode || 0);
