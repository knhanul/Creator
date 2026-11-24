#!/usr/bin/env node
/**
 * Chrome Native Messaging Host for GOMO Create.
 * Chrome 확장 ↔ (stdin/stdout, Chrome 규격) ↔ 이 Host ↔ (Named Pipe, 줄 단위 JSON) ↔ Electron 앱.
 * Chrome은 확장의 connectNative() 한 번마다 이 프로세스를 하나씩 띄웁니다(프로필·확장 사본이 여럿이면 Host도 여럿).
 * stdout에는 Chrome 메시지 외에 아무것도 쓰지 않습니다.
 * 로그(%USERPROFILE%\.gomo-create\host.log)에는 메시지 종류·ID·버전만 남기고 프롬프트·응답 본문은 남기지 않습니다.
 */
import { createConnection } from 'node:net';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

const HOST_NAME = 'com.gomo.create';
/** 자동화 프로토콜 수준 (src/shared/gemini-protocol.ts AUTOMATION_PROTOCOL과 같아야 함) */
const HOST_PROTOCOL = 2;
const HOST_VERSION = '0.2.2';
const STARTED_AT = new Date().toISOString();
// GOMO_CREATE_PIPE: 테스트에서만 사용(기본 경로는 그대로)
const PIPE_NAME = process.env.GOMO_CREATE_PIPE || (process.platform === 'win32' ? `\\\\.\\pipe\\${HOST_NAME}` : `/tmp/${HOST_NAME}.sock`);
const LOG_DIR = join(homedir(), '.gomo-create');
const LOG_FILE = join(LOG_DIR, 'host.log');
const LOG_MAX = 512 * 1024; // 넘으면 host.log.1로 돌림(1개만 보관)
/** Chrome이 첫 인자로 호출한 확장의 origin을 넘겨줌 (chrome-extension://<ID>/) */
const CALLER = process.argv.slice(2).find(a => a.startsWith('chrome-extension://')) || '';

try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
function log(...args) {
  const line = `[${new Date().toISOString()}] pid=${process.pid} ${args.map(String).join(' ')}\n`;
  try {
    try { if (statSync(LOG_FILE).size > LOG_MAX) renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* 없음 */ }
    appendFileSync(LOG_FILE, line);
  } catch { /* 로그 실패는 무시 */ }
}
/** 로그용 요약: 종류·ID·버전만 (prompt/text/codeBlocks 등 본문은 절대 남기지 않음) */
function brief(m) {
  if (!m || typeof m !== 'object') return 'invalid';
  const p = m.payload && typeof m.payload === 'object' ? m.payload : {};
  const parts = [`type=${m.type}`];
  if (m.requestId) parts.push(`req=${String(m.requestId).slice(0, 8)}`);
  const jobId = m.jobId || p.jobId; if (jobId) parts.push(`job=${String(jobId).slice(0, 8)}`);
  if (m.projectId) parts.push(`project=${String(m.projectId).slice(0, 8)}`);
  const ver = p.version ?? p.extension?.version ?? m.extensionVersion; if (ver) parts.push(`ver=${ver}`);
  const proto = p.protocol ?? p.extension?.protocol ?? m.extensionProtocol; if (proto !== undefined) parts.push(`proto=${proto}`);
  if (p.errorCode || p.code) parts.push(`code=${p.errorCode || p.code}`);
  if (p.sendState) parts.push(`send=${p.sendState}`);
  return parts.join(' ');
}

/** 이 Host를 띄운 확장이 보낸 HELLO (없으면 아직 못 받음). 0.2.0 이하 확장은 protocol을 보내지 않음 */
let extensionHello = null;
let chromeConnected = true;
let fromChromeCount = 0;
let lastFromChromeAt = null;

function info() {
  return {
    protocol: HOST_PROTOCOL, version: HOST_VERSION, pid: process.pid, startedAt: STARTED_AT, node: process.version,
    script: import.meta.url, caller: CALLER, logFile: LOG_FILE,
    chromeConnected, extension: extensionHello, fromChromeCount, lastFromChromeAt
  };
}

let inputBuffer = Buffer.alloc(0);
function readMessages() {
  const messages = [];
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (length > 1024 * 1024) { log('message too large, exiting'); process.exit(1); }
    if (inputBuffer.length < 4 + length) break;
    const json = inputBuffer.subarray(4, 4 + length).toString('utf8');
    inputBuffer = inputBuffer.subarray(4 + length);
    try { messages.push(JSON.parse(json)); } catch { log('JSON parse error from Chrome'); }
  }
  return messages;
}

function sendToChrome(message) {
  const buf = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

let electronSocket = null;
function writeElectron(obj) {
  if (electronSocket && !electronSocket.destroyed) { electronSocket.write(JSON.stringify(obj) + '\n'); return true; }
  return false;
}
function hostHello() { return { type: 'HOST_HELLO', from: 'native-host', ...info() }; }

function connectToElectron() {
  if (electronSocket && !electronSocket.destroyed) return;
  try {
    const sock = createConnection(PIPE_NAME);
    sock.on('connect', () => {
      electronSocket = sock;
      log('connected to app pipe', `caller=${CALLER || '-'}`);
      sock.write(JSON.stringify(hostHello()) + '\n');
    });
    // 큰 프롬프트는 여러 data 청크로 나뉘어 올 수 있으므로 줄 단위로 버퍼링합니다.
    let pending = '';
    const decoder = new StringDecoder('utf8'); // 청크 경계에서 한글(멀티바이트)이 깨지지 않도록
    sock.on('data', (data) => {
      pending += decoder.write(data);
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { log('bad line from app'); continue; }
        if (msg && msg.type === 'HOST_INFO_REQUEST') {
          // 앱의 연결 확인에 Host가 직접 답함 — Chrome으로 넘기지 않음
          sock.write(JSON.stringify({ protocolVersion: 1, requestId: msg.requestId, type: 'HOST_INFO_RESULT', timestamp: new Date().toISOString(), payload: info() }) + '\n');
          log('app -> host', brief(msg), '(answered by host)');
          continue;
        }
        log('app -> chrome', brief(msg));
        sendToChrome(msg);
      }
    });
    sock.on('error', (err) => { log('app pipe error:', err.code || err.message); if (electronSocket === sock) electronSocket = null; });
    sock.on('close', () => { if (electronSocket === sock) { electronSocket = null; log('app pipe closed'); } });
  } catch (e) { log('failed to connect to app:', e && e.message); }
}

log('host started', `version=${HOST_VERSION}`, `caller=${CALLER || '-'}`, `node=${process.version}`);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  for (const msg of readMessages()) {
    fromChromeCount++; lastFromChromeAt = new Date().toISOString();
    if (msg && msg.type === 'HELLO') {
      const p = msg.payload || {};
      extensionHello = { version: p.version ?? null, protocol: p.protocol ?? null, at: lastFromChromeAt };
      // 앱이 어느 Host(=어느 확장)와 이야기할지 고를 수 있도록 갱신된 정보를 다시 알림
      writeElectron(hostHello());
    }
    const ok = writeElectron(msg);
    log('chrome -> app', brief(msg), ok ? '' : '(app not connected, dropped)');
    if (msg && msg.type === 'PING') {
      sendToChrome({ protocolVersion: 1, requestId: msg.requestId || 'pong', type: 'PONG', timestamp: new Date().toISOString(), payload: { nonce: (msg.payload && msg.payload.nonce) || '', from: 'native-host' } });
    }
  }
});

// 확장 포트가 닫히면(서비스 워커 종료·확장 새로고침·Chrome 종료) 즉시 종료 → 오래된 Host가 앱 연결을 붙잡고 있지 않게
function bye(reason) {
  chromeConnected = false;
  log('chrome side closed, exiting:', reason);
  try { if (electronSocket) electronSocket.end(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 50);
}
process.stdin.on('end', () => bye('stdin end'));
process.stdin.on('close', () => bye('stdin close'));
process.stdin.on('error', (e) => bye('stdin error ' + (e && e.code)));
process.stdout.on('error', (e) => bye('stdout error ' + (e && e.code)));

connectToElectron();
setInterval(() => { if (!electronSocket) connectToElectron(); }, 2000);
