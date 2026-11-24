/**
 * Gemini job queue — plain JS runtime (tested directly).
 * Typed wrapper: job-queue.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const NON_EXECUTABLE = new Set(['image', 'video', 'music']);

export class GeminiJobQueue {
  constructor(storePath) {
    this.storePath = storePath;
    this.jobs = [];
    this.writing = Promise.resolve();
    this.processing = false;
  }

  async load() {
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const data = JSON.parse(raw);
      if (data?.schema === 'creator.gemini-jobs.v1' && Array.isArray(data.jobs)) {
        this.jobs = data.jobs;
      } else {
        this.jobs = [];
      }
    } catch {
      this.jobs = [];
    }
    this.recoverOnStartup();
    await this.persist();
  }

  recoverOnStartup() {
    const now = new Date().toISOString();
    for (const job of this.jobs) {
      if (job.state === 'dispatching' || job.state === 'waiting') {
        job.state = 'needs_confirmation';
        job.errorMessage = job.sendConfirmed
          ? '이미 전송된 요청입니다. 응답을 기다리거나 확인 후 진행하세요. 자동 재전송하지 않습니다.'
          : '전송 여부가 불분명합니다. 사용자 확인 없이 재전송하지 않습니다.';
        job.updatedAt = now;
      } else if (job.state === 'cancelling') {
        if (job.externalCancelConfirmed) {
          job.state = 'cancelled';
        } else {
          job.state = 'needs_confirmation';
          job.errorMessage = '외부 생성 취소가 확인되지 않았습니다. 취소 완료로 표시하지 않습니다.';
        }
        job.updatedAt = now;
      }
    }
  }

  list() { return this.jobs.map(j => ({ ...j })); }
  get(jobId) { const j = this.jobs.find(x => x.jobId === jobId); return j ? { ...j } : undefined; }

  async enqueue(input) {
    const executable = !NON_EXECUTABLE.has(input.kind);
    const now = new Date().toISOString();
    const job = {
      jobId: randomUUID(),
      requestId: randomUUID(),
      projectId: input.projectId,
      sceneId: input.sceneId,
      kind: input.kind,
      executable,
      prompt: input.prompt,
      state: executable ? 'queued' : 'failed',
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      externalCancelConfirmed: false,
      sendConfirmed: false,
      errorCode: executable ? undefined : 'NOT_IMPLEMENTED',
      errorMessage: executable ? undefined : '이 생성 기능은 아직 검증되지 않아 실행할 수 없습니다.',
    };
    this.jobs.push(job);
    await this.persist();
    return { ...job };
  }

  async tick(provider) {
    if (this.processing) return;
    if (this.jobs.some(j => j.state === 'dispatching' || j.state === 'waiting' || j.state === 'cancelling')) return;
    const next = this.jobs.find(j => j.state === 'queued' && j.executable);
    if (!next) return;
    this.processing = true;
    try {
      next.state = 'dispatching';
      next.dispatchedAt = new Date().toISOString();
      next.updatedAt = next.dispatchedAt;
      next.requestId = randomUUID();
      await this.persist();
      let result;
      try {
        result = await provider.submit(next);
      } catch (e) {
        next.state = 'needs_confirmation';
        next.errorCode = 'CONNECTION_LOST';
        next.errorMessage = e instanceof Error ? e.message : '연결이 끊겼습니다. 전송 여부 불명. 자동 재전송하지 않습니다.';
        next.updatedAt = new Date().toISOString();
        await this.persist();
        return;
      }
      if (result.success) {
        next.sendConfirmed = true;
        next.sentAt = new Date().toISOString();
        next.state = 'waiting';
        next.errorCode = undefined;
        next.errorMessage = undefined;
      } else {
        next.state = 'failed';
        next.errorCode = result.errorCode || 'SUBMIT_FAILED';
        next.errorMessage = result.message || '전송 실패';
      }
      next.updatedAt = new Date().toISOString();
      await this.persist();
    } finally {
      this.processing = false;
    }
  }

  async onResponse(jobId, requestId, text, complete) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job) return 'ignored';
    if (job.requestId !== requestId) return 'ignored';
    if (job.state === 'completed' || job.state === 'cancelled' || job.state === 'failed') return 'ignored';
    if (job.state !== 'waiting' && job.state !== 'needs_confirmation' && job.state !== 'dispatching') return 'ignored';
    if (complete) {
      job.state = 'completed';
      job.resultText = text;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.errorCode = undefined;
      job.errorMessage = undefined;
    } else {
      job.state = 'waiting';
      job.resultText = text;
      job.updatedAt = new Date().toISOString();
    }
    await this.persist();
    return 'applied';
  }

  async cancel(jobId, provider) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job) return null;
    if (job.state === 'completed' || job.state === 'cancelled') return { ...job };
    job.cancelRequested = true;
    if (job.state === 'queued' || job.state === 'failed' || job.state === 'needs_confirmation') {
      job.state = 'cancelled';
      job.updatedAt = new Date().toISOString();
      await this.persist();
      return { ...job };
    }
    job.state = 'cancelling';
    job.updatedAt = new Date().toISOString();
    await this.persist();
    let confirmed = false;
    if (provider?.cancelExternal) {
      try { confirmed = await provider.cancelExternal(job.jobId); } catch { confirmed = false; }
    }
    job.externalCancelConfirmed = confirmed;
    if (confirmed) {
      job.state = 'cancelled';
    } else {
      job.state = 'needs_confirmation';
      job.errorMessage = '로컬 큐는 중단 요청되었습니다. Gemini 측 생성 취소는 확인되지 않았습니다.';
    }
    job.updatedAt = new Date().toISOString();
    await this.persist();
    return { ...job };
  }

  async retry(jobId) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job || job.state !== 'failed' || !job.executable) return null;
    job.state = 'queued';
    job.requestId = randomUUID();
    job.sendConfirmed = false;
    job.sentAt = undefined;
    job.dispatchedAt = undefined;
    job.errorCode = undefined;
    job.errorMessage = undefined;
    job.cancelRequested = false;
    job.externalCancelConfirmed = false;
    job.updatedAt = new Date().toISOString();
    await this.persist();
    return { ...job };
  }

  async confirmResend(jobId) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job || job.state !== 'needs_confirmation' || !job.executable) return null;
    job.state = 'queued';
    job.requestId = randomUUID();
    job.sendConfirmed = false;
    job.sentAt = undefined;
    job.dispatchedAt = undefined;
    job.errorCode = undefined;
    job.errorMessage = undefined;
    job.updatedAt = new Date().toISOString();
    await this.persist();
    return { ...job };
  }

  async continueWaiting(jobId) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job || job.state !== 'needs_confirmation' || !job.sendConfirmed) return null;
    job.state = 'waiting';
    job.errorMessage = undefined;
    job.updatedAt = new Date().toISOString();
    await this.persist();
    return { ...job };
  }

  async persist() {
    const snapshot = { schema: 'creator.gemini-jobs.v1', jobs: this.jobs.map(j => ({ ...j })) };
    const body = JSON.stringify(snapshot, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.storePath), { recursive: true });
      const tmp = this.storePath + '.tmp';
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.storePath);
    });
    await this.writing;
  }
}
