/**
 * Register / unregister Chrome Native Messaging Host on Windows (HKCU).
 * Usage:
 *   node native-host/register.mjs register [--extension-id=ID]
 *   node native-host/register.mjs unregister
 *   node native-host/register.mjs check
 */
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const HOST_NAME = 'com.gomo.create';
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const MANIFEST_DIR = join(homedir(), '.gomo-create');
const MANIFEST_PATH = join(MANIFEST_DIR, 'com.gomo.create.json');
const HOST_SCRIPT = resolve(process.cwd(), 'native-host', 'host.mjs');

function getNodePath() {
  return process.execPath; // node executable
}

function buildManifest(extensionId) {
  const origins = extensionId
    ? [`chrome-extension://${extensionId}/`]
    : ['chrome-extension://DEVELOPMENT_PLACEHOLDER/'];
  return {
    name: HOST_NAME,
    description: 'GOMO Create Native Messaging Host',
    path: getNodePath(),
    type: 'stdio',
    allowed_origins: origins,
    // args passed via a wrapper; Chrome invokes the path directly.
    // For Node hosts we typically use a .bat or the node binary with args.
    // Simpler: a small .cmd wrapper that calls node.
  };
}

function writeWrapper() {
  const wrapper = join(MANIFEST_DIR, 'gomo-host.cmd');
  const content = `@echo off\r\n"${getNodePath()}" "${HOST_SCRIPT}" %*\r\n`;
  writeFileSync(wrapper, content);
  return wrapper;
}

function register(extensionId) {
  if (process.platform !== 'win32') {
    console.error('Native host registration is Windows-only (HKCU).');
    process.exit(1);
  }
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const wrapper = writeWrapper();
  const manifest = {
    name: HOST_NAME,
    description: 'GOMO Create Native Messaging Host',
    path: wrapper,
    type: 'stdio',
    allowed_origins: extensionId
      ? [`chrome-extension://${extensionId}/`]
      : ['chrome-extension://DEVELOPMENT_PLACEHOLDER/']
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  try {
    execSync(`reg add "${REG_KEY}" /ve /t REG_SZ /d "${MANIFEST_PATH.replace(/\\/g, '\\\\')}" /f`, { stdio: 'inherit' });
    console.log('Registered:', HOST_NAME);
    console.log('Manifest:', MANIFEST_PATH);
    console.log('Wrapper:', wrapper);
  } catch (e) {
    console.error('Registry write failed:', e.message);
    process.exit(1);
  }
}

function unregister() {
  if (process.platform !== 'win32') {
    console.error('Windows only.');
    process.exit(1);
  }
  try {
    execSync(`reg delete "${REG_KEY}" /f`, { stdio: 'inherit' });
    console.log('Unregistered:', HOST_NAME);
  } catch (e) {
    console.error('Unregister failed (may not exist):', e.message);
  }
}

function check() {
  if (process.platform !== 'win32') {
    console.log('Not Windows — skipping registry check.');
    console.log('Host script exists:', existsSync(HOST_SCRIPT));
    return;
  }
  try {
    const out = execSync(`reg query "${REG_KEY}" /ve`, { encoding: 'utf8' });
    console.log(out);
    if (existsSync(MANIFEST_PATH)) {
      console.log('Manifest content:');
      console.log(require('fs').readFileSync(MANIFEST_PATH, 'utf8'));
    }
  } catch {
    console.log('Host not registered.');
  }
}

const cmd = process.argv[2];
const extArg = process.argv.find(a => a.startsWith('--extension-id='));
const extId = extArg ? extArg.split('=')[1] : undefined;

if (cmd === 'register') register(extId);
else if (cmd === 'unregister') unregister();
else if (cmd === 'check') check();
else {
  console.log('Usage: node native-host/register.mjs <register|unregister|check> [--extension-id=ID]');
  process.exit(1);
}
