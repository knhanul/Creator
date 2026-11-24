/**
 * 기획 분석 이후 단계(스토리보드·생성 프롬프트·최종 편집 구성) 자동화 테스트.
 * Mock adapter + 실제 GeminiJobQueue + 메모리 저장소. 실제 Chrome/Gemini는 사용하지 않습니다.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { GeminiJobQueue } from '../src/main/gemini/job-queue.mjs';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const { createAnalysisService } = loadTS(join(root, 'src/main/gemini/analysis-service.ts'));
const { DEFAULT_BRIEF, makeProject, applyAIResponse } = loadTS(join(root, 'src/shared/workflow.ts'));
const { decideStageApply, decideAnalysisApply, STAGE_META, answerCandidates } = loadTS(join(root, 'src/shared/gemini-analysis.ts'));
const fx = name => readFileSync(join(root, 'fixtures', name), 'utf8');
const J = { analysis: fx('ai-analysis.example.json'), storyboard: fx('ai-storyboard.example.json'), prompt: fx('ai-prompts.example.json'), editplan: fx('ai-editplan.example.json') };
const ORIGINAL = '새벽의 작은 정원에 빛이 내려앉았다.\n풀잎 사이로 부드러운 바람이 지나갔다.\n오늘도 좋은 이야기가 시작된다.';
const dir = mkdtempSync(join(tmpdir(), 'gomo-stages-'));
let n = 0;
const ID_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ID_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

/** stage 직전까지 진행된 작품 (분석 + 화풍·연출 선택 [+ 장면 [+ 프롬프트]]) */
function projectUpTo(id, title, stage) {
  let p = makeProject(id, { ...DEFAULT_BRIEF, title, originalText: ORIGINAL });
  p = applyAIResponse(p, 'analysis', J.analysis);
  p = { ...p, selection: { styleId: p.analysis.styles[0].id, directionId: p.analysis.directions[0].id } };
  if (stage === 'storyboard') return p;
  p = applyAIResponse(p, 'storyboard', J.storyboard);
  if (stage === 'prompt') return p;
  p = applyAIResponse(p, 'prompt', J.prompt);
  return p;
}
function makeStore(stage) {
  const data = new Map([[ID_A, projectUpTo(ID_A, '작품 A', stage)], [ID_B, projectUpTo(ID_B, '작품 B', stage)]]);
  const saves = [];
  return {
    data, saves,
    async readProject(id) { const p = data.get(id); if (!p) throw Error('not found'); return structuredClone(p); },
    async saveProject(p) { const cur = data.get(p.id); if (p.revision !== cur.revision) throw Error('다른 작업에서 프로젝트가 변경되었습니다.'); const next = { ...structuredClone(p), revision: cur.revision + 1, updatedAt: new Date().toISOString() }; data.set(p.id, next); saves.push(p.id); return structuredClone(next); }
  };
}
function makeAdapter(opts = {}) {
  const a = {
    submits: [],
    status: { connected: true, hostRegistered: true, extensionConnected: true, geminiTabFound: true, loginState: 'unknown', message: 'ok' },
    async getStatus() { return a.status; },
    async submitPrompt(job) { a.submits.push(job); return opts.submitResult ? opts.submitResult(job) : { success: true, sendState: 'sent', jobId: job.jobId, tab: { id: 7, title: 'Gemini' } }; },
    async requestResult() { return { ok: true, message: 'requested' }; }
  };
  return a;
}
async function setup(stage, opts = {}) {
  const store = makeStore(stage);
  const queue = new GeminiJobQueue(join(dir, `q${++n}.json`));
  await queue.load();
  const adapter = makeAdapter(opts);
  const svc = createAnalysisService({ queue, adapter, readProject: store.readProject, saveProject: store.saveProject });
  return { store, queue, adapter, svc };
}
function resp(job, codeBlocks, text = '요청하신 결과입니다.') {
  return { protocolVersion: 1, type: 'RESPONSE_RECEIVED', requestId: job.requestId, jobId: job.jobId, projectId: job.projectId, timestamp: new Date().toISOString(), payload: { jobId: job.jobId, text, codeBlocks, complete: true } };
}
let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}
const STAGES = ['storyboard', 'prompt', 'editplan'];
const OTHER = { storyboard: 'prompt', prompt: 'editplan', editplan: 'storyboard' };

for (const stage of STAGES) {
  const name = STAGE_META[stage].name;
  await test(`${name}: 시작 → 전송(kind·stage 포함) → 응답 검증 → 작품 저장 → 완료`, async () => {
    const { svc, adapter, queue, store } = await setup(stage);
    const r = await svc.start(ID_A, stage);
    assert.equal(r.ok, true, r.message);
    await svc.kick();
    assert.equal(adapter.submits.length, 1);
    const sent = adapter.submits[0];
    assert.equal(sent.stage, stage);
    assert.ok(sent.jobId && sent.requestId && sent.projectId === ID_A);
    const job = queue.get(r.job.jobId);
    assert.equal(job.kind, stage);
    assert.equal(await svc.handleMessage(resp(job, [J[stage]])), 'applied');
    const done = queue.get(job.jobId);
    assert.equal(done.outcome, 'applied', done.errorMessage);
    assert.equal(done.phase, 'done');
    const saved = store.data.get(ID_A);
    assert.equal(saved.ai[stage].status, 'approved');
    if (stage === 'storyboard') assert.equal(saved.scenes.length, 3);
    if (stage === 'prompt') assert.ok(saved.scenes.every(s => s.imagePrompt));
    if (stage === 'editplan') assert.equal(saved.assembly.clips.length, 3);
    assert.deepEqual(store.saves, [ID_A]);
    // 같은 응답 재도착 → 무시, 저장 한 번
    assert.equal(await svc.handleMessage(resp(job, [J[stage]])), 'ignored');
    assert.equal(store.saves.length, 1);
  });

  await test(`${name}: 다른 단계의 JSON이 오면 적용하지 않음(INVALID_JSON) + 작품 변경 없음`, async () => {
    const { svc, queue, store } = await setup(stage);
    const before = JSON.stringify(store.data.get(ID_A));
    const r = await svc.start(ID_A, stage); await svc.kick();
    const job = queue.get(r.job.jobId);
    await svc.handleMessage(resp(job, [J[OTHER[stage]]]));
    const after = queue.get(job.jobId);
    assert.equal(after.outcome, 'invalid');
    assert.equal(after.errorCode, 'INVALID_JSON');
    assert.equal(JSON.stringify(store.data.get(ID_A)), before);
    assert.equal(store.saves.length, 0);
  });

  await test(`${name}: 다른 단계 화면에서 「이 결과 적용」 → WRONG_KIND 거부`, async () => {
    const { svc, queue, store } = await setup(stage);
    const r = await svc.start(ID_A, stage); await svc.kick();
    const job = queue.get(r.job.jobId);
    // 응답 도착 전에 앞 단계 데이터가 바뀌어 보류되도록 작품 수정
    const p = store.data.get(ID_A);
    store.data.set(ID_A, { ...p, brief: { ...p.brief, title: p.brief.title + ' (수정)' }, revision: p.revision + 1 });
    await svc.handleMessage(resp(job, [J[stage]]));
    assert.equal(queue.get(job.jobId).outcome, 'stale');
    const wrong = await svc.applyResult(job.jobId, OTHER[stage]);
    assert.equal(wrong.outcome, 'stale');
    assert.equal(wrong.errorCode, 'WRONG_KIND');
    assert.equal(store.saves.length, 0);
  });

  await test(`${name}: 다른 작품 보호 — A의 응답은 A에만, B는 변경 없음 / B ID로 온 응답은 무시`, async () => {
    const { svc, queue, store } = await setup(stage);
    const bBefore = JSON.stringify(store.data.get(ID_B));
    const r = await svc.start(ID_A, stage); await svc.kick();
    const job = queue.get(r.job.jobId);
    assert.equal(await svc.handleMessage({ ...resp(job, [J[stage]]), projectId: ID_B }), 'ignored');
    assert.equal(queue.get(job.jobId).state, 'waiting');
    await svc.handleMessage(resp(job, [J[stage]]));
    assert.equal(queue.get(job.jobId).outcome, 'applied');
    assert.equal(JSON.stringify(store.data.get(ID_B)), bBefore);
    // 공유 판정 함수도 다른 작품에는 force여도 적용 거부
    const d = decideStageApply(queue.get(job.jobId), store.data.get(ID_B), { force: true, expectedStage: stage });
    assert.equal(d.action, 'reject'); assert.equal(d.code, 'OTHER_PROJECT');
  });

  await test(`${name}: 요청 후 앞 단계 데이터가 바뀌면 보류(UPSTREAM_CHANGED) → 「이 결과 적용」으로만 적용`, async () => {
    const { svc, queue, store } = await setup(stage);
    const r = await svc.start(ID_A, stage); await svc.kick();
    const job = queue.get(r.job.jobId);
    const p = store.data.get(ID_A);
    let changed;
    if (stage === 'storyboard') changed = { ...p, selection: { ...p.selection, styleId: p.analysis.styles[1].id } };
    else if (stage === 'prompt') changed = { ...p, scenes: p.scenes.map((s, i) => i === 0 ? { ...s, visual: s.visual + ' (사용자 수정)' } : s) };
    else changed = { ...p, scenes: p.scenes.map((s, i) => i === 0 ? { ...s, durationSec: s.durationSec + 3 } : s) }; // 편집 구성은 길이·미디어·낭독 기준
    store.data.set(ID_A, { ...changed, revision: p.revision + 1 });
    await svc.handleMessage(resp(job, [J[stage]]));
    const held = queue.get(job.jobId);
    assert.equal(held.outcome, 'stale');
    assert.equal(held.errorCode, 'UPSTREAM_CHANGED');
    assert.equal(held.phase, 'needs_user');
    assert.equal(store.saves.length, 0);
    const applied = await svc.applyResult(job.jobId, stage);
    assert.equal(applied.outcome, 'applied', applied.errorMessage);
    assert.equal(store.saves.length, 1);
  });

  await test(`${name}: 이 요청 이후 같은 단계 결과가 이미 적용됐으면 덮어쓰지 않음(NEWER_RESULT)`, async () => {
    const { svc, queue, store } = await setup(stage);
    const r = await svc.start(ID_A, stage); await svc.kick();
    const job = queue.get(r.job.jobId);
    const p = store.data.get(ID_A);
    store.data.set(ID_A, { ...p, ai: { ...p.ai, [stage]: { raw: 'manual', status: 'approved', updatedAt: new Date(Date.parse(job.createdAt) + 5000).toISOString() } } });
    await svc.handleMessage(resp(job, [J[stage]]));
    assert.equal(queue.get(job.jobId).errorCode, 'NEWER_RESULT');
    assert.equal(store.saves.length, 0);
  });

  await test(`${name}: 전송 불명 → 사용자 확인 필요, 반복 kick에도 자동 재전송 없음`, async () => {
    const { svc, queue, adapter } = await setup(stage, { submitResult: job => ({ success: false, sendState: 'uncertain', jobId: job.jobId, errorCode: 'SEND_UNCERTAIN', message: '불명' }) });
    const r = await svc.start(ID_A, stage);
    await svc.kick(); await svc.kick(); await svc.kick();
    assert.equal(adapter.submits.length, 1);
    const j = queue.get(r.job.jobId);
    assert.equal(j.state, 'needs_confirmation');
    // 다시 시작 버튼을 눌러도 진행 중 작업을 돌려줄 뿐 새로 보내지 않음
    const again = await svc.start(ID_A, stage);
    assert.equal(again.reused, true);
    await svc.kick();
    assert.equal(adapter.submits.length, 1);
  });
}

await test('단계별 진행 중 작업은 독립: 장면 구성 진행 중에도 같은 작품 분석 작업과 섞이지 않음', async () => {
  const { svc, queue } = await setup('storyboard');
  const a = await svc.start(ID_A, 'storyboard');
  const b = await svc.start(ID_A, 'storyboard');
  assert.equal(b.reused, true); assert.equal(a.job.jobId, b.job.jobId);
  const c = await svc.start(ID_A, 'prompt');
  assert.equal(c.ok, false, '장면이 없으면 프롬프트 단계는 시작 불가');
  assert.equal(queue.list().filter(j => j.projectId === ID_A).length, 1);
});

await test('선행 조건: 화풍·연출 미선택이면 장면 구성 시작 안 함(전송 없음)', async () => {
  const { svc, adapter, store } = await setup('storyboard');
  const p = store.data.get(ID_A);
  store.data.set(ID_A, { ...p, selection: { styleId: '', directionId: '' } });
  const r = await svc.start(ID_A, 'storyboard');
  assert.equal(r.ok, false);
  assert.match(r.message, /화풍/);
  await svc.kick();
  assert.equal(adapter.submits.length, 0);
});

await test('긴 스토리보드 응답: 여러 코드 블록 중 creator.storyboard.v1 블록을 골라 적용', async () => {
  const { svc, queue, store } = await setup('storyboard');
  const r = await svc.start(ID_A, 'storyboard'); await svc.kick();
  const job = queue.get(r.job.jobId);
  const pretty = JSON.stringify(JSON.parse(J.storyboard), null, 2);
  const example = '{"schema":"creator.analysis.v1","note":"예시"}';
  const text = '장면 구성입니다.\n' + 'x'.repeat(30000) + '\n' + pretty + '\n참고:\n' + example;
  await svc.handleMessage(resp(job, [pretty, example], text));
  assert.equal(queue.get(job.jobId).outcome, 'applied', queue.get(job.jobId).errorMessage);
  assert.equal(store.data.get(ID_A).scenes.length, 3);
  const c = answerCandidates(text, [example, pretty], 'creator.storyboard.v1');
  assert.equal(c[0], pretty);
});

await test('기획 분석 판정 호환: decideAnalysisApply는 분석 작업만, 다른 단계 작업은 WRONG_KIND', () => {
  const p = projectUpTo(ID_A, '작품 A', 'storyboard');
  const d = decideAnalysisApply({ jobId: 'j', projectId: ID_A, kind: 'storyboard', prompt: '', createdAt: new Date().toISOString(), resultText: J.storyboard, codeBlocks: [] }, p);
  assert.equal(d.code, 'WRONG_KIND');
  const e = decideStageApply({ jobId: 'j', projectId: ID_A, kind: 'image', prompt: '', createdAt: new Date().toISOString(), resultText: '', codeBlocks: [] }, p);
  assert.equal(e.code, 'WRONG_KIND');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} gemini-stages checks finished`);
