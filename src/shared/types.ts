export type Genre = 'bible' | 'poetry' | 'essay' | 'novel' | 'classic';
export type Audience = 'preschool' | 'kids' | 'teens' | 'adult' | 'family';
export type Stage = 'brief' | 'analysis' | 'storyboard' | 'prompt' | 'media' | 'assembly' | 'handoff';
export type AIStage = 'analysis' | 'storyboard' | 'prompt' | 'editplan';
export type AssetKind = 'image' | 'video' | 'audio';
export type SceneStatus = 'draft' | 'ready' | 'complete';
export interface Brief { genre: Genre; audience: Audience; title: string; author: string; source: string; sourceUrl: string; originalText: string; rightsStatus: 'unreviewed' | 'reviewed' | 'public-domain' | 'licensed'; targetDuration: number; aspectRatio: '16:9' | '9:16' | '1:1'; }
export interface Choice { id: string; label: string; description: string }
export interface AnalysisResult { schema: 'creator.analysis.v1'; summary: string; emotion: string; keywords: string[]; styles: Choice[]; directions: Choice[]; cautions: string[]; }
export interface StoryScene { id: string; title: string; narration: string; visual: string; durationSec: number; kind: 'image' | 'video'; }
export interface StoryboardResult { schema: 'creator.storyboard.v1'; scenes: StoryScene[]; }
export interface PromptScene { sceneId: string; imagePrompt: string; videoPrompt?: string; negativePrompt?: string; }
export interface PromptsResult { schema: 'creator.prompts.v1'; items: PromptScene[]; bgmPrompt: string; }
export interface EditClip { sceneId: string; durationSec: number; transition: 'cut' | 'fade' | 'dissolve'; }
export interface EditPlanResult { schema: 'creator.editplan.v1'; clips: EditClip[]; notes?: string; }
export interface Scene extends StoryScene { imagePrompt: string; videoPrompt: string; negativePrompt: string; assetId: string | null; status: SceneStatus; }
export interface MediaAsset { id: string; kind: AssetKind; name: string; relativePath: string; bytes: number; importedAt: string; }
export interface StageRecord { status: 'idle' | 'review' | 'approved'; raw: string; updatedAt: string | null; }
export interface AIRecords { analysis: StageRecord; storyboard: StageRecord; prompt: StageRecord; editplan: StageRecord; }
export interface Assembly { clips: EditClip[]; subtitleMode: 'original' | 'none'; transitionDefault: 'fade' | 'cut' | 'dissolve'; bgmAssetId: string | null; }
export interface StudioProject {
  schema: 'creator.project.v1'; id: string; revision: number; createdAt: string; updatedAt: string; archived: boolean;
  brief: Brief;
  selection: { styleId: string; directionId: string };
  analysis: AnalysisResult | null; scenes: Scene[]; assets: MediaAsset[]; ai: AIRecords; assembly: Assembly;
}
export interface ProjectSummary { id: string; title: string; genre: Genre; audience: Audience; updatedAt: string; createdAt: string; sceneCount: number; mediaCount: number; archived: boolean; }
export interface AppInfo { version: string; dataRoot: string; platform: string; }
export interface OperationResult { success: boolean; message?: string; }
export interface GeminiStatus {
  connected: boolean;
  hostRegistered: boolean;
  extensionConnected: boolean;
  geminiTabFound: boolean;
  loginState: 'unknown' | 'needed' | 'ready' | 'restricted';
  message: string;
  /** 연결 확인 때 받은 구성 요소별 자동화 프로토콜 (null = 보고 안 함 → 이전 버전) */
  versions?: {
    app: number;
    host?: { protocol: number; version: string } | null;
    extension?: { protocol: number; version: string } | null;
    content?: { state: 'ok' | 'outdated' | 'none' | 'unknown'; protocol?: number } | null;
  };
  versionIssue?: { code: string; message: string } | null;
  /** 복사해서 보낼 수 있는 연결 진단 텍스트 */
  diagnosticText?: string;
}
export interface GeminiPingResult { ok: boolean; roundtripMs: number; message: string; }
export interface GeminiJob { jobId: string; projectId: string; stage: string; prompt: string; sceneId?: string; }
export interface GeminiJobResult { success: boolean; jobId: string; errorCode?: string; message?: string; }
export type GeminiJobKind = 'analysis' | 'storyboard' | 'prompt' | 'editplan' | 'image' | 'video' | 'music';
export type GeminiJobState = 'queued' | 'dispatching' | 'waiting' | 'completed' | 'failed' | 'needs_confirmation' | 'cancelled' | 'cancelling';
/** UI 단계: 연결 확인/프롬프트 전송 중/Gemini 응답 대기/응답 수집 중/JSON 검증 중/분석 완료/사용자 확인 필요/오류 */
export type GeminiJobPhase = 'queued' | 'checking' | 'sending' | 'waiting' | 'collecting' | 'validating' | 'done' | 'needs_user' | 'error' | 'cancelled';
/** 응답 처리 결과: applied(작품에 저장) · invalid(JSON/스키마 오류) · stale(작품이 바뀌어 자동 적용 보류) · received(검증기 없는 단계) */
export type GeminiJobOutcome = 'applied' | 'invalid' | 'stale' | 'received';
export interface GeminiJobRecord {
  jobId: string; requestId: string; projectId: string; sceneId?: string; kind: GeminiJobKind;
  executable: boolean; prompt: string; state: GeminiJobState; createdAt: string; updatedAt: string;
  dispatchedAt?: string; sentAt?: string; completedAt?: string;
  errorCode?: string; errorMessage?: string; resultText?: string; resultRef?: string; sendConfirmed: boolean;
  cancelRequested: boolean; externalCancelConfirmed: boolean;
  phase?: GeminiJobPhase; needsUser?: boolean; outcome?: GeminiJobOutcome;
  codeBlocks?: string[]; isolation?: string; progressChars?: number;
  tab?: { id: number; title: string; url?: string }; insertMethod?: string; sendEvidence?: string; /** 연결 확인 진단 텍스트 (본문 없음) */ diagnostics?: string;
  appliedAt?: string; appliedRevision?: number; validationError?: string;
  /** 오류·확인 필요로 멈추기 직전 단계 */
  stoppedPhase?: GeminiJobPhase;
}
export interface GeminiEnqueueInput { projectId: string; kind: GeminiJobKind; prompt: string; sceneId?: string; }
export type StudioAPI = {
  app: { info(): Promise<AppInfo>; openFolder(projectId: string): Promise<OperationResult>; };
  projects: {
    list(includeArchived?: boolean): Promise<ProjectSummary[]>;
    create(brief: Brief): Promise<StudioProject>;
    read(projectId: string): Promise<StudioProject>;
    save(project: StudioProject): Promise<StudioProject>;
    archive(projectId: string, archive: boolean): Promise<StudioProject>;
    exportFolder(projectId: string): Promise<string | null>;
  };
  assets: { import(projectId: string): Promise<StudioProject | null>; reveal(projectId: string, assetId: string): Promise<void>; };
  clipboard: { write(text: string): Promise<void> };
  gemini: {
    status(): Promise<GeminiStatus>;
    ping(): Promise<GeminiPingResult>;
    submit(job: GeminiJob): Promise<GeminiJobResult>;
    jobs: {
      list(): Promise<GeminiJobRecord[]>;
      enqueue(input: GeminiEnqueueInput): Promise<GeminiJobRecord>;
      retry(jobId: string): Promise<GeminiJobRecord | null>;
      cancel(jobId: string): Promise<GeminiJobRecord | null>;
      confirm(jobId: string): Promise<GeminiJobRecord | null>;
      continue(jobId: string): Promise<GeminiJobRecord | null>;
    };
    /** AI 단계 자동화 (stage 생략 = 기획 분석). 기획 분석·스토리보드·생성 프롬프트·최종 편집 구성 */
    analysis: {
      /** 작품 정보로 그 단계의 프롬프트를 만들어 큐에 넣고 바로 실행. 같은 단계의 진행 중 작업이 있으면 그 작업을 돌려줌(중복 전송 방지) */
      start(projectId: string, stage?: AIStage): Promise<GeminiAnalysisStartResult>;
      /** 이 작품의 그 단계 가장 최근 작업 */
      latest(projectId: string, stage?: AIStage): Promise<GeminiJobRecord | null>;
      /** 확장 프로그램에 보관된 응답을 다시 요청 (재전송 아님) */
      fetchResult(jobId: string): Promise<OperationResult>;
      /** 자동 적용이 보류된(stale) 결과를 사용자가 확인 후 적용 */
      applyResult(jobId: string, stage?: AIStage): Promise<GeminiJobRecord | null>;
    };
    /** 아무것도 보내지 않고 Gemini 화면의 셀렉터 일치 현황만 확인 */
    probe(): Promise<GeminiProbeResult>;
    onJobUpdate(cb: (job: GeminiJobRecord) => void): () => void;
  };
};
export interface GeminiAnalysisStartResult { ok: boolean; job?: GeminiJobRecord; reused?: boolean; message?: string; }
export interface GeminiProbeResult { ok: boolean; message?: string; report?: unknown; tab?: { id: number; title: string }; }
