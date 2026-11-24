/**
 * Chrome 확장 정적 점검: manifest 형식, 참조 파일 존재, JS 문법, 셀렉터 미검증 표시.
 * 사용: node scripts/check-extension.mjs   (Chrome 실제 로드 검증은 아님)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const ext = resolve(import.meta.dirname, '..', 'extension');
const m = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
assert.equal(m.manifest_version, 3);
for (const p of ['nativeMessaging', 'tabs', 'storage', 'scripting']) assert.ok(m.permissions.includes(p), `permission ${p}`);
assert.deepEqual(m.host_permissions, ['https://gemini.google.com/*'], 'Gemini 외 사이트 권한 없음');
const files = [m.background.service_worker, ...m.content_scripts.flatMap(c => c.js)];
for (const f of files) {
  assert.ok(existsSync(join(ext, f)), `missing ${f}`);
  new vm.Script(readFileSync(join(ext, f), 'utf8'), { filename: f }); // 문법 검사
}
// ── 서비스 워커가 확실히 새 코드인지 (2026-11-24: 카드는 새 버전인데 0.1.0 background.js가 실행된 사례) ──
const swFile = m.background.service_worker;
const sw = readFileSync(join(ext, swFile), 'utf8');
const proto = Number(/AUTOMATION_PROTOCOL = (\d+)/.exec(readFileSync(resolve(ext, '..', 'src/shared/gemini-protocol.ts'), 'utf8'))?.[1]);
assert.ok(proto >= 2, 'src/shared/gemini-protocol.ts AUTOMATION_PROTOCOL');
assert.match(sw, new RegExp(`const AUTOMATION_PROTOCOL = ${proto};`), `${swFile}: AUTOMATION_PROTOCOL ${proto} 없음`);
assert.match(readFileSync(join(ext, 'content.js'), 'utf8'), new RegExp(`const CONTENT_PROTOCOL = ${proto};`), 'content.js CONTENT_PROTOCOL');
assert.match(readFileSync(resolve(ext, '..', 'native-host/host.mjs'), 'utf8'), new RegExp(`const HOST_PROTOCOL = ${proto};`), 'host.mjs HOST_PROTOCOL');
assert.match(sw, /chrome\.runtime\.getManifest\(\)\.version/, `${swFile}: 버전은 getManifest()에서 읽어야 함`);
assert.equal((sw.match(/connectNative\(/g) || []).length, 1, `${swFile}: connectNative 호출은 한 곳뿐이어야 함`);
assert.doesNotMatch(sw, /onStartup\.addListener|onInstalled\.addListener\(\(\) => connect/, `${swFile}: onStartup/onInstalled에서 다시 연결하면 Host가 2개 뜸`);
assert.match(sw, new RegExp(`const BG_BUILD = '${m.version.replace(/\./g, '\\.')}';`), `${swFile}: BG_BUILD가 manifest 버전(${m.version})과 같아야 함`);
assert.match(sw, /console\.info\(`GOMO background protocol/, `${swFile}: 시작 로그 없음`);
// 하드코딩된 0.1.0이 남아 있으면 안 됨, manifest가 참조하지 않는 .js(남은 이전 파일)도 안 됨
const onDisk = readdirSync(ext).filter(f => f.endsWith('.js'));
for (const f of onDisk) assert.doesNotMatch(readFileSync(join(ext, f), 'utf8'), /['"]0\.1\.0['"]/, `${f}: 하드코딩된 '0.1.0'`);
const stray = onDisk.filter(f => !files.includes(f));
assert.deepEqual(stray, [], `manifest가 참조하지 않는 JS 파일(이전 파일 잔재): ${stray.join(', ')}`);
const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(ext, 'gemini-selectors.js'), 'utf8'), ctx);
const sel = ctx.GOMO_GEMINI_SELECTORS.SELECTORS;
const all = Object.values(sel).flat();
const verified = all.filter(s => s.verified).length;
const { JSDOM } = await import('jsdom');
const doc = new JSDOM('<!doctype html><body></body>').window.document;
for (const s of all) { try { doc.querySelectorAll(s.sel); } catch (e) { throw new Error(`잘못된 CSS 셀렉터: ${s.sel}`); } }
console.log(`extension OK: v${m.version}, service worker ${swFile} (protocol ${proto}), ${files.length} files, ${all.length} selectors (verified on real Gemini: ${verified}, unverified: ${all.length - verified})`);
