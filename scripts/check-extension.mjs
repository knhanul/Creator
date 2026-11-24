/**
 * Chrome 확장 정적 점검: manifest 형식, 참조 파일 존재, JS 문법, 셀렉터 미검증 표시.
 * 사용: node scripts/check-extension.mjs   (Chrome 실제 로드 검증은 아님)
 */
import { readFileSync, existsSync } from 'node:fs';
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
const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(ext, 'gemini-selectors.js'), 'utf8'), ctx);
const sel = ctx.GOMO_GEMINI_SELECTORS.SELECTORS;
const all = Object.values(sel).flat();
const verified = all.filter(s => s.verified).length;
const { JSDOM } = await import('jsdom');
const doc = new JSDOM('<!doctype html><body></body>').window.document;
for (const s of all) { try { doc.querySelectorAll(s.sel); } catch (e) { throw new Error(`잘못된 CSS 셀렉터: ${s.sel}`); } }
console.log(`extension OK: ${files.length} files, ${all.length} selectors (verified on real Gemini: ${verified}, unverified: ${all.length - verified})`);
