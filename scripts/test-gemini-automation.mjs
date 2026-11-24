/**
 * 「AI 기획 분석 시작」 자동화 통합 테스트 (Mock Native Messaging adapter + 실제 GeminiJobQueue + 메모리 저장소).
 * 실제 Chrome/Gemini는 사용하지 않습니다.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { GeminiJobQueue } from '../src/main/gemini/job-queue.mjs';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const { createAnalysisService } = loadTS(join(root, 'src/main/gemini/analysis-service.ts'));
const { DEFAULT_BRIEF, makeProject, applyAIResponse, extractJSON } = loadTS(join(root, 'src/shared/workflow.ts'));
const { answerCandidates, phaseView, guideFor, PHASE_LABEL } = loadTS(join(root, 'src/shared/gemini-analysis.ts'));
const { matchesJob, makeRequestMarker, createMessage } = loadTS(join(root, 'src/shared/gemini-protocol.ts'));
const analysisJSON = readFileSync(join(root, 'fixtures/ai-analysis.example.json'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'gomo-auto-'));
let n = 0;
const wait = (ms = 5) => new Promise(r => setTimeout(r, ms));

const ID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ID_B = 'bbbbbbbb-0000-0000-0000-000000000002';
function makeStore() {
  const data = new Map();
  for (const [id, title] of [[ID_A, '작품 A'], [ID_B, '작품 B']]) data.set(id, makeProject(id, { ...DEFAULT_BRIEF, title, originalText: `${title}의 원문입니다.\n둘째 줄.` }));
  const saves = [];
  return {
    data, saves,
    async readProject(id) { const p = data.get(id); if (!p) throw Error('not found'); return structuredClone(p); },
    async saveProject(p) { const cur = data.get(p.id); if (p.revision !== cur.revision) throw Error('다른 작업에서 프로젝트가 변경되었습니다.'); const next = { ...structuredClone(p), revision: cur.revision + 1, updatedAt: new Date().toISOString() }; data.set(p.id, next); saves.push(p.id); return structuredClone(next); }
  };
}
function makeAdapter(opts = {}) {
  const a = {
    submits: [], queries: [],
    status: { connected: true, hostRegistered: true, extensionConnected: true, geminiTabFound: true, loginState: 'unknown', message: 'Gemini 탭이 감지되었습니다.' },
    async getStatus() { return a.status; },
    async submitPrompt(job) { a.submits.push(job); return opts.submitResult ? opts.submitResult(job) : { success: true, sendState: 'sent', jobId: job.jobId, tab: { id: 7, title: 'Gemini' } }; },
    async requestResult(job) { a.queries.push(job); return { ok: true, message: 'requested' }; }
  };
  return a;
}
async function setup(opts = {}) {
  const store = makeStore();
  const queue = new GeminiJobQueue(opts.path || join(dir, `q${++n}.json`));
  await queue.load();
  const adapter = makeAdapter(opts);
  const svc = createAnalysisService({ queue, adapter, readProject: store.readProject, saveProject: store.saveProject });
  return { store, queue, adapter, svc };
}
function resp(job, overrides = {}, payload = {}) {
  return { protocolVersion: 1, type: 'RESPONSE_RECEIVED', requestId: job.requestId, jobId: job.jobId, projectId: job.projectId, timestamp: new Date().toISOString(), payload: { jobId: job.jobId, text: '요청하신 분석입니다.', codeBlocks: [analysisJSON], complete: true, ...payload }, ...overrides };
}
let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

// ── 프로토콜 ─────────────────────────────────────────────
await test('프로토콜: jobId·requestId·projectId 모두 일치할 때만 매칭', () => {
  const job = { jobId: 'j1', requestId: 'r1', projectId: 'p1' };
  assert.equal(matchesJob({ jobId: 'j1', requestId: 'r1', projectId: 'p1' }, job), true);
  assert.equal(matchesJob({ requestId: 'r1', projectId: 'p1', payload: { jobId: 'j1' } }, job), true);
  assert.equal(matchesJob({ jobId: 'j1', requestId: 'r2', projectId: 'p1' }, job), false);
  assert.equal(matchesJob({ jobId: 'j1', requestId: 'r1', projectId: 'p2' }, job), false);
  assert.equal(matchesJob({ jobId: 'j1', requestId: 'r1' }, job), false);
  const m = createMessage('PROMPT_SUBMIT_REQUEST', { prompt: 'x', stage: 'analysis', jobId: 'j1', projectId: 'p1', marker: makeRequestMarker('r1') }, { requestId: 'r1', jobId: 'j1', projectId: 'p1' });
  assert.equal(m.requestId, 'r1'); assert.equal(m.projectId, 'p1'); assert.equal(m.jobId, 'j1');
  assert.notEqual(makeRequestMarker('11111111-aaaa'), makeRequestMarker('22222222-aaaa'));
});

// ── 정상 흐름 ─────────────────────────────────────────────
await test('한 번 시작 → 요청 ID 일치 전송 → 응답 JSON 검증 → 작품 저장 → 분석 완료', async () => {
  const { svc, adapter, queue, store } = await setup();
  const r = await svc.start(ID_A);
  assert.equal(r.ok, true);
  await svc.kick();
  assert.equal(adapter.submits.length, 1);
  const sent = adapter.submits[0]; const job = queue.get(r.job.jobId);
  assert.equal(sent.jobId, job.jobId); assert.equal(sent.requestId, job.requestId); assert.equal(sent.projectId, ID_A);
  assert.ok(sent.prompt.includes('creator.analysis.v1') && sent.prompt.includes('작품 A의 원문입니다.'), 'makeAIPrompt 재사용');
  assert.equal(job.state, 'waiting'); assert.equal(job.phase, 'waiting');
  assert.equal(await svc.handleMessage({ type: 'JOB_PROGRESS', requestId: job.requestId, jobId: job.jobId, projectId: ID_A, payload: { jobId: job.jobId, stage: 'collecting', info: { chars: 120 } } }), 'applied');
  assert.equal(queue.get(job.jobId).phase, 'collecting');
  assert.equal(await svc.handleMessage(resp(job)), 'applied');
  const done = queue.get(job.jobId);
  assert.equal(done.outcome, 'applied'); assert.equal(done.phase, 'done');
  assert.equal(store.data.get(ID_A).analysis.styles.length, 3);
  assert.equal(store.data.get(ID_A).ai.analysis.status, 'approved');
  assert.equal(phaseView(done).label, '분석 완료');
});

await test('중복 시작(더블클릭) → 작업 1개, 전송 1회', async () => {
  const { svc, adapter, queue } = await setup();
  const [a, b] = await Promise.all([svc.start(ID_A), svc.start(ID_A)]);
  await svc.kick();
  const c = await svc.start(ID_A);
  assert.equal(queue.list().length, 1);
  assert.equal(adapter.submits.length, 1);
  assert.ok(a.reused || b.reused); assert.equal(c.reused, true);
});

// ── 늦은/중복/다른 작품 응답 ───────────────────────────────
await test('requestId·projectId 불일치 또는 projectId 누락 응답은 무시', async () => {
  const { svc, queue, store } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  assert.equal(await svc.handleMessage(resp(job, { requestId: 'other' })), 'ignored');
  assert.equal(await svc.handleMessage(resp(job, { projectId: ID_B })), 'ignored');
  assert.equal(await svc.handleMessage(resp(job, { projectId: undefined })), 'ignored');
  assert.equal(queue.get(job.jobId).state, 'waiting');
  assert.equal(store.saves.length, 0);
  assert.equal(store.data.get(ID_B).analysis, null);
});

await test('중복 응답(완료 후 재도착)은 무시되고 저장은 한 번', async () => {
  const { svc, queue, store } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  await svc.handleMessage(resp(job));
  const rev = store.data.get(ID_A).revision;
  assert.equal(await svc.handleMessage(resp(job, {}, { codeBlocks: [analysisJSON.replace('작은 정원', '덮어쓰기')] })), 'ignored');
  assert.equal(store.saves.length, 1);
  assert.equal(store.data.get(ID_A).revision, rev);
});

await test('다른 작품 보호: A의 응답은 A에만, 사용자가 B를 보고 있어도 B는 변경 없음', async () => {
  const { svc, queue, store } = await setup();
  const { job: ja } = await svc.start(ID_A); await svc.kick();
  const jobA = queue.get(ja.jobId);
  const { job: jb } = await svc.start(ID_B); // A가 응답 대기 중이므로 B는 대기열에서 기다림
  await svc.kick();
  assert.equal(queue.get(jb.jobId).state, 'queued');
  const bBefore = structuredClone(store.data.get(ID_B));
  await svc.handleMessage(resp(jobA));
  assert.equal(store.data.get(ID_A).analysis.summary.length > 0, true);
  assert.deepEqual(store.data.get(ID_B).analysis, bBefore.analysis);
  await wait(10); await svc.kick();
  assert.equal(queue.get(jb.jobId).state, 'waiting', 'A 완료 후 B 전송');
});

await test('재전송 후 옛 requestId로 늦게 온 응답은 무시', async () => {
  const { svc, queue, adapter } = await setup({ submitResult: (job) => ({ success: false, uncertain: true, sendState: 'uncertain', jobId: job.jobId, errorCode: 'SEND_UNCERTAIN' }) });
  const { job: j0 } = await svc.start(ID_A); await svc.kick();
  const old = queue.get(j0.jobId);
  assert.equal(old.state, 'needs_confirmation');
  await queue.confirmResend(old.jobId); // 사용자가 명시적으로 '다시 보내기'
  await svc.kick();
  const now = queue.get(old.jobId);
  assert.notEqual(now.requestId, old.requestId);
  assert.equal(await svc.handleMessage(resp(old)), 'ignored');
  assert.equal(adapter.submits.length, 2);
});

await test('보낸 뒤 작품 정보가 바뀌면 자동 적용 보류(stale) → 사용자 확인 후 적용', async () => {
  const { svc, queue, store } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  const p = store.data.get(ID_A); store.data.set(ID_A, { ...p, brief: { ...p.brief, originalText: '바뀐 원문' } });
  await svc.handleMessage(resp(job));
  let j = queue.get(job.jobId);
  assert.equal(j.outcome, 'stale'); assert.equal(j.errorCode, 'BRIEF_CHANGED'); assert.equal(phaseView(j).label, '사용자 확인 필요');
  assert.equal(store.saves.length, 0);
  j = await svc.applyResult(job.jobId);
  assert.equal(j.outcome, 'applied');
  assert.equal(store.data.get(ID_A).analysis.styles.length, 3);
});

await test('요청 이후 다른 결과가 이미 적용됐으면 덮어쓰지 않음(NEWER_ANALYSIS)', async () => {
  const { svc, queue, store } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  await wait(5);
  const manual = applyAIResponse(store.data.get(ID_A), 'analysis', analysisJSON); // 수동 붙여넣기로 먼저 적용
  await store.saveProject(manual);
  await svc.handleMessage(resp(job));
  assert.equal(queue.get(job.jobId).errorCode, 'NEWER_ANALYSIS');
  assert.equal(store.saves.length, 1);
});

// ── 전송 불명 / 연결 문제 ───────────────────────────────────
await test('전송 불명 → 사용자 확인 필요, 반복 kick에도 자동 재전송 없음 → 기다리기 선택 후 응답 수락', async () => {
  const { svc, queue, adapter, store } = await setup({ submitResult: (job) => ({ success: false, uncertain: true, sendState: 'uncertain', jobId: job.jobId, errorCode: 'SEND_UNCERTAIN', message: '증거 없음' }) });
  const { job: j0 } = await svc.start(ID_A);
  await svc.kick(); await svc.kick(); await svc.kick();
  const job = queue.get(j0.jobId);
  assert.equal(adapter.submits.length, 1);
  assert.equal(job.state, 'needs_confirmation'); assert.equal(job.sendConfirmed, false);
  assert.equal(phaseView(job).label, '사용자 확인 필요');
  assert.ok(guideFor(job).fix.includes('자동으로 다시 보내지 않습니다'));
  assert.equal((await queue.continueWaiting(job.jobId)).state, 'waiting');
  await svc.handleMessage(resp(job));
  assert.equal(queue.get(job.jobId).outcome, 'applied');
  assert.equal(store.saves.length, 1);
});

await test('전송 결과 시간 초과 후 늦게 온 "sent" 결과 → 재전송 없이 응답 대기', async () => {
  const { svc, queue, adapter } = await setup({ submitResult: (job) => ({ success: false, uncertain: true, sendState: 'uncertain', jobId: job.jobId, errorCode: 'TIMEOUT' }) });
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  assert.equal(job.state, 'needs_confirmation');
  await svc.handleMessage({ type: 'PROMPT_SUBMIT_RESULT', requestId: job.requestId, jobId: job.jobId, projectId: ID_A, payload: { jobId: job.jobId, success: true, sendState: 'sent' } });
  assert.equal(queue.get(job.jobId).state, 'waiting');
  assert.equal(adapter.submits.length, 1);
});

await test('연결 확인 실패(Gemini 탭 없음) → 보내지 않음 + 원인·해결 안내, 다시 시도는 명시적으로만', async () => {
  const { svc, queue, adapter } = await setup();
  adapter.status = { ...adapter.status, geminiTabFound: false, message: 'Gemini 탭을 찾을 수 없습니다.' };
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); await svc.kick();
  const job = queue.get(j0.jobId);
  assert.equal(job.state, 'failed'); assert.equal(job.errorCode, 'NO_GEMINI_TAB'); assert.equal(adapter.submits.length, 0);
  assert.equal(phaseView(job).label, '사용자 확인 필요');
  assert.equal(phaseView(job).step, 0, '연결 확인 단계에서 멈춤으로 표시');
  assert.ok(guideFor(job).fix.includes('gemini.google.com'));
  adapter.status = { ...adapter.status, geminiTabFound: true };
  await queue.retry(job.jobId); await svc.kick();
  assert.equal(adapter.submits.length, 1);
});

await test('전송 후 content script 오류(응답 시간 초과) → 사용자 확인 필요, 부분 응답 보존', async () => {
  const { svc, queue } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  await svc.handleMessage({ type: 'ERROR', requestId: job.requestId, jobId: job.jobId, projectId: ID_A, payload: { code: 'RESPONSE_TIMEOUT', message: 't', recoverable: true, jobId: job.jobId, partialText: '부분' } });
  const j = queue.get(job.jobId);
  assert.equal(j.state, 'needs_confirmation'); assert.equal(j.resultText, '부분'); assert.equal(j.errorCode, 'RESPONSE_TIMEOUT');
});

await test('연결 해제 → 확인 필요, 진행 알림이 다시 오면 대기로 복귀 후 정상 완료', async () => {
  const { svc, queue } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  await queue.markConnectionLost();
  assert.equal(queue.get(job.jobId).errorCode, 'CONNECTION_LOST_WAITING');
  await svc.handleMessage({ type: 'JOB_PROGRESS', requestId: job.requestId, jobId: job.jobId, projectId: ID_A, payload: { jobId: job.jobId, stage: 'collecting' } });
  assert.equal(queue.get(job.jobId).state, 'waiting');
  await svc.handleMessage(resp(job));
  assert.equal(queue.get(job.jobId).outcome, 'applied');
});

await test('앱 재시작: 대기 중 작업 보존 → 재연결 시 보관 응답 조회만(재전송 아님) → 적용', async () => {
  const path = join(dir, 'restart.json');
  const first = await setup({ path });
  const { job: j0 } = await first.svc.start(ID_A); await first.svc.kick();
  const job = first.queue.get(j0.jobId);
  // 앱 종료 후 재시작 (같은 저장소 파일, 같은 작품 저장소)
  const queue2 = new GeminiJobQueue(path); await queue2.load();
  const adapter2 = makeAdapter();
  const svc2 = createAnalysisService({ queue: queue2, adapter: adapter2, readProject: first.store.readProject, saveProject: first.store.saveProject });
  const restored = queue2.get(job.jobId);
  assert.equal(restored.state, 'needs_confirmation'); assert.equal(restored.errorCode, 'APP_RESTARTED_WAITING'); assert.equal(restored.prompt, job.prompt);
  await svc2.onReconnect();
  assert.equal(adapter2.submits.length, 0, '재전송 없음');
  assert.equal(adapter2.queries.length, 1);
  assert.equal(adapter2.queries[0].requestId, job.requestId);
  await svc2.handleMessage(resp(job, {}, { replayed: true }));
  assert.equal(queue2.get(job.jobId).outcome, 'applied');
  const queue3 = new GeminiJobQueue(path); await queue3.load();
  assert.equal(queue3.get(job.jobId).outcome, 'applied', '완료 결과도 재시작 후 보존');
});

await test('오래 소식 없는 대기 작업 → 사용자 확인 필요(자동 재전송 없음)', async () => {
  const { svc, queue, adapter } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick();
  await queue.expireStale(1000, Date.now() + 60_000);
  assert.equal(queue.get(j0.jobId).errorCode, 'RESPONSE_TIMEOUT');
  await svc.kick();
  assert.equal(adapter.submits.length, 1);
});

// ── JSON 추출·검증 ───────────────────────────────────────
await test('JSON 추출: 코드 블록 / 펜스 / 설명문 섞인 텍스트 / 잘못된 JSON', async () => {
  const obj = JSON.parse(analysisJSON);
  assert.deepEqual(extractJSON('```json\n' + analysisJSON + '\n```'), obj);
  assert.deepEqual(extractJSON('분석 결과입니다.\n' + JSON.stringify(obj) + '\n참고하세요.'), obj);
  assert.deepEqual(extractJSON('JSON\ncontent_copy\n' + analysisJSON), obj, '복사 버튼 텍스트가 섞인 innerText');
  const c = answerCandidates('설명 ' + analysisJSON, ['{"a":1}', analysisJSON]);
  assert.equal(c[0], analysisJSON.trim(), 'creator.analysis.v1 코드 블록 우선');
  const { svc, queue, store } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  await svc.handleMessage(resp(job, {}, { text: '죄송합니다. {"schema":"creator.analysis.v1","summary":""}', codeBlocks: [] }));
  const j = queue.get(job.jobId);
  assert.equal(j.outcome, 'invalid'); assert.equal(j.errorCode, 'INVALID_JSON'); assert.ok(j.validationError);
  assert.equal(phaseView(j).label, '오류');
  assert.equal(store.saves.length, 0);
});

await test('응답이 펜스 없는 텍스트만이어도 검증 통과 시 적용', async () => {
  const { svc, queue, store } = await setup();
  const { job: j0 } = await svc.start(ID_A); await svc.kick(); const job = queue.get(j0.jobId);
  await svc.handleMessage(resp(job, {}, { text: '다음과 같습니다\n' + analysisJSON, codeBlocks: [] }));
  assert.equal(queue.get(job.jobId).outcome, 'applied');
  assert.equal(store.data.get(ID_A).analysis.directions.length, 3);
});

await test('UI 단계 라벨 8종', () => {
  const base = { jobId: 'j', requestId: 'r', projectId: 'p', kind: 'analysis', executable: true, prompt: '', createdAt: '', updatedAt: '', sendConfirmed: false, cancelRequested: false, externalCancelConfirmed: false };
  const L = (j) => phaseView({ ...base, ...j }).label;
  assert.equal(L({ state: 'dispatching', phase: 'checking' }), '연결 확인');
  assert.equal(L({ state: 'dispatching', phase: 'sending' }), '프롬프트 전송 중');
  assert.equal(L({ state: 'waiting', phase: 'waiting' }), 'Gemini 응답 대기');
  assert.equal(L({ state: 'waiting', phase: 'collecting' }), '응답 수집 중');
  assert.equal(L({ state: 'completed', phase: 'validating' }), 'JSON 검증 중');
  assert.equal(L({ state: 'completed', outcome: 'applied' }), '분석 완료');
  assert.equal(L({ state: 'needs_confirmation' }), '사용자 확인 필요');
  assert.equal(L({ state: 'failed', needsUser: false }), '오류');
  assert.equal(Object.keys(PHASE_LABEL).length, 10);
});

console.log(`\n${checks} gemini-automation checks finished (mock adapter)`);
rmSync(dir, { recursive: true, force: true });
if (process.exitCode) process.exit(process.exitCode);
