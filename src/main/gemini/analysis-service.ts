/**
 * 「AI 기획 분석 시작」 오케스트레이션 (Electron main).
 * 기존 구성 재사용: GeminiJobQueue(Phase 4) + GeminiAdapter(Native Messaging) + storage(read/saveProject)
 * + makeAIPrompt + applyAIResponse(creator.analysis.v1 검사기).
 *
 * 의존성을 주입받으므로 Electron 없이 mock으로 테스트할 수 있습니다(scripts/test-gemini-automation.mjs).
 */
import type { GeminiAnalysisStartResult, GeminiJobRecord, StudioProject } from '../../shared/types';
import type { ProtocolMessage } from '../../shared/gemini-protocol';
import type { JobResult, ProviderStatus } from './adapter';
import { makeAIPrompt } from '../../shared/prompts';
import { stageComplete } from '../../shared/workflow';
import { decideAnalysisApply } from '../../shared/gemini-analysis';

/** GeminiJobQueue(job-queue.mjs) 중 이 서비스가 쓰는 부분 */
export interface QueueLike {
  list(): GeminiJobRecord[];
  get(jobId: string): GeminiJobRecord | undefined;
  findActive(projectId: string, kind: string): GeminiJobRecord | undefined;
  latest(projectId: string, kind?: string): GeminiJobRecord | undefined;
  enqueue(input: { projectId: string; kind: 'analysis'; prompt: string }): Promise<GeminiJobRecord>;
  tick(provider: { submit(job: GeminiJobRecord): Promise<JobResult> }): Promise<void>;
  onResponse(jobId: string, requestId: string, text: string, complete: boolean, extra?: { projectId?: string; codeBlocks?: string[]; isolation?: string }): Promise<'applied' | 'ignored'>;
  setPhase(jobId: string, requestId: string, phase: string, info?: Record<string, unknown>, projectId?: string): Promise<'applied' | 'ignored'>;
  onRemoteError(jobId: string, requestId: string, projectId: string | undefined, code: string, message: string, partialText?: string): Promise<'applied' | 'ignored'>;
  setOutcome(jobId: string, requestId: string, fields: Partial<GeminiJobRecord>): Promise<GeminiJobRecord | null>;
  continueWaiting(jobId: string): Promise<GeminiJobRecord | null>;
  markConnectionLost(): Promise<boolean>;
  expireStale(maxIdleMs: number, nowMs?: number): Promise<boolean>;
}
export interface AdapterLike {
  getStatus(): Promise<ProviderStatus>;
  submitPrompt(job: { jobId: string; requestId: string; projectId: string; stage: string; prompt: string }): Promise<JobResult>;
  requestResult(job: { jobId: string; requestId: string; projectId: string }): Promise<{ ok: boolean; message: string }>;
}
export interface AnalysisServiceDeps {
  queue: QueueLike;
  adapter: AdapterLike;
  readProject(id: string): Promise<StudioProject>;
  saveProject(p: StudioProject): Promise<StudioProject>;
  /** 결과가 작품에 저장되었을 때 (renderer가 작품을 다시 읽도록) */
  onProjectUpdated?(project: StudioProject, job: GeminiJobRecord): void;
}

const RECEIVABLE_PHASES = new Set(['waiting', 'collecting']);

export function createAnalysisService(deps: AnalysisServiceDeps) {
  const { queue, adapter } = deps;
  let kicking: Promise<void> | null = null;

  const provider = {
    async submit(job: GeminiJobRecord): Promise<JobResult> {
      // 1) 연결 확인 — 실패는 "보내지 않음"이 확실하므로 failed(사용자가 명시적으로 재시도)
      const status = await adapter.getStatus();
      if (!status.connected) return { success: false, jobId: job.jobId, sendState: 'not_sent', needsUser: true, errorCode: 'HOST_NOT_CONNECTED', message: status.message };
      if (!status.extensionConnected) return { success: false, jobId: job.jobId, sendState: 'not_sent', needsUser: true, errorCode: 'EXTENSION_NOT_CONNECTED', message: status.message };
      if (!status.geminiTabFound) return { success: false, jobId: job.jobId, sendState: 'not_sent', needsUser: true, errorCode: 'NO_GEMINI_TAB', message: status.message };
      // 2) 프롬프트 전송 — requestId는 큐가 이번 시도에 부여한 값을 그대로 사용
      await queue.setPhase(job.jobId, job.requestId, 'sending');
      return adapter.submitPrompt({ jobId: job.jobId, requestId: job.requestId, projectId: job.projectId, stage: job.kind, prompt: job.prompt });
    }
  };

  /** 대기열 실행 (동시에 하나만). 이미 돌고 있으면 그 실행을 기다림 */
  function kick(): Promise<void> {
    if (kicking) return kicking;
    kicking = (async () => {
      try {
        // 한 번에 하나씩: 앞 작업이 '보내지 않음'으로 끝나면 다음 대기 작업을 이어서 실행
        for (let i = 0; i < 10; i++) {
          await queue.tick(provider);
          const jobs = queue.list();
          const busy = jobs.some(j => j.state === 'dispatching' || j.state === 'waiting' || j.state === 'cancelling');
          if (busy || !jobs.some(j => j.state === 'queued' && j.executable)) break;
        }
      } finally { kicking = null; }
    })();
    return kicking;
  }

  const starting = new Set<string>();
  async function start(projectId: string): Promise<GeminiAnalysisStartResult> {
    // 같은 작품에 대한 동시 시작(더블클릭 등)은 하나만 통과
    if (starting.has(projectId)) {
      const active = queue.findActive(projectId, 'analysis');
      return { ok: true, job: active, reused: true, message: '이미 시작 중입니다.' };
    }
    starting.add(projectId);
    try { return await startLocked(projectId); } finally { starting.delete(projectId); }
  }
  async function startLocked(projectId: string): Promise<GeminiAnalysisStartResult> {
    let project: StudioProject;
    try { project = await deps.readProject(projectId); } catch (e) { return { ok: false, message: '작품을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)) }; }
    if (!stageComplete(project, 'brief')) return { ok: false, message: '작품 제목과 낭독 원문을 먼저 입력해 주세요.' };
    const existing = queue.findActive(projectId, 'analysis');
    if (existing) return { ok: true, job: existing, reused: true, message: '이미 진행 중인 기획 분석이 있어 새로 보내지 않았습니다.' };
    const job = await queue.enqueue({ projectId, kind: 'analysis', prompt: makeAIPrompt(project, 'analysis') });
    void kick();
    return { ok: true, job };
  }

  /** 완료된 응답 검증·적용. force=사용자가 '이 결과 적용'으로 확인(다른 작품에는 여전히 적용 불가) */
  async function applyCompleted(jobId: string, force = false): Promise<GeminiJobRecord | null> {
    const job = queue.get(jobId);
    if (!job || job.state !== 'completed' || job.kind !== 'analysis') return null;
    if (job.outcome === 'applied') return job;
    await queue.setOutcome(job.jobId, job.requestId, { phase: 'validating' });
    let project: StudioProject;
    try { project = await deps.readProject(job.projectId); }
    catch { return queue.setOutcome(job.jobId, job.requestId, { outcome: 'stale', phase: 'needs_user', needsUser: true, errorCode: 'PROJECT_NOT_FOUND', errorMessage: '요청한 작품을 찾을 수 없습니다.' }); }
    const d = decideAnalysisApply(job, project, { force });
    if (d.action === 'reject') {
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: d.outcome, phase: d.outcome === 'stale' ? 'needs_user' : 'error', needsUser: d.outcome === 'stale',
        errorCode: d.code, errorMessage: d.message, validationError: d.outcome === 'invalid' ? d.message : undefined
      });
    }
    let saved: StudioProject;
    try { saved = await deps.saveProject(d.project); }
    catch (e) {
      return queue.setOutcome(job.jobId, job.requestId, { phase: 'error', needsUser: false, errorCode: 'SAVE_FAILED', errorMessage: e instanceof Error ? e.message : String(e) });
    }
    const done = await queue.setOutcome(job.jobId, job.requestId, {
      outcome: 'applied', phase: 'done', needsUser: false, errorCode: undefined, errorMessage: undefined, validationError: undefined,
      appliedAt: new Date().toISOString(), appliedRevision: saved.revision
    });
    if (done) deps.onProjectUpdated?.(saved, done);
    return done;
  }

  /** Native Host에서 온 메시지 처리. jobId·requestId·projectId가 모두 맞는 것만 큐가 받아들임 */
  async function handleMessage(msg: ProtocolMessage): Promise<'applied' | 'ignored'> {
    const payload = (msg.payload || {}) as Record<string, unknown>;
    const jobId = (msg.jobId || payload.jobId) as string | undefined;
    if (!jobId || typeof msg.projectId !== 'string') return 'ignored'; // projectId 없는 응답은 받지 않음
    if (msg.type === 'RESPONSE_RECEIVED') {
      const complete = !!payload.complete;
      const r = await queue.onResponse(jobId, msg.requestId, String(payload.text ?? ''), complete, {
        projectId: msg.projectId, codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks.map(String) : [], isolation: payload.isolation as string | undefined
      });
      if (r === 'applied' && complete) {
        const job = queue.get(jobId);
        if (job?.kind === 'analysis') await applyCompleted(jobId);
        else if (job) await queue.setOutcome(job.jobId, job.requestId, { outcome: 'received', phase: 'done' });
        void kick();
      }
      return r;
    }
    if (msg.type === 'JOB_PROGRESS') {
      const stage = String(payload.stage || '');
      if (!RECEIVABLE_PHASES.has(stage)) return 'ignored';
      return queue.setPhase(jobId, msg.requestId, stage, (payload.info || {}) as Record<string, unknown>, msg.projectId);
    }
    if (msg.type === 'ERROR') {
      const r = await queue.onRemoteError(jobId, msg.requestId, msg.projectId, String(payload.code || 'REMOTE_ERROR'), String(payload.message || ''), payload.partialText ? String(payload.partialText) : undefined);
      if (r === 'applied') void kick();
      return r;
    }
    if (msg.type === 'PROMPT_SUBMIT_RESULT') {
      // 시간 초과 후 늦게 도착한 전송 결과: '전송됨'이면 재전송 없이 응답 대기로 전환
      const job = queue.get(jobId);
      if (job && job.requestId === msg.requestId && job.projectId === msg.projectId && job.state === 'needs_confirmation' && !job.sendConfirmed
        && payload.sendState === 'sent') {
        await queue.setOutcome(job.jobId, job.requestId, { sendConfirmed: true, sentAt: new Date().toISOString() });
        await queue.continueWaiting(jobId);
        return 'applied';
      }
      return 'ignored';
    }
    return 'ignored';
  }

  /** 확장 프로그램에 보관된 응답 다시 받기 (Gemini 재전송 아님) */
  async function fetchResult(jobId: string): Promise<{ success: boolean; message: string }> {
    const job = queue.get(jobId);
    if (!job) return { success: false, message: '작업을 찾을 수 없습니다.' };
    if (job.state === 'completed') {
      if (job.kind === 'analysis' && job.outcome !== 'applied') await applyCompleted(jobId);
      return { success: true, message: '이미 응답을 받았습니다.' };
    }
    if (job.state !== 'needs_confirmation' && job.state !== 'waiting') return { success: false, message: '응답을 다시 받을 수 있는 상태가 아닙니다.' };
    const r = await adapter.requestResult({ jobId: job.jobId, requestId: job.requestId, projectId: job.projectId });
    return { success: r.ok, message: r.message };
  }

  /** 연결이 다시 붙었을 때: 응답 대기 중 끊겼던 작업은 보관된 응답을 조회만 함 */
  async function onReconnect(): Promise<void> {
    for (const job of queue.list()) {
      if (job.state === 'needs_confirmation' && job.sendConfirmed && (job.errorCode === 'CONNECTION_LOST_WAITING' || job.errorCode === 'APP_RESTARTED_WAITING')) {
        try { await adapter.requestResult({ jobId: job.jobId, requestId: job.requestId, projectId: job.projectId }); } catch { /* ignore */ }
      }
    }
    void kick();
  }

  return { start, kick, applyCompleted, applyResult: (jobId: string) => { const j = queue.get(jobId); return applyCompleted(jobId, j?.outcome === 'stale'); }, handleMessage, fetchResult, onReconnect, provider };
}
export type AnalysisService = ReturnType<typeof createAnalysisService>;
