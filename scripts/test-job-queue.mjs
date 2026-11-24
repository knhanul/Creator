/**
 * Gemini job queue tests (plain JS module, Mock Provider).
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GeminiJobQueue } from '../src/main/gemini/job-queue.mjs';

const dir = mkdtempSync(join(tmpdir(), 'gomo-jobs-'));

function mockProvider(opts = {}) {
  const submits = [];
  const provider = {
    submits,
    async submit(job) {
      submits.push(job.jobId);
      opts.onSubmit?.(job);
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      if (opts.throwOnSubmit) throw new Error('connection dropped');
      return { success: opts.succeed !== false, errorCode: opts.succeed === false ? 'FAIL' : undefined, message: opts.succeed === false ? 'nope' : 'ok' };
    },
    async cancelExternal() { return !!opts.cancelOk; },
  };
  return provider;
}

let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

await test('큐 등록 및 영구 저장', async () => {
  const store = join(dir, 'a.json');
  const q = new GeminiJobQueue(store);
  await q.load();
  const a = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'hello' });
  assert.equal(a.state, 'queued');
  assert.ok(a.jobId);
  const raw = JSON.parse(readFileSync(store, 'utf8'));
  assert.equal(raw.schema, 'creator.gemini-jobs.v1');
  assert.equal(raw.jobs.length, 1);
});

await test('미구현 생성 기능은 실행 불가로 실패 처리', async () => {
  const q = new GeminiJobQueue(join(dir, 'b.json'));
  await q.load();
  const img = await q.enqueue({ projectId: 'p1', kind: 'image', prompt: 'img', sceneId: 's1' });
  assert.equal(img.executable, false);
  assert.equal(img.state, 'failed');
  assert.equal(img.errorCode, 'NOT_IMPLEMENTED');
});

await test('동시에 하나의 작업만 dispatch', async () => {
  const q = new GeminiJobQueue(join(dir, 'c.json'));
  await q.load();
  await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'a' });
  await q.enqueue({ projectId: 'p1', kind: 'storyboard', prompt: 'b' });
  let release;
  const gate = new Promise(r => { release = r; });
  const provider = mockProvider({});
  let held = false;
  provider.submit = async (job) => {
    provider.submits.push(job.jobId);
    if (!held) { held = true; await gate; }
    return { success: true };
  };
  const t1 = q.tick(provider);
  await new Promise(r => setTimeout(r, 30));
  const t2 = q.tick(provider);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(provider.submits.length, 1);
  release();
  await t1; await t2;
  const active = q.list().filter(j => j.state === 'waiting' || j.state === 'dispatching');
  assert.ok(active.length <= 1);
});

await test('전송 중 연결 끊김 → needs_confirmation, 자동 재전송 없음', async () => {
  const q = new GeminiJobQueue(join(dir, 'd.json'));
  await q.load();
  const job = await q.enqueue({ projectId: 'p1', kind: 'prompt', prompt: 'p' });
  const provider = mockProvider({ throwOnSubmit: true });
  await q.tick(provider);
  assert.equal(q.get(job.jobId).state, 'needs_confirmation');
  await q.tick(provider);
  assert.equal(provider.submits.length, 1);
});

await test('재시작 복구: dispatching → needs_confirmation', async () => {
  const store = join(dir, 'e.json');
  const q = new GeminiJobQueue(store);
  await q.load();
  const job = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'x' });
  const raw = JSON.parse(readFileSync(store, 'utf8'));
  raw.jobs[0].state = 'dispatching';
  raw.jobs[0].dispatchedAt = new Date().toISOString();
  writeFileSync(store, JSON.stringify(raw));
  const q2 = new GeminiJobQueue(store);
  await q2.load();
  const restored = q2.get(job.jobId);
  assert.equal(restored.state, 'needs_confirmation');
  assert.equal(restored.sendConfirmed, false);
});

await test('재시작 후에도 완료 결과 보존', async () => {
  const store = join(dir, 'f.json');
  const q = new GeminiJobQueue(store);
  await q.load();
  const job = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'done' });
  await q.tick(mockProvider({ succeed: true }));
  await q.onResponse(job.jobId, q.get(job.jobId).requestId, '{"schema":"ok"}', true);
  assert.equal(q.get(job.jobId).state, 'completed');
  const q2 = new GeminiJobQueue(store);
  await q2.load();
  const kept = q2.get(job.jobId);
  assert.equal(kept.state, 'completed');
  assert.equal(kept.resultText, '{"schema":"ok"}');
});

await test('중복 응답 무시', async () => {
  const q = new GeminiJobQueue(join(dir, 'g.json'));
  await q.load();
  const job = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'd' });
  await q.tick(mockProvider({ succeed: true }));
  const rid = q.get(job.jobId).requestId;
  await q.onResponse(job.jobId, rid, 'first', true);
  assert.equal(await q.onResponse(job.jobId, rid, 'second', true), 'ignored');
  assert.equal(q.get(job.jobId).resultText, 'first');
});

await test('잘못된 requestId 응답 무시', async () => {
  const q = new GeminiJobQueue(join(dir, 'h.json'));
  await q.load();
  const job = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'd' });
  await q.tick(mockProvider({ succeed: true }));
  assert.equal(await q.onResponse(job.jobId, 'not-the-id', 'nope', true), 'ignored');
  assert.equal(q.get(job.jobId).state, 'waiting');
});

await test('실패 작업만 재시도, 완료 작업은 재시도 불가', async () => {
  const q = new GeminiJobQueue(join(dir, 'i.json'));
  await q.load();
  const failed = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'f' });
  await q.tick(mockProvider({ succeed: false }));
  assert.equal(q.get(failed.jobId).state, 'failed');
  assert.equal((await q.retry(failed.jobId)).state, 'queued');
  const done = await q.enqueue({ projectId: 'p1', kind: 'storyboard', prompt: 's' });
  await q.tick(mockProvider({ succeed: true }));
  await q.onResponse(done.jobId, q.get(done.jobId).requestId, 'ok', true);
  assert.equal(await q.retry(done.jobId), null);
});

await test('전송 확인된 취소는 외부 확인 없이 취소 완료로 표시하지 않음', async () => {
  const q = new GeminiJobQueue(join(dir, 'j.json'));
  await q.load();
  const job = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'c' });
  await q.tick(mockProvider({ succeed: true }));
  const after = await q.cancel(job.jobId, mockProvider({ cancelOk: false }));
  assert.notEqual(after.state, 'cancelled');
  assert.equal(after.externalCancelConfirmed, false);
  assert.equal(after.state, 'needs_confirmation');
});

await test('외부 취소 확인 시에만 cancelled', async () => {
  const q = new GeminiJobQueue(join(dir, 'k.json'));
  await q.load();
  const job = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'c' });
  await q.tick(mockProvider({ succeed: true }));
  const after = await q.cancel(job.jobId, mockProvider({ cancelOk: true }));
  assert.equal(after.state, 'cancelled');
  assert.equal(after.externalCancelConfirmed, true);
});

await test('needs_confirmation은 사용자 확인 전까지 재전송 안 함', async () => {
  const q = new GeminiJobQueue(join(dir, 'l.json'));
  await q.load();
  const job = await q.enqueue({ projectId: 'p1', kind: 'analysis', prompt: 'n' });
  const provider = mockProvider({ throwOnSubmit: true });
  await q.tick(provider);
  await q.tick(provider);
  await q.tick(provider);
  assert.equal(provider.submits.length, 1);
  assert.equal((await q.confirmResend(job.jobId)).state, 'queued');
});

console.log(`\n${checks} job-queue checks finished`);
rmSync(dir, { recursive: true, force: true });
if (process.exitCode) process.exit(process.exitCode);
