#!/usr/bin/env node
/**
 * Chrome Native Messaging Host for GOMO Create.
 * Communicates with Chrome Extension via stdin/stdout (Chrome protocol).
 * Communicates with Electron Main via Named Pipe.
 * NEVER writes logs to stdout.
 */
import { createConnection, createServer } from 'node:net';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
let pipeServer = null;

function connectToElectron() {
  try {
    electronSocket = createConnection(PIPE_NAME, () => {
      debug('Connected to Electron pipe');
      if (electronSocket) electronSocket.write(JSON.stringify({ type: 'HOST_HELLO', from: 'native-host' }) + '\n');
    });
    electronSocket.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try { sendToChrome(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    electronSocket.on('error', (err) => { debug('Electron pipe error:', err.message); electronSocket = null; });
    electronSocket.on('close', () => { debug('Electron pipe closed'); electronSocket = null; });
  } catch (e) { debug('Failed to connect to Electron:', e); }
}

function startPipeServer() {
  try {
    pipeServer = createServer((socket) => {
      debug('Electron connected to host pipe');
      electronSocket = socket;
      socket.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try { sendToChrome(JSON.parse(line)); } catch { /* ignore */ }
        }
      });
      socket.on('close', () => { if (electronSocket === socket) electronSocket = null; });
    });
    pipeServer.listen(PIPE_NAME, () => debug('Pipe server listening:', PIPE_NAME));
    pipeServer.on('error', (err) => debug('Pipe server error:', err.message));
  } catch (e) { debug('Could not start pipe server:', e); }
}

debug('Native host started, pid=', process.pid);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  const messages = readMessages();
  for (const msg of messages) {
    debug('From Chrome:', JSON.stringify(msg).slice(0, 200));
    if (electronSocket && !electronSocket.destroyed) {
      electronSocket.write(JSON.stringify(msg) + '\n');
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

startPipeServer();
setTimeout(connectToElectron, 500);
setInterval(() => { if (!electronSocket) connectToElectron(); }, 5000);
