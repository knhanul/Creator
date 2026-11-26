/**
 * 「Gemini로 원문 찾기」 테스트: 프롬프트·응답 해석·저작권 판정·작업 큐 경로.
 * Mock adapter + 실제 GeminiJobQueue. 실제 Chrome/Gemini는 사용하지 않습니다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { GeminiJobQueue } from '../src/main/gemini/job-queue.mjs';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const { createAnalysisService } = loadTS(join(root, 'src/main/gemini/analysis-service.ts'));
const { DEFAULT_BRIEF, makeProject } = loadTS(join(root, 'src/shared/workflow.ts'));
const { makeSourceLookupPrompt, sourceResultFromGemini, extractSourceJson, SOURCE_SCHEMA } = loadTS(join(root, 'src/shared/gemini-source.ts'));
const { canApproveOriginalRights } = loadTS(join(root, 'src/shared/copyright.ts'));

const dir = mkdtempSync(join(tmpdir(), 'gomo-source-'));
const ID = 'aaaaaaaa-0000-0000-0000-00000000000a';
const POEM = '님은 갔습니다. 아아 사랑하는 나의 님은 갔습니다.\n푸른 산빛을 깨치고 단풍나무 숲을 향하여 난 작은 길을 걸어서 차마 떨치고 갔습니다.\n\n황금의 꽃같이 굳고 빛나던 옛 맹세는 차디찬 티끌이 되어서 한숨의 미풍에 날아갔습니다.';
const answer = (extra = {}) => JSON.stringify({ schema: SOURCE_SCHEMA, found: true, title: '님의 침묵', author: '한용운', translator: '', edition: '『님의 침묵』, 회동서관, 1926', publishedYear: '1926', authorDeathYear: 1944, isTranslation: false, isForeignWork: false, sourceUrl: 'https://ko.wikisource.org/wiki/님의_침묵', truncated: false, note: '', originalText: POEM, ...extra }, null, 2);
const Q = { title: '님의 침묵', author: '한용운', genre: 'poetry' };

let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label); console.error(e); process.exitCode = 1; }
}

await test('프롬프트: 제목·저자·스키마 포함, 같은 검색어면 같은 프롬프트', () => {
  const p = makeSourceLookupPrompt(Q);
  assert.ok(p.includes('님의 침묵') && p.includes('한용운') && p.includes(SOURCE_SCHEMA));
  assert.equal(p, makeSourceLookupPrompt({ ...Q, title: '  님의 침묵 ' }));
  assert.notEqual(p, makeSourceLookupPrompt({ ...Q, author: '김소월' }));
});

await test('응답 해석: 코드 블록 JSON → 원문 검토 결과 (줄바꿈·연 구분 보존)', () => {
  const r = sourceResultFromGemini({ resultText: '여기 있습니다', codeBlocks: [answer()] }, Q);
  assert.equal(r.ok, true);
  assert.equal(r.originalText, POEM);
  assert.equal(r.title, '님의 침묵');
  assert.equal(r.author, '한용운');
  assert.equal(r.sourceId, 'gemini');
  assert.ok(r.sourceUrl.startsWith('https://'));
  assert.ok(r.verification.issues.some(i => i.code === 'MIXED_EDITION'), 'AI 원문 검토 경고');
});

await test('저작권: AI가 알려준 사망연도로 만료여도 검증됨이 아니라 확인 체크 필요', () => {
  const r = sourceResultFromGemini({ codeBlocks: [answer()] }, Q);
  assert.equal(r.rights.status, 'REVIEW_REQUIRED');
  assert.equal(canApproveOriginalRights(r.rights).allowed, false);
  assert.equal(canApproveOriginalRights(r.rights, { allowReviewRequiredWithAck: true }).allowed, true);
});

await test('저작권: 보호기간이 남은 작품은 RESTRICTED', () => {
  const r = sourceResultFromGemini({ codeBlocks: [answer({ authorDeathYear: 2000 })] }, Q);
  assert.equal(r.rights.status, 'RESTRICTED');
});

await test('응답 해석: 문자열 안에 실제 줄바꿈이 있는 JSON도 읽음', () => {
  const raw = `\`\`\`json\n{"schema":"${SOURCE_SCHEMA}","found":true,"title":"님의 침묵","author":"한용운","originalText":"첫 행\n둘째 행\n\n둘째 연"}\n\`\`\``;
  const o = extractSourceJson(raw, []);
  assert.equal(o.originalText, '첫 행\n둘째 행\n\n둘째 연');
});

await test('응답 해석: found=false / JSON 없음 → ok=false (지어내지 않음)', () => {
  const a = sourceResultFromGemini({ codeBlocks: [answer({ found: false, originalText: '', note: '확실하지 않음' })] }, Q);
  assert.equal(a.ok, false);
  assert.equal(a.errorCode, 'NOT_FOUND');
  assert.ok(a.errorMessage.includes('확실하지 않음'));
  const b = sourceResultFromGemini({ resultText: '죄송합니다. 찾을 수 없습니다.' }, Q);
  assert.equal(b.ok, false);
  assert.equal(b.errorCode, 'INVALID_JSON');
});

await test('응답 해석: 잘림 표시·http 주소', () => {
  const r = sourceResultFromGemini({ codeBlocks: [answer({ truncated: true, sourceUrl: 'http://example.com' })] }, Q);
  assert.equal(r.sourceUrl, '');
  assert.ok(r.verification.issues.some(i => i.code === 'POSSIBLE_TRUNCATION'));
});

await test('작업 큐: source 작업 전송 → 응답 수신 → 작품은 바꾸지 않고 received', async () => {
  const project = makeProject(ID, { ...DEFAULT_BRIEF, title: '님의 침묵' });
  const saves = [];
  const queue = new GeminiJobQueue(join(dir, 'q1.json'));
  await queue.load();
  const submits = [];
  const adapter = {
    async getStatus() { return { connected: true, hostRegistered: true, extensionConnected: true, geminiTabFound: true, loginState: 'unknown', message: 'ok' }; },
    async submitPrompt(job) { submits.push(job); return { success: true, sendState: 'sent', jobId: job.jobId }; },
    async requestResult() { return { ok: true, message: '' }; }
  };
  const svc = createAnalysisService({ queue, adapter, readProject: async () => structuredClone(project), saveProject: async p => { saves.push(p); return p; } });
  const empty = await svc.startSource(ID, { title: '  ' });
  assert.equal(empty.ok, false);
  const r = await svc.startSource(ID, Q);
  assert.equal(r.ok, true);
  await svc.kick();
  assert.equal(submits.length, 1);
  assert.equal(submits[0].stage, 'source');
  const again = await svc.startSource(ID, Q);
  assert.equal(again.reused, true, '같은 검색 진행 중이면 다시 보내지 않음');
  const other = await svc.startSource(ID, { ...Q, title: '진달래꽃' });
  assert.equal(other.ok, false, '다른 검색은 앞 요청이 끝난 뒤');
  const job = queue.get(r.job.jobId);
  const msg = { protocolVersion: 1, type: 'RESPONSE_RECEIVED', requestId: job.requestId, jobId: job.jobId, projectId: ID, timestamp: new Date().toISOString(), payload: { jobId: job.jobId, text: '', codeBlocks: [answer()], complete: true } };
  assert.equal(await svc.handleMessage(msg), 'applied');
  const done = queue.get(job.jobId);
  assert.equal(done.state, 'completed');
  assert.equal(done.outcome, 'received');
  assert.equal(saves.length, 0, '작품에 바로 저장하지 않음');
  assert.equal(sourceResultFromGemini(done, Q).originalText, POEM);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} checks passed${process.exitCode ? ' (일부 실패)' : ''}`);
