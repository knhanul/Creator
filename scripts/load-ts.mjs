/** 테스트용: TypeScript 파일을 CommonJS로 변환해 불러옵니다(상대 경로 .ts / .mjs 지원 안 함). */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js'); }
const cache = new Map();
export function loadTS(filename) {
  filename = resolve(filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  function localRequire(spec) { if (spec.startsWith('.')) return loadTS(resolve(dirname(filename), spec + '.ts')); return require(spec); }
  new Function('require', 'module', 'exports', js)(localRequire, module, module.exports);
  return module.exports;
}
