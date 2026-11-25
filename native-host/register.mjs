/**
 * Register / unregister Chrome Native Messaging Host on Windows (HKCU).
 * Usage:
 *   node native-host/register.mjs register [--extension-id=ID]...
 *   node native-host/register.mjs unregister
 *   node native-host/register.mjs check
 *   node native-host/register.mjs id
 *
 * --extension-id 를 생략하면 manifest.json 의 고정 키로 계산한 ID를 씁니다.
 * 플래그는 여러 번(또는 쉼표로 여러 ID) 줄 수 있고, 고정 ID는 항상 포함됩니다.
 * Host 경로·래퍼 경로는 이 파일 위치 기준으로 잡습니다(실행 폴더와 무관).
 */
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { FIXED_EXTENSION_ID } from './extension-id.mjs';

const HOST_NAME = 'com.gomo.create';
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const MANIFEST_DIR = join(homedir(), '.gomo-create');
const MANIFEST_PATH = join(MANIFEST_DIR, 'com.gomo.create.json');
const HOST_SCRIPT = resolve(import.meta.dirname, 'host.mjs');
const ID_RE = /^[a-p]{32}$/;

export function parseExtensionIds(argv, fixedId = FIXED_EXTENSION_ID) {
  const raw = [];
  for (const a of argv) {
    if (!a.startsWith('--extension-id=')) continue;
    const value = a.slice('--extension-id='.length);
    for (const part of value.split(',')) {
      const id = part.trim();
      if (id) raw.push(id);
    }
  }
  const ids = [];
  const add = (id) => {
    if (!ID_RE.test(id)) {
      throw new Error(`확장 프로그램 ID 형식이 올바르지 않습니다: ${id} (32자의 a–p)`);
    }
    if (!ids.includes(id)) ids.push(id);
  };
  add(fixedId);
  for (const id of raw) add(id);
  return ids;
}

function allowedOrigins(ids) {
  return ids.map((id) => `chrome-extension://${id}/`);
}

function getNodePath() {
  return process.execPath;
}

function writeWrapper() {
  const wrapper = join(MANIFEST_DIR, 'gomo-host.cmd');
  const content = `@echo off\r\n"${getNodePath()}" "${HOST_SCRIPT}" %*\r\n`;
  writeFileSync(wrapper, content);
  return wrapper;
}

function register(ids) {
  if (process.platform !== 'win32') {
    console.error('Native host registration is Windows-only (HKCU).');
    process.exit(1);
  }
  if (!existsSync(HOST_SCRIPT)) {
    console.error('Host script not found:', HOST_SCRIPT);
    process.exit(1);
  }
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const wrapper = writeWrapper();
  const origins = allowedOrigins(ids);
  const manifest = {
    name: HOST_NAME,
    description: 'GOMO Create Native Messaging Host',
    path: wrapper,
    type: 'stdio',
    allowed_origins: origins
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  try {
    execSync(`reg add "${REG_KEY}" /ve /t REG_SZ /d "${MANIFEST_PATH.replace(/\\/g, '\\\\')}" /f`, { stdio: 'inherit' });
    console.log('Registered:', HOST_NAME);
    console.log('Fixed extension ID:', FIXED_EXTENSION_ID);
    console.log('Allowed origins:');
    for (const origin of origins) console.log('  ', origin);
    console.log('Manifest:', MANIFEST_PATH);
    console.log('Wrapper:', wrapper);
    console.log('Host script:', HOST_SCRIPT);
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
  console.log('Fixed extension ID:', FIXED_EXTENSION_ID);
  console.log('Host script:', HOST_SCRIPT, existsSync(HOST_SCRIPT) ? '(exists)' : '(missing)');
  if (process.platform !== 'win32') {
    console.log('Not Windows — skipping registry check.');
    return;
  }
  try {
    const out = execSync(`reg query "${REG_KEY}" /ve`, { encoding: 'utf8' });
    console.log(out);
    if (existsSync(MANIFEST_PATH)) {
      const text = readFileSync(MANIFEST_PATH, 'utf8');
      console.log('Manifest content:');
      console.log(text);
      try {
        const parsed = JSON.parse(text);
        const expected = `chrome-extension://${FIXED_EXTENSION_ID}/`;
        const origins = parsed.allowed_origins || [];
        if (!origins.includes(expected)) {
          console.log('Warning: allowed_origins does not include the fixed ID. Re-run: npm run native:register');
        }
      } catch {
        console.log('Warning: could not parse host manifest JSON.');
      }
    } else {
      console.log('Registry points to a missing manifest:', MANIFEST_PATH);
    }
  } catch (e) {
    console.log('Host not registered or check failed.');
    if (e && e.message) console.log(String(e.message));
  }
}

function isMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return argv1.replace(/\\/g, '/').endsWith('native-host/register.mjs');
}

function main() {
  const cmd = process.argv[2];
  let ids;
  try {
    ids = parseExtensionIds(process.argv.slice(3));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (cmd === 'register') register(ids);
  else if (cmd === 'unregister') unregister();
  else if (cmd === 'check') check();
  else if (cmd === 'id') process.stdout.write(`${FIXED_EXTENSION_ID}\n`);
  else {
    console.log('Usage: node native-host/register.mjs <register|unregister|check|id> [--extension-id=ID]...');
    process.exit(1);
  }
}

if (isMain()) main();
