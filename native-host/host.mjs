#!/usr/bin/env node
/**
 * Chrome Native Messaging Host for GOMO Create.
 * Communicates with Chrome Extension via stdin/stdout (Chrome protocol).
 * Communicates with Electron Main via Named Pipe.
 * NEVER writes logs to stdout.
 */
import { createConnection } from 'node:net';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

const HOST_NAME = 'com.gomo.create';
const PIPE_NAME = process.platform === 'win32' ? `\\\\.\\pipe\\${HOST_NAME}` : `/tmp/${HOST_NAME}.sock`;
const LOG_DIR = join(homedir(), '.gomo-create');
const LOG_FILE = join(LOG_DIR, 'native-host.log');

try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
const log = createWriteStream(LOG_FILE, { flags: 'a' });
function debug(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  log.write(line);
  process.stderr.write(line);
}

let inputBuffer = Buffer.alloc(0);

function readMessages() {
  const messages = [];
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (length > 1024 * 1024) {
      debug('Message too large, closing');
      process.exit(1);
    }
    if (inputBuffer.length < 4 + length) break;
    const json = inputBuffer.subarray(4, 4 + length).toString('utf8');
    inputBuffer = inputBuffer.subarray(4 + length);
    try { messages.push(JSON.parse(json)); } catch (e) { debug('JSON parse error:', e); }
  }
  return messages;
}

function sendToChrome(message) {
  const json = JSON.stringify(message);
  const buf = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

let electronSocket = null;

function connectToElectron() {
  if (electronSocket && !electronSocket.destroyed) return;
  try {
    const sock = createConnection(PIPE_NAME);
    sock.on('connect', () => {
      electronSocket = sock;
      debug('Connected to Electron pipe');
      sock.write(JSON.stringify({ type: 'HOST_HELLO', from: 'native-host' }) + '\n');
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
        try { sendToChrome(JSON.parse(line)); } catch (e) { debug('Bad line from Electron:', e.message); }
      }
    });
    sock.on('error', (err) => {
      debug('Electron pipe error:', err.message);
      if (electronSocket === sock) electronSocket = null;
    });
    sock.on('close', () => {
      debug('Electron pipe closed');
      if (electronSocket === sock) electronSocket = null;
    });
  } catch (e) { debug('Failed to connect to Electron:', e); }
}

debug('Native host started, pid=', process.pid);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  const messages = readMessages();
  for (const msg of messages) {
    debug('From Chrome:', JSON.stringify(msg).slice(0, 200));
    if (electronSocket && !electronSocket.destroyed) {
      electronSocket.write(JSON.stringify(msg) + '\n');
      debug('Forwarded to Electron:', msg.type);
    } else {
      debug('No Electron socket, dropped:', msg.type);
    }
    if (msg && msg.type === 'PING') {
      sendToChrome({
        protocolVersion: 1,
        requestId: msg.requestId || 'pong',
        type: 'PONG',
        timestamp: new Date().toISOString(),
        payload: { nonce: (msg.payload && msg.payload.nonce) || '', from: 'native-host' }
      });
    }
  }
});

process.stdin.on('end', () => { debug('stdin closed, exiting'); process.exit(0); });

connectToElectron();
setInterval(() => { if (!electronSocket) connectToElectron(); }, 2000);
