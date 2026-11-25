/**
 * Gemini job queue — plain JS runtime (tested directly).
 * Typed wrapper: job-queue.ts
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 아직 미구현된 생성 작업 종류 (Phase 5 반자동: image·video·music 모두 활성화) */
const NON_EXECUTABLE = new Set([]);
const SCENE_REQUIRED_KINDS = new Set(['image', 'video']);
/** 같은 작품·같은 단계에서 새 요청을 막는 '진행 중' 상태 */
const ACTIVE_STATES = new Set(['queued', 'dispatching', 'waiting', 'needs_confirmation', 'cancelling']);
/** 전송 여부 불명 오류 코드 (사용자가 Gemini 화면에서 전송을 확인하면 재전송 없이 대기로 전환 가능) */
const UNCERTAIN_CODES = new Set(['SEND_UNCERTAIN', 'TIMEOUT', 'NO_RESPONSE', 'CONNECTION_LOST', 'APP_RESTARTED_UNCERTAIN', 'MISMATCHED_RESULT', 'SUBMIT_EXCEPTION', 'ERROR']);
/** 응답(또는 진행 알림)을 받아도 되는 상태 */
const RECEIVING_STATES = new Set(['dispatching', 'waiting', 'needs_confirmation']);
const PROGRESS_PHASES = new Set(['queued', 'checking', 'sending', 'waiting', 'collecting', 'validating']);
/** 멈추기 직전 단계를 기록 (UI에서 어느 단계에서 멈췄는지 표시) */
function markStopped(job) { if (PROGRESS_PHASES.has(job.phase)) job.stoppedPhase = job.phase; }
/**
 * UI 표시 단계(phase)
 *  queued 대기 · checking 연결 확인 · sending 프롬프트 전송 중 · waiting Gemini 응답 대기 · collecting 응답 수집 중
 *  validating JSON 검증 중 · done 분석 완료 · needs_user 사용자 확인 필요 · error 오류 · cancelled 취소됨
 */

export class GeminiJobQueue {
  constructor(storePath) {
    this.storePath = storePath;
    this.jobs = [];
    this.writing = Promise.resolve();
    this.processing = false;
    this.listeners = [];
  }

  /** 상태가 저장될 때마다 호출 (Electron main → renderer 알림용) */
  subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }

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
        markStopped(job);
        job.state = 'needs_confirmation';
        job.phase = 'needs_user';
        job.needsUser = true;
        job.errorCode = job.sendConfirmed ? 'APP_RESTARTED_WAITING' : 'APP_RESTARTED_UNCERTAIN';
        job.errorMessage = job.sendConfirmed
          ? '이미 전송된 요청입니다. 응답을 기다리거나 확인 후 진행하세요. 자동 재전송하지 않습니다.'
          : '전송 여부가 불분명합니다. 사용자 확인 없이 재전송하지 않습니다.';
        job.updatedAt = now;
      } else if (job.state === 'cancelling') {
        if (job.externalCancelConfirmed) {
          job.state = 'cancelled';
        } else {
          job.state = 'needs_confirmation';
          job.phase = 'needs_user';
          job.errorMessage = '외부 생성 취소가 확인되지 않았습니다. 취소 완료로 표시하지 않습니다.';
        }
        job.updatedAt = now;
      }
    }
  }

  list() { return this.jobs.map(j => ({ ...j })); }
  get(jobId) { const j = this.jobs.find(x => x.jobId === jobId); return j ? { ...j } : undefined; }

  /** 같은 작품·같은 종류(이미지는 같은 sceneId까지)의 진행 중 작업 (중복 요청 방지) */
  findActive(projectId, kind, sceneId) {
    const j = this.jobs
      .filter(x => x.projectId === projectId && x.kind === kind && (sceneId === undefined || x.sceneId === sceneId) && ACTIVE_STATES.has(x.state))
      .pop();
    return j ? { ...j } : undefined;
  }

  /** 같은 작품·같은 종류(이미지는 sceneId 지정 가능)의 가장 최근 작업 */
  latest(projectId, kind, sceneId) {
    const list = this.jobs.filter(
      x => x.projectId === projectId && (!kind || x.kind === kind) && (sceneId === undefined || x.sceneId === sceneId)
    );
    const j = list[list.length - 1];
    return j ? { ...j } : undefined;
  }

  async enqueue(input) {
    const missingScene = SCENE_REQUIRED_KINDS.has(input.kind) && (!input.sceneId || !String(input.sceneId).trim());
    const executable = !NON_EXECUTABLE.has(input.kind) && !missingScene;
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
      errorCode: executable ? undefined : (missingScene ? 'SCENE_ID_REQUIRED' : 'NOT_IMPLEMENTED'),
      errorMessage: executable
        ? undefined
        : missingScene
        ? `${input.kind === 'video' ? '동영상' : '이미지'} 생성 작업에는 장면 ID(sceneId)가 필요합니다.`
        : '이 생성 기능은 아직 검증되지 않아 실행할 수 없습니다.',
      phase: executable ? 'queued' : 'error',
      needsUser: false,
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
      next.phase = 'checking';
      next.needsUser = false;
      next.dispatchedAt = new Date().toISOString();
      next.updatedAt = next.dispatchedAt;
      next.requestId = randomUUID();
      await this.persist();
      let result;
      try {
        result = await provider.submit(next);
      } catch (e) {
        markStopped(next);
        next.state = 'needs_confirmation';
        next.phase = 'needs_user';
        next.needsUser = true;
        next.errorCode = 'CONNECTION_LOST';
        next.errorMessage = e instanceof Error ? e.message : '연결이 끊겼습니다. 전송 여부 불명. 자동 재전송하지 않습니다.';
        next.updatedAt = new Date().toISOString();
        await this.persist();
        return;
      }
      if (result.tab) next.tab = result.tab;
      if (result.insertMethod) next.insertMethod = result.insertMethod;
      if (result.evidence) next.sendEvidence = result.evidence;
      next.diagnostics = result.diagnostics || undefined;
      if (next.state !== 'dispatching') {
        // 전송 결과를 기다리는 동안 응답/오류가 먼저 반영된 경우(드묾) 그 상태를 유지
      } else if (result.success) {
        next.sendConfirmed = true;
        next.sentAt = new Date().toISOString();
        next.state = 'waiting';
        next.phase = 'waiting';
        next.errorCode = undefined;
        next.errorMessage = undefined;
      } else if (result.uncertain || result.sendState === 'uncertain') {
        // 전송 여부 불명: 절대 자동 재전송하지 않고 사용자 확인 대기
        markStopped(next);
        next.state = 'needs_confirmation';
        next.phase = 'needs_user';
        next.needsUser = true;
        next.sendConfirmed = false;
        next.errorCode = result.errorCode || 'SEND_UNCERTAIN';
        next.errorMessage = result.message || '전송 여부가 불분명합니다. 자동으로 다시 보내지 않습니다.';
      } else {
        markStopped(next);
        next.state = 'failed';
        next.phase = result.needsUser ? 'needs_user' : 'error';
        next.needsUser = !!result.needsUser;
        next.errorCode = result.errorCode || 'SUBMIT_FAILED';
        next.errorMessage = result.message || '전송 실패';
      }
      next.updatedAt = new Date().toISOString();
      await this.persist();
    } finally {
      this.processing = false;
    }
  }

  /** 응답 수신. jobId·requestId(그리고 주어지면 projectId·sceneId)가 모두 맞아야 반영합니다. */
  async onResponse(jobId, requestId, text, complete, extra = {}) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job) return 'ignored';
    if (job.requestId !== requestId) return 'ignored';
    if (extra.projectId !== undefined && extra.projectId !== job.projectId) return 'ignored';
    if (job.sceneId && extra.sceneId !== undefined && extra.sceneId !== job.sceneId) return 'ignored';
    if (job.state === 'completed' || job.state === 'cancelled' || job.state === 'failed') return 'ignored';
    if (job.state !== 'waiting' && job.state !== 'needs_confirmation' && job.state !== 'dispatching') return 'ignored';
    if (complete) {
      job.state = 'completed';
      job.phase = 'validating';
      job.needsUser = false;
      job.resultText = text;
      job.codeBlocks = Array.isArray(extra.codeBlocks) ? extra.codeBlocks.map(String) : [];
      if (extra.isolation) job.isolation = extra.isolation;
      if (extra.imageDataUrl) job.imageDataUrl = String(extra.imageDataUrl);
      if (extra.imageUrl) job.imageUrl = String(extra.imageUrl);
      if (extra.mediaDataUrl) job.mediaDataUrl = String(extra.mediaDataUrl);
      if (extra.mediaUrl) job.mediaUrl = String(extra.mediaUrl);
      if (extra.downloadPath) job.downloadPath = String(extra.downloadPath);
      if (extra.mimeType) { job.imageMimeType = String(extra.mimeType); job.mediaMimeType = String(extra.mimeType); }
      if (job.sendConfirmed === false) job.sendConfirmed = true; // 응답이 왔다는 것은 전송되었다는 증거
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.errorCode = undefined;
      job.errorMessage = undefined;
    } else {
      job.state = 'waiting';
      job.phase = 'collecting';
      job.resultText = text;
      job.updatedAt = new Date().toISOString();
    }
    await this.persist();
    return 'applied';
  }

  /** content script 진행 알림 (sending/waiting/collecting). ID가 모두 맞을 때만 반영 */
  async setPhase(jobId, requestId, phase, info = {}, projectId) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job || job.requestId !== requestId) return 'ignored';
    if (projectId !== undefined && projectId !== job.projectId) return 'ignored';
    if (!RECEIVING_STATES.has(job.state)) return 'ignored';
    if (phase === 'sending' && job.state !== 'dispatching') return 'ignored';
    if ((phase === 'waiting' || phase === 'collecting') && job.state === 'needs_confirmation') {
      if (!job.sendConfirmed && !UNCERTAIN_CODES.has(job.errorCode)) return 'ignored';
      // 진행 알림이 왔다는 것은 Gemini가 실제로 답하고 있다는 뜻 → 대기 상태로 복귀
      job.state = 'waiting'; job.sendConfirmed = true; job.needsUser = false; job.errorCode = undefined; job.errorMessage = undefined;
    }
    job.phase = phase;
    if (info && typeof info.chars === 'number') job.progressChars = info.chars;
    job.updatedAt = new Date().toISOString();
    await this.persist();
    return 'applied';
  }

  /** 전송 후 content script가 보고한 오류(응답 시간 초과, 보안 확인 화면 등) → 사용자 확인 필요 */
  async onRemoteError(jobId, requestId, projectId, code, message, partialText) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job || job.requestId !== requestId) return 'ignored';
    if (projectId !== undefined && projectId !== job.projectId) return 'ignored';
    if (!RECEIVING_STATES.has(job.state)) return 'ignored';
    markStopped(job);
    job.state = 'needs_confirmation';
    job.phase = 'needs_user';
    job.needsUser = true;
    job.errorCode = code || 'REMOTE_ERROR';
    job.errorMessage = message || 'Gemini 화면에서 오류가 보고되었습니다.';
    if (partialText) job.resultText = partialText;
    job.updatedAt = new Date().toISOString();
    await this.persist();
    return 'applied';
  }

  /** Native Host 연결이 끊김: 대기 중 작업을 '사용자 확인 필요'로 (재연결 후 응답이 오면 계속 받음) */
  async markConnectionLost() {
    let changed = false;
    for (const job of this.jobs) {
      if (job.state === 'waiting') {
        markStopped(job);
        job.state = 'needs_confirmation'; job.phase = 'needs_user'; job.needsUser = true;
        job.errorCode = 'CONNECTION_LOST_WAITING';
        job.errorMessage = '응답을 기다리는 중 Chrome 확장 연결이 끊겼습니다. 다시 연결되면 응답을 받을 수 있습니다. 자동 재전송하지 않습니다.';
        job.updatedAt = new Date().toISOString(); changed = true;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  /** 오래 응답이 없는 대기 작업 → 사용자 확인 필요 */
  async expireStale(maxIdleMs, nowMs = Date.now()) {
    let changed = false;
    for (const job of this.jobs) {
      if ((job.state === 'waiting' || job.state === 'dispatching') && nowMs - Date.parse(job.updatedAt) > maxIdleMs) {
        const wasDispatching = job.state === 'dispatching';
        markStopped(job);
        job.state = 'needs_confirmation'; job.phase = 'needs_user'; job.needsUser = true;
        job.errorCode = wasDispatching ? 'SEND_UNCERTAIN' : 'RESPONSE_TIMEOUT';
        job.errorMessage = '오랫동안 Gemini 응답 소식이 없습니다. Gemini 화면을 확인해 주세요. 자동 재전송하지 않습니다.';
        job.updatedAt = new Date(nowMs).toISOString(); changed = true;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  /** 검증·적용 결과 기록 */
  async setOutcome(jobId, requestId, fields) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job || job.requestId !== requestId) return null;
    Object.assign(job, fields, { updatedAt: new Date().toISOString() });
    await this.persist();
    return { ...job };
  }

  async cancel(jobId, provider) {
    const job = this.jobs.find(j => j.jobId === jobId);
    if (!job) return null;
    if (job.state === 'completed' || job.state === 'cancelled') return { ...job };
    job.cancelRequested = true;
    if (job.state === 'queued' || job.state === 'failed' || job.state === 'needs_confirmation') {
      job.state = 'cancelled';
      job.phase = 'cancelled';
      job.needsUser = false;
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
      job.phase = 'cancelled';
    } else {
      job.state = 'needs_confirmation';
      job.phase = 'needs_user';
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
    job.phase = 'queued';
    job.needsUser = false;
    job.outcome = undefined;
    job.stoppedPhase = undefined;
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
    job.phase = 'queued';
    job.needsUser = false;
    job.outcome = undefined;
    job.stoppedPhase = undefined;
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
    if (!job || job.state !== 'needs_confirmation') return null;
    // 전송이 확인되었거나, 전송 불명이지만 사용자가 Gemini 화면에서 전송을 직접 확인한 경우에만
    if (!job.sendConfirmed && !UNCERTAIN_CODES.has(job.errorCode)) return null;
    job.sendConfirmed = true;
    job.state = 'waiting';
    job.phase = 'waiting';
    job.stoppedPhase = undefined;
    job.needsUser = false;
    job.errorCode = undefined;
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
      const tmp = this.storePath + '.tmp-' + randomUUID();
      await writeFile(tmp, body, 'utf8');
      try {
        await rename(tmp, this.storePath);
      } catch {
        await copyFile(tmp, this.storePath);
        await unlink(tmp).catch(() => {});
      }
    });
    await this.writing;
    for (const fn of this.listeners) { try { fn(); } catch { /* ignore */ } }
  }
}
