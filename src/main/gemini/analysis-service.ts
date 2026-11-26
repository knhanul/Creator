/**
 * AI 단계 자동화 오케스트레이션 (Electron main): 기획 분석(실제 Gemini 검증됨) + 스토리보드·생성 프롬프트·최종 편집 구성.
 * 모든 단계가 같은 작업 큐·같은 전송 경로·같은 ID 대조·같은 자동 재전송 금지를 씁니다. 단계는 작업의 kind로 구분.
 * 기존 구성 재사용: GeminiJobQueue(Phase 4) + GeminiAdapter(Native Messaging) + storage(read/saveProject)
 * + makeAIPrompt + applyAIResponse(creator.analysis.v1 검사기).
 *
 * 의존성을 주입받으므로 Electron 없이 mock으로 테스트할 수 있습니다(scripts/test-gemini-automation.mjs).
 */
import type { AIStage, AssetKind, GeminiAnalysisStartResult, GeminiJobKind, GeminiJobRecord, MediaAsset, ReferenceImagePayload, StudioProject } from '../../shared/types';
import type { ProtocolMessage } from '../../shared/gemini-protocol';
import type { JobResult, ProviderStatus } from './adapter';
import { makeAIPrompt } from '../../shared/prompts';
import {
  STAGE_META,
  decideStageApply,
  getProjectBgmPrompt,
  isAIStage,
  makeImageGenerationPrompt,
  makeMusicGenerationPrompt,
  makeVideoGenerationPrompt
} from '../../shared/gemini-analysis';
import { findSceneReferenceImage } from '../../shared/reference-image';
import { makeSourceLookupPrompt, normalizeSourceQuery, type SourceLookupQuery } from '../../shared/gemini-source';

/** GeminiJobQueue(job-queue.mjs) 중 이 서비스가 쓰는 부분 */
export interface QueueLike {
  list(): GeminiJobRecord[];
  get(jobId: string): GeminiJobRecord | undefined;
  findActive(projectId: string, kind: string, sceneId?: string): GeminiJobRecord | undefined;
  latest(projectId: string, kind?: string, sceneId?: string): GeminiJobRecord | undefined;
  enqueue(input: { projectId: string; kind: GeminiJobKind; prompt: string; sceneId?: string; referenceImage?: ReferenceImagePayload }): Promise<GeminiJobRecord>;
  tick(provider: { submit(job: GeminiJobRecord): Promise<JobResult> }): Promise<void>;
  onResponse(
    jobId: string,
    requestId: string,
    text: string,
    complete: boolean,
    extra?: {
      projectId?: string;
      sceneId?: string;
      codeBlocks?: string[];
      isolation?: string;
      imageDataUrl?: string;
      imageUrl?: string;
      mediaDataUrl?: string;
      mediaUrl?: string;
      downloadPath?: string;
      mimeType?: string;
    }
  ): Promise<'applied' | 'ignored'>;
  setPhase(jobId: string, requestId: string, phase: string, info?: Record<string, unknown>, projectId?: string): Promise<'applied' | 'ignored'>;
  onRemoteError(jobId: string, requestId: string, projectId: string | undefined, code: string, message: string, partialText?: string): Promise<'applied' | 'ignored'>;
  setOutcome(jobId: string, requestId: string, fields: Partial<GeminiJobRecord>): Promise<GeminiJobRecord | null>;
  continueWaiting(jobId: string): Promise<GeminiJobRecord | null>;
  markConnectionLost(): Promise<boolean>;
  expireStale(maxIdleMs: number, nowMs?: number): Promise<boolean>;
}
export interface AdapterLike {
  getStatus(): Promise<ProviderStatus>;
  submitPrompt(job: { jobId: string; requestId: string; projectId: string; sceneId?: string; stage: string; prompt: string; referenceImage?: ReferenceImagePayload }): Promise<JobResult>;
  requestResult(job: { jobId: string; requestId: string; projectId: string; sceneId?: string; stage?: string }): Promise<{ ok: boolean; message: string }>;
}
export interface AnalysisServiceDeps {
  queue: QueueLike;
  adapter: AdapterLike;
  readProject(id: string): Promise<StudioProject>;
  saveProject(p: StudioProject): Promise<StudioProject>;
  /** Phase 5: 생성된 이미지를 프로젝트 assets/image/에 파일로 저장하고 scene.assetId를 연결 */
  saveGeneratedImageAsset?(
    projectId: string,
    sceneId: string,
    input: { imageDataUrl?: string; downloadPath?: string; mimeType?: string }
  ): Promise<{ project: StudioProject; asset: MediaAsset }>;
  /** Phase 5 확장: 생성된 이미지·동영상·오디오를 assets/<kind>/에 저장 (audio는 장면 미연결) */
  saveGeneratedMediaAsset?(
    projectId: string,
    kind: AssetKind,
    input: { sceneId?: string; imageDataUrl?: string; mediaDataUrl?: string; downloadPath?: string; mimeType?: string }
  ): Promise<{ project: StudioProject; asset: MediaAsset }>;
  /** 결과가 작품에 저장되었을 때 (renderer가 작품을 다시 읽도록) */
  onProjectUpdated?(project: StudioProject, job: GeminiJobRecord): void;
  /** 프로젝트 자산 파일을 읽어 기준 이미지 첨부에 사용 */
  readAssetBuffer?(projectId: string, relativePath: string): Promise<Buffer>;
  /** Native Messaging 1MB 한도에 맞게 기준 이미지를 인코딩 */
  encodeReferenceImage?(input: { buffer: Buffer; mimeType?: string; name?: string }): Promise<ReferenceImagePayload>;
}

const RECEIVABLE_PHASES = new Set(['waiting', 'collecting']);

export function createAnalysisService(deps: AnalysisServiceDeps) {
  const { queue, adapter } = deps;
  let kicking: Promise<void> | null = null;

  const provider = {
    async submit(job: GeminiJobRecord): Promise<JobResult> {
      // 1) 연결 확인 — 실패는 "보내지 않음"이 확실하므로 failed(사용자가 명시적으로 재시도)
      const status = await adapter.getStatus();
      const diagnostics = status.diagnosticText;
      const stop = (errorCode: string, message: string): JobResult => ({ success: false, jobId: job.jobId, sendState: 'not_sent', needsUser: true, errorCode, message, diagnostics });
      if (!status.connected) return stop('HOST_NOT_CONNECTED', status.message);
      // 버전·응답 확인: Host·확장·Gemini 탭 중 하나라도 이전 버전이거나 응답이 없으면 보내지 않고 무엇을 할지 안내
      if (status.versionIssue) return stop(status.versionIssue.code, status.versionIssue.message);
      if (!status.extensionConnected) return stop('EXTENSION_NOT_CONNECTED', status.message);
      if (!status.geminiTabFound) return stop('NO_GEMINI_TAB', status.message);
      // 2) 프롬프트 전송 — requestId는 큐가 이번 시도에 부여한 값을 그대로 사용
      await queue.setPhase(job.jobId, job.requestId, 'sending');
      const r = await adapter.submitPrompt({
        jobId: job.jobId,
        requestId: job.requestId,
        projectId: job.projectId,
        ...(job.sceneId ? { sceneId: job.sceneId } : {}),
        stage: job.kind,
        prompt: job.prompt,
        ...(job.referenceImage ? { referenceImage: job.referenceImage } : {})
      });
      return diagnostics && !r.diagnostics ? { ...r, diagnostics } : r;
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
  /** 단계 시작. 같은 작품·같은 단계의 진행 중 작업이 있으면 새로 보내지 않고 그 작업을 돌려줌 */
  async function start(projectId: string, stage: AIStage = 'analysis'): Promise<GeminiAnalysisStartResult> {
    if (!isAIStage(stage)) return { ok: false, message: '자동화할 수 없는 단계입니다.' };
    const key = projectId + '\u0000' + stage;
    // 같은 작품·같은 단계에 대한 동시 시작(더블클릭 등)은 하나만 통과
    if (starting.has(key)) {
      const active = queue.findActive(projectId, stage);
      return { ok: true, job: active, reused: true, message: '이미 시작 중입니다.' };
    }
    starting.add(key);
    try { return await startLocked(projectId, stage); } finally { starting.delete(key); }
  }
  async function startLocked(projectId: string, stage: AIStage): Promise<GeminiAnalysisStartResult> {
    let project: StudioProject;
    try { project = await deps.readProject(projectId); } catch (e) { return { ok: false, message: '작품을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)) }; }
    const missing = STAGE_META[stage].prerequisite(project);
    if (missing) return { ok: false, message: missing };
    const existing = queue.findActive(projectId, stage);
    if (existing) return { ok: true, job: existing, reused: true, message: `이미 진행 중인 ${STAGE_META[stage].name} 작업이 있어 새로 보내지 않았습니다.` };
    const job = await queue.enqueue({ projectId, kind: stage, prompt: makeAIPrompt(project, stage) });
    void kick();
    return { ok: true, job };
  }

  /**
   * Phase 5 MVP: 장면 단위 이미지 생성 시작.
   * - 같은 작품·같은 장면의 진행 중 image 작업이 있으면 새로 보내지 않고 기존 작업을 반환
   * - sceneId 필수, scene.imagePrompt 필수
   */
  async function startImage(projectId: string, sceneId: string): Promise<GeminiAnalysisStartResult> {
    const cleanSceneId = String(sceneId || '').trim();
    if (!cleanSceneId) return { ok: false, message: '이미지를 생성할 장면 ID가 필요합니다.' };
    const key = `${projectId}\u0000image\u0000${cleanSceneId}`;
    if (starting.has(key)) {
      const active = queue.findActive(projectId, 'image', cleanSceneId);
      return { ok: true, job: active, reused: true, message: '이미 이미지 생성을 시작 중입니다.' };
    }
    starting.add(key);
    try {
      let project: StudioProject;
      try {
        project = await deps.readProject(projectId);
      } catch (e) {
        return { ok: false, message: '작품을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)) };
      }
      const scene = project.scenes.find(s => s.id === cleanSceneId);
      if (!scene) {
        return { ok: false, message: `장면(${cleanSceneId})을 찾을 수 없습니다.` };
      }
      if (!scene.imagePrompt || !scene.imagePrompt.trim()) {
        return { ok: false, message: `${scene.id} 장면의 이미지 생성 프롬프트가 비어 있습니다. 생성 프롬프트 단계에서 먼저 프롬프트를 준비해 주세요.` };
      }
      const existing = queue.findActive(projectId, 'image', cleanSceneId);
      if (existing) {
        return {
          ok: true,
          job: existing,
          reused: true,
          message: `이미 진행 중인 ${cleanSceneId} 장면 이미지 생성 작업이 있어 새로 보내지 않았습니다.`
        };
      }
      const prompt = makeImageGenerationPrompt(project, cleanSceneId);
      const job = await queue.enqueue({ projectId, kind: 'image', sceneId: cleanSceneId, prompt });
      void kick();
      return { ok: true, job };
    } finally {
      starting.delete(key);
    }
  }

  /** 완료된 이미지 생성 작업의 결과를 프로젝트 assets/image/에 저장하고 해당 장면에 연결 */
  async function applyCompletedImage(jobId: string): Promise<GeminiJobRecord | null> {
    const job = queue.get(jobId);
    if (!job || job.state !== 'completed' || job.kind !== 'image') return null;
    if (job.outcome === 'applied') return job;
    if (!job.sceneId) {
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: 'invalid',
        phase: 'error',
        needsUser: false,
        errorCode: 'SCENE_NOT_FOUND',
        errorMessage: '이미지 작업에 장면 ID(sceneId)가 없습니다.'
      });
    }
    await queue.setOutcome(job.jobId, job.requestId, { phase: 'validating' });

    if (!job.imageDataUrl && !job.downloadPath) {
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: 'invalid',
        phase: 'needs_user',
        needsUser: true,
        errorCode: 'IMAGE_DATA_MISSING',
        errorMessage: 'Gemini에서 이미지가 생성되었습니다. 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.'
      });
    }

    if (!deps.saveGeneratedImageAsset) {
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: 'invalid',
        phase: 'error',
        needsUser: false,
        errorCode: 'SAVE_FAILED',
        errorMessage: '이미지 파일 저장기가 구성되지 않았습니다.'
      });
    }

    let savedResult: { project: StudioProject; asset: MediaAsset };
    try {
      savedResult = await deps.saveGeneratedImageAsset(job.projectId, job.sceneId, {
        imageDataUrl: job.imageDataUrl,
        downloadPath: job.downloadPath,
        mimeType: job.imageMimeType
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isMissingScene = msg.includes('장면') && msg.includes('찾을 수 없습니다');
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: isMissingScene ? 'stale' : 'invalid',
        phase: isMissingScene ? 'needs_user' : 'error',
        needsUser: isMissingScene,
        errorCode: isMissingScene ? 'SCENE_NOT_FOUND' : 'SAVE_FAILED',
        errorMessage: msg
      });
    }

    const done = await queue.setOutcome(job.jobId, job.requestId, {
      outcome: 'applied',
      phase: 'done',
      needsUser: false,
      errorCode: undefined,
      errorMessage: undefined,
      validationError: undefined,
      assetId: savedResult.asset.id,
      resultRef: savedResult.asset.relativePath,
      appliedAt: new Date().toISOString(),
      appliedRevision: savedResult.project.revision
    });
    if (done) deps.onProjectUpdated?.(savedResult.project, done);
    return done;
  }

  /**
   * Phase 5 확장: 장면 단위 동영상 생성 시작 (반자동).
   * - 같은 작품·같은 장면의 진행 중 video 작업이 있으면 새로 보내지 않음
   * - sceneId 필수, scene.videoPrompt 필수
   */
  async function startVideo(projectId: string, sceneId: string, options?: { useReferenceImage?: boolean }): Promise<GeminiAnalysisStartResult> {
    const cleanSceneId = String(sceneId || '').trim();
    if (!cleanSceneId) return { ok: false, message: '동영상을 생성할 장면 ID가 필요합니다.' };
    const key = `${projectId}\u0000video\u0000${cleanSceneId}`;
    if (starting.has(key)) {
      const active = queue.findActive(projectId, 'video', cleanSceneId);
      return { ok: true, job: active, reused: true, message: '이미 동영상 생성을 시작 중입니다.' };
    }
    starting.add(key);
    try {
      let project: StudioProject;
      try {
        project = await deps.readProject(projectId);
      } catch (e) {
        return { ok: false, message: '작품을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)) };
      }
      const scene = project.scenes.find(s => s.id === cleanSceneId);
      if (!scene) return { ok: false, message: `장면(${cleanSceneId})을 찾을 수 없습니다.` };
      if (!scene.videoPrompt || !scene.videoPrompt.trim()) {
        return { ok: false, message: `${scene.id} 장면의 동영상 생성 프롬프트(videoPrompt)가 비어 있습니다. 생성 프롬프트 단계에서 먼저 입력해 주세요.` };
      }
      const existing = queue.findActive(projectId, 'video', cleanSceneId);
      if (existing) {
        return {
          ok: true,
          job: existing,
          reused: true,
          message: `이미 진행 중인 ${cleanSceneId} 장면 동영상 생성 작업이 있어 새로 보내지 않았습니다.`
        };
      }

      let referenceImage: ReferenceImagePayload | undefined;
      if (options?.useReferenceImage) {
        const refAsset = findSceneReferenceImage(project, cleanSceneId);
        if (!refAsset) {
          return { ok: false, message: '기준 이미지가 없습니다. 먼저 「기준 이미지 먼저 만들기」로 이미지를 만들거나 가져와 주세요.' };
        }
        if (!deps.readAssetBuffer || !deps.encodeReferenceImage) {
          return { ok: false, message: '기준 이미지를 읽어 첨부할 준비가 되어 있지 않습니다.' };
        }
        try {
          const buffer = await deps.readAssetBuffer(projectId, refAsset.relativePath);
          referenceImage = await deps.encodeReferenceImage({ buffer, mimeType: undefined, name: refAsset.name });
        } catch (e) {
          return { ok: false, message: '기준 이미지를 준비하지 못했습니다: ' + (e instanceof Error ? e.message : String(e)) };
        }
        if (scene.referenceImageAssetId !== refAsset.id) {
          try {
            project = await deps.saveProject({
              ...project,
              scenes: project.scenes.map(s => s.id === cleanSceneId ? { ...s, referenceImageAssetId: refAsset.id } : s)
            });
          } catch { /* 발견만 하고 저장에 실패해도 생성은 진행 */ }
        }
      }

      const prompt = makeVideoGenerationPrompt(project, cleanSceneId, { hasReferenceImage: !!referenceImage });
      const job = await queue.enqueue({ projectId, kind: 'video', sceneId: cleanSceneId, prompt, ...(referenceImage ? { referenceImage } : {}) });
      void kick();
      return { ok: true, job };
    } finally {
      starting.delete(key);
    }
  }

  /**
   * Phase 5 확장: 작품 단위 배경음악 생성 시작 (반자동).
   * - sceneId 없음, 작품의 bgmPrompt 필수
   * - 진행 중 music 작업이 있으면 새로 보내지 않음
   */
  async function startMusic(projectId: string): Promise<GeminiAnalysisStartResult> {
    const key = `${projectId}\u0000music`;
    if (starting.has(key)) {
      const active = queue.findActive(projectId, 'music');
      return { ok: true, job: active, reused: true, message: '이미 배경음악 생성을 시작 중입니다.' };
    }
    starting.add(key);
    try {
      let project: StudioProject;
      try {
        project = await deps.readProject(projectId);
      } catch (e) {
        return { ok: false, message: '작품을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)) };
      }
      const bgm = getProjectBgmPrompt(project);
      if (!bgm) {
        return { ok: false, message: '작품의 배경음악 프롬프트(bgmPrompt)가 비어 있습니다. 생성 프롬프트 단계에서 먼저 프롬프트를 생성해 주세요.' };
      }
      const existing = queue.findActive(projectId, 'music');
      if (existing) {
        return {
          ok: true,
          job: existing,
          reused: true,
          message: '이미 진행 중인 배경음악 생성 작업이 있어 새로 보내지 않았습니다.'
        };
      }
      const prompt = makeMusicGenerationPrompt(project);
      const job = await queue.enqueue({ projectId, kind: 'music', prompt });
      void kick();
      return { ok: true, job };
    } finally {
      starting.delete(key);
    }
  }

  /**
   * 작품 정보: 제목·저자로 Gemini에 원문 전문 요청.
   * 결과는 작품에 저장하지 않고(outcome='received') 화면의 원문 검토 카드에서 사용자가 확정합니다.
   */
  async function startSource(projectId: string, query: SourceLookupQuery): Promise<GeminiAnalysisStartResult> {
    const q = normalizeSourceQuery(query);
    if (!q.title) return { ok: false, message: '찾을 작품 제목을 입력해 주세요.' };
    const key = `${projectId}\u0000source`;
    if (starting.has(key)) return { ok: true, job: queue.findActive(projectId, 'source'), reused: true, message: '이미 원문 찾기를 시작 중입니다.' };
    starting.add(key);
    try {
      const prompt = makeSourceLookupPrompt(q);
      const existing = queue.findActive(projectId, 'source');
      if (existing) {
        return existing.prompt === prompt
          ? { ok: true, job: existing, reused: true, message: '같은 작품의 원문 찾기가 이미 진행 중입니다.' }
          : { ok: false, job: existing, message: '앞서 요청한 원문 찾기가 아직 진행 중입니다. 끝나거나 취소한 뒤 다시 찾아 주세요.' };
      }
      const job = await queue.enqueue({ projectId, kind: 'source', prompt });
      void kick();
      return { ok: true, job };
    } finally {
      starting.delete(key);
    }
  }

  /** 완료된 동영상(video)·배경음악(music) 생성 작업 결과를 프로젝트 assets/에 저장 */
  async function applyCompletedMedia(jobId: string): Promise<GeminiJobRecord | null> {
    const job = queue.get(jobId);
    if (!job || job.state !== 'completed' || (job.kind !== 'video' && job.kind !== 'music')) return null;
    if (job.outcome === 'applied') return job;
    const assetKind: AssetKind = job.kind === 'video' ? 'video' : 'audio';
    if (job.kind === 'video' && !job.sceneId) {
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: 'invalid',
        phase: 'error',
        needsUser: false,
        errorCode: 'SCENE_NOT_FOUND',
        errorMessage: '동영상 작업에 장면 ID(sceneId)가 없습니다.'
      });
    }
    await queue.setOutcome(job.jobId, job.requestId, { phase: 'validating' });

    const dataUrl = job.mediaDataUrl || job.imageDataUrl;
    if (!dataUrl && !job.downloadPath) {
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: 'invalid',
        phase: 'needs_user',
        needsUser: true,
        errorCode: 'MEDIA_DATA_MISSING',
        errorMessage: 'Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.'
      });
    }

    if (!deps.saveGeneratedMediaAsset) {
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: 'invalid',
        phase: 'error',
        needsUser: false,
        errorCode: 'SAVE_FAILED',
        errorMessage: '미디어 파일 저장기가 구성되지 않았습니다.'
      });
    }

    let savedResult: { project: StudioProject; asset: MediaAsset };
    try {
      savedResult = await deps.saveGeneratedMediaAsset(job.projectId, assetKind, {
        sceneId: job.kind === 'video' ? job.sceneId : undefined,
        mediaDataUrl: dataUrl,
        downloadPath: job.downloadPath,
        mimeType: job.mediaMimeType || job.imageMimeType
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isMissingScene = msg.includes('장면') && msg.includes('찾을 수 없습니다');
      return queue.setOutcome(job.jobId, job.requestId, {
        outcome: isMissingScene ? 'stale' : 'invalid',
        phase: isMissingScene ? 'needs_user' : 'error',
        needsUser: isMissingScene,
        errorCode: isMissingScene ? 'SCENE_NOT_FOUND' : 'SAVE_FAILED',
        errorMessage: msg
      });
    }

    const done = await queue.setOutcome(job.jobId, job.requestId, {
      outcome: 'applied',
      phase: 'done',
      needsUser: false,
      errorCode: undefined,
      errorMessage: undefined,
      validationError: undefined,
      assetId: savedResult.asset.id,
      resultRef: savedResult.asset.relativePath,
      appliedAt: new Date().toISOString(),
      appliedRevision: savedResult.project.revision
    });
    if (done) deps.onProjectUpdated?.(savedResult.project, done);
    return done;
  }

  /** 완료된 응답 검증·적용. force=사용자가 '이 결과 적용'으로 확인(다른 작품에는 여전히 적용 불가) */
  async function applyCompleted(jobId: string, force = false, expectedStage?: AIStage): Promise<GeminiJobRecord | null> {
    const job = queue.get(jobId);
    if (!job || job.state !== 'completed' || !isAIStage(job.kind)) return null;
    if (job.outcome === 'applied') return job;
    await queue.setOutcome(job.jobId, job.requestId, { phase: 'validating' });
    let project: StudioProject;
    try { project = await deps.readProject(job.projectId); }
    catch { return queue.setOutcome(job.jobId, job.requestId, { outcome: 'stale', phase: 'needs_user', needsUser: true, errorCode: 'PROJECT_NOT_FOUND', errorMessage: '요청한 작품을 찾을 수 없습니다.' }); }
    const d = decideStageApply(job, project, { force, expectedStage });
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
      const targetJob = queue.get(jobId);
      const msgSceneId = (msg.sceneId || payload.sceneId) as string | undefined;
      // 이미지·동영상 생성 작업은 sceneId까지 반드시 일치해야 수락
      if ((targetJob?.kind === 'image' || targetJob?.kind === 'video') && (!msgSceneId || msgSceneId !== targetJob.sceneId)) {
        return 'ignored';
      }
      const complete = !!payload.complete;
      const r = await queue.onResponse(jobId, msg.requestId, String(payload.text ?? ''), complete, {
        projectId: msg.projectId,
        sceneId: msgSceneId,
        codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks.map(String) : [],
        isolation: payload.isolation as string | undefined,
        imageDataUrl: typeof payload.imageDataUrl === 'string' ? payload.imageDataUrl : undefined,
        imageUrl: typeof payload.imageUrl === 'string' ? payload.imageUrl : undefined,
        mediaDataUrl: typeof payload.mediaDataUrl === 'string' ? payload.mediaDataUrl : undefined,
        mediaUrl: typeof payload.mediaUrl === 'string' ? payload.mediaUrl : undefined,
        downloadPath: typeof payload.downloadPath === 'string' ? payload.downloadPath : undefined,
        mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : undefined
      });
      if (r === 'applied' && complete) {
        const job = queue.get(jobId);
        if (job && isAIStage(job.kind)) await applyCompleted(jobId);
        else if (job && job.kind === 'image') await applyCompletedImage(jobId);
        else if (job && (job.kind === 'video' || job.kind === 'music')) await applyCompletedMedia(jobId);
        else if (job) await queue.setOutcome(job.jobId, job.requestId, { outcome: 'received', phase: 'done' });
        void kick();
      }
      return r;
    }
    if (msg.type === 'JOB_PROGRESS') {
      const targetJob = queue.get(jobId);
      const msgSceneId = (msg.sceneId || payload.sceneId) as string | undefined;
      if ((targetJob?.kind === 'image' || targetJob?.kind === 'video') && msgSceneId !== undefined && msgSceneId !== targetJob.sceneId) {
        return 'ignored';
      }
      const stage = String(payload.stage || '');
      if (!RECEIVABLE_PHASES.has(stage)) return 'ignored';
      return queue.setPhase(jobId, msg.requestId, stage, (payload.info || {}) as Record<string, unknown>, msg.projectId);
    }
    if (msg.type === 'ERROR') {
      const targetJob = queue.get(jobId);
      const msgSceneId = (msg.sceneId || payload.sceneId) as string | undefined;
      if ((targetJob?.kind === 'image' || targetJob?.kind === 'video') && msgSceneId !== undefined && msgSceneId !== targetJob.sceneId) {
        return 'ignored';
      }
      const r = await queue.onRemoteError(jobId, msg.requestId, msg.projectId, String(payload.code || 'REMOTE_ERROR'), String(payload.message || ''), payload.partialText ? String(payload.partialText) : undefined);
      if (r === 'applied') void kick();
      return r;
    }
    if (msg.type === 'DOWNLOAD_EVENT') {
      const targetJob = queue.get(jobId);
      if (!targetJob || (targetJob.kind !== 'image' && targetJob.kind !== 'video' && targetJob.kind !== 'music')) return 'ignored';
      const msgSceneId = (msg.sceneId || payload.sceneId) as string | undefined;
      if ((targetJob.kind === 'image' || targetJob.kind === 'video') && (!msgSceneId || msgSceneId !== targetJob.sceneId)) return 'ignored';
      if (payload.state === 'complete' && typeof payload.downloadPath === 'string' && payload.downloadPath.trim()) {
        if (targetJob.outcome === 'applied') return 'ignored';
        const applyFn = targetJob.kind === 'image' ? applyCompletedImage : applyCompletedMedia;
        if (targetJob.state === 'completed') {
          await queue.setOutcome(targetJob.jobId, targetJob.requestId, {
            downloadPath: payload.downloadPath.trim(),
            ...(typeof payload.mimeType === 'string' ? { imageMimeType: payload.mimeType, mediaMimeType: payload.mimeType } : {})
          });
          await applyFn(targetJob.jobId);
          void kick();
          return 'applied';
        }
        const r = await queue.onResponse(targetJob.jobId, msg.requestId, targetJob.resultText || '', true, {
          projectId: msg.projectId,
          sceneId: msgSceneId,
          downloadPath: payload.downloadPath.trim(),
          mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : undefined
        });
        if (r === 'applied') {
          await applyFn(targetJob.jobId);
          void kick();
        }
        return r;
      }
      if (payload.state === 'interrupted') {
        const failMsg =
          targetJob.kind === 'image'
            ? 'Gemini에서 이미지가 생성되었습니다. 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.'
            : 'Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.';
        const r = await queue.onRemoteError(targetJob.jobId, msg.requestId, msg.projectId, 'DOWNLOAD_FAILED', failMsg);
        if (r === 'applied') void kick();
        return r;
      }
      return 'ignored';
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
      if (isAIStage(job.kind) && job.outcome !== 'applied') await applyCompleted(jobId);
      else if (job.kind === 'image' && job.outcome !== 'applied') await applyCompletedImage(jobId);
      else if ((job.kind === 'video' || job.kind === 'music') && job.outcome !== 'applied') await applyCompletedMedia(jobId);
      return { success: true, message: '이미 응답을 받았습니다.' };
    }
    if (job.state !== 'needs_confirmation' && job.state !== 'waiting') return { success: false, message: '응답을 다시 받을 수 있는 상태가 아닙니다.' };
    const r = await adapter.requestResult({ jobId: job.jobId, requestId: job.requestId, projectId: job.projectId, ...(job.sceneId ? { sceneId: job.sceneId } : {}), stage: job.kind });
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

  /** 사용자가 「이 결과 적용」: 보류(stale)된 결과만 force. expectedStage가 다르면 거부(다른 단계 화면에서 적용 불가) */
  const applyResult = (jobId: string, expectedStage?: AIStage) => { const j = queue.get(jobId); return applyCompleted(jobId, j?.outcome === 'stale', expectedStage); };
  return { start, startSource, startImage, startVideo, startMusic, kick, applyCompleted, applyCompletedImage, applyCompletedMedia, applyResult, handleMessage, fetchResult, onReconnect, provider };
}
export type AnalysisService = ReturnType<typeof createAnalysisService>;
