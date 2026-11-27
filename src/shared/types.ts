import type {
  BibleFetchRequest,
  EditionComparisonSummary,
  OriginalFetchResult,
  OriginalSourceMeta,
  OriginalVersionEntry,
  SourceCandidate,
  SourceProviderInfo,
  SourceSearchQuery,
  SourceSearchResponse,
  StageReviewFlags
} from './source-types';
import type { SceneEffects, TransitionType } from './effects';

export type Genre = 'bible' | 'poetry' | 'essay' | 'novel' | 'classic';
export type Audience = 'preschool' | 'kids' | 'teens' | 'adult' | 'family';
export type Stage = 'brief' | 'analysis' | 'storyboard' | 'prompt' | 'media' | 'assembly' | 'handoff';
export type AIStage = 'analysis' | 'storyboard' | 'prompt' | 'editplan';
export type AssetKind = 'image' | 'video' | 'audio';
export type SceneStatus = 'draft' | 'ready' | 'complete';
export interface Brief {
  genre: Genre;
  audience: Audience;
  title: string;
  author: string;
  source: string;
  sourceUrl: string;
  originalText: string;
  rightsStatus: 'unreviewed' | 'reviewed' | 'public-domain' | 'licensed';
  targetDuration: number;
  aspectRatio: '16:9' | '9:16' | '1:1';
  /** 확정된 기준 원문 출처·저작권·검증·해시·버전 정보 (기존 프로젝트 하위 호환: optional) */
  originalMeta?: OriginalSourceMeta;
  /** 자동으로 채운 칸과 그 출처 이름 (사용자가 고치면 해당 칸 표시는 사라짐 · 기존 프로젝트 하위 호환: optional) */
  autoFilled?: Partial<Record<AutoFillField, string>>;
  /** 본문을 채운 첨부 파일 이름 (기존 프로젝트 하위 호환: optional) */
  originalFileName?: string;
  /** 성경 장르에서 선택한 번역본 ID (기본: 개역개정 NKRV. 기존 프로젝트 하위 호환: optional) */
  bibleTranslation?: string;
}
export type AutoFillField = 'title' | 'author' | 'source' | 'sourceUrl' | 'originalText';
export interface Choice { id: string; label: string; description: string }
/** 스타일 바이블: 모든 이미지·영상 프롬프트에 반복해 넣는 화풍·색·빛·주인공·금지 요소 (기존 분석 하위 호환: optional) */
export interface VisualBible { styleSentence: string; palette: string[]; lighting: string; character: string; avoid: string[]; motionStyle: string; }
export interface AnalysisResult { schema: 'creator.analysis.v1'; summary: string; emotion: string; keywords: string[]; styles: Choice[]; directions: Choice[]; cautions: string[];
  /** 정서 흐름 (예: 고백 → 쉼 → 그늘 → 잔치 → 집으로) */
  emotionArc?: string[];
  visualBible?: VisualBible;
  /** AI가 이 작품에 가장 맞다고 추천한 화풍·연출 id와 이유 (분석 결과가 들어오면 미리 선택됨) */
  recommendedStyleId?: string; recommendedDirectionId?: string; recommendationReason?: string; }
export interface StoryScene { id: string; title: string; narration: string; visual: string; durationSec: number; kind: 'image' | 'video';
  /** 장면 효과: 샷(움직임)·분위기 효과·색감·전환·자막 줄 (스토리보드 v2, 기존 장면 하위 호환: optional) */
  effects?: SceneEffects;
  /** 이 장면의 감정·해석 메모 */
  mood?: string; }
export interface StoryboardResult { schema: 'creator.storyboard.v1' | 'creator.storyboard.v2'; scenes: StoryScene[]; }
export interface PromptScene { sceneId: string; imagePrompt: string; videoPrompt?: string; negativePrompt?: string; }
export interface PromptsResult { schema: 'creator.prompts.v1'; items: PromptScene[]; bgmPrompt: string; }
export interface EditClip { sceneId: string; durationSec: number; transition: TransitionType;
  /** 전환 길이(초). 없으면 장면 효과의 전환 길이 또는 기본값 */
  transitionSec?: number; }
export interface EditPlanResult { schema: 'creator.editplan.v1'; clips: EditClip[]; notes?: string; }
export interface Scene extends StoryScene { imagePrompt: string; videoPrompt: string; negativePrompt: string; assetId: string | null; /** 영상 장면의 기준 이미지(이미지→동영상). 동영상이 assetId에 연결되어도 유지 */ referenceImageAssetId?: string | null; status: SceneStatus; }
export interface MediaAsset { id: string; kind: AssetKind; name: string; relativePath: string; bytes: number; importedAt: string; }
export interface StageRecord { status: 'idle' | 'review' | 'approved'; raw: string; updatedAt: string | null; }
export interface AIRecords { analysis: StageRecord; storyboard: StageRecord; prompt: StageRecord; editplan: StageRecord; }
export interface Assembly { clips: EditClip[]; subtitleMode: 'original' | 'none'; transitionDefault: TransitionType; bgmAssetId: string | null; }
export interface StudioProject {
  schema: 'creator.project.v1'; id: string; revision: number; createdAt: string; updatedAt: string; archived: boolean;
  brief: Brief;
  selection: { styleId: string; directionId: string };
  analysis: AnalysisResult | null; scenes: Scene[]; assets: MediaAsset[]; ai: AIRecords; assembly: Assembly;
  /** 작품 배경음악 생성 프롬프트 (생성 프롬프트 단계에서 저장; 기존 프로젝트는 ai.prompt.raw에서 폴백) */
  bgmPrompt?: string;
  /** 기준 원문 변경 이력 (기존 프로젝트 하위 호환: optional) */
  originalHistory?: OriginalVersionEntry[];
  /** 기준 원문 변경 후 재검토가 필요한 후속 단계 표시 (기존 프로젝트 하위 호환: optional) */
  reviewNeeded?: StageReviewFlags;
}
export interface ProjectSummary { id: string; title: string; genre: Genre; audience: Audience; updatedAt: string; createdAt: string; sceneCount: number; mediaCount: number; archived: boolean; /** 제목·원문이 아직 비어 있는 작성 중 작품 */ draft?: boolean; }
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
export type GeminiJobKind = 'analysis' | 'storyboard' | 'prompt' | 'editplan' | 'image' | 'video' | 'music' | 'source';
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
  /** 동영상 생성 시 Gemini 입력창에 첨부할 기준 이미지 (Native Messaging 전송용, 700KB 이하) */
  referenceImage?: ReferenceImagePayload;
  /** 미디어 생성 작업 결과 메타데이터 (이미지·동영상·배경음악 공용) */
  imageDataUrl?: string; imageUrl?: string; mediaDataUrl?: string; mediaUrl?: string; downloadPath?: string; imageMimeType?: string; mediaMimeType?: string; assetId?: string;
  /** 오류·확인 필요로 멈추기 직전 단계 */
  stoppedPhase?: GeminiJobPhase;
}
export interface ReferenceImagePayload { name: string; mimeType: string; dataUrl: string; }
export interface GeminiEnqueueInput { projectId: string; kind: GeminiJobKind; prompt: string; sceneId?: string; referenceImage?: ReferenceImagePayload; }
export type StudioAPI = {
  app: { info(): Promise<AppInfo>; openFolder(projectId: string): Promise<OperationResult>; };
  projects: {
    list(includeArchived?: boolean): Promise<ProjectSummary[]>;
    create(brief: Brief): Promise<StudioProject>;
    read(projectId: string): Promise<StudioProject>;
    save(project: StudioProject): Promise<StudioProject>;
    archive(projectId: string, archive: boolean): Promise<StudioProject>;
    exportFolder(projectId: string): Promise<string | null>;
    /** 제작 패키지 또는 작품 폴더를 가져와 로컬 목록에 추가 */
    importProject(): Promise<StudioProject | null>;
    /** 아무것도 입력하지 않은 작성 중 작품이면 지움 (지웠으면 true) */
    discardDraft(projectId: string): Promise<boolean>;
  };
  assets: { import(projectId: string, targetSceneId?: string): Promise<StudioProject | null>; reveal(projectId: string, assetId: string): Promise<void>; };
  clipboard: { write(text: string): Promise<void> };
  sources: {
    providers(): Promise<SourceProviderInfo[]>;
    search(query: SourceSearchQuery): Promise<SourceSearchResponse>;
    fetchOriginal(candidate: SourceCandidate): Promise<OriginalFetchResult>;
    compare(primary: { label: string; text: string }, secondary: { label: string; text: string }): Promise<EditionComparisonSummary>;
    importUrl(url: string): Promise<OriginalFetchResult>;
    importFile(): Promise<OriginalFetchResult | null>;
    /** 드래그앤드랍된 로컬 파일 경로에서 원문 추출 */
    importFilePath(filePath: string): Promise<OriginalFetchResult>;
    /** Electron 드롭 File에서 로컬 경로 (preload의 webUtils) */
    pathForFile(file: File): string;
    fetchBible(req: BibleFetchRequest): Promise<OriginalFetchResult>;
    openExternal(url: string): Promise<OperationResult>;
  };
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
    /** Phase 5 MVP: 장면별 이미지 생성 자동화 */
    image: {
      start(projectId: string, sceneId: string): Promise<GeminiAnalysisStartResult>;
      latest(projectId: string, sceneId?: string): Promise<GeminiJobRecord | null>;
      listForProject(projectId: string): Promise<GeminiJobRecord[]>;
    };
    /** Phase 5 확장: 장면별 동영상 생성(반자동) */
    video: {
      start(projectId: string, sceneId: string, options?: { useReferenceImage?: boolean }): Promise<GeminiAnalysisStartResult>;
      latest(projectId: string, sceneId?: string): Promise<GeminiJobRecord | null>;
      listForProject(projectId: string): Promise<GeminiJobRecord[]>;
    };
    /** Phase 5 확장: 작품 단위 배경음악 생성(반자동) */
    music: {
      start(projectId: string): Promise<GeminiAnalysisStartResult>;
      latest(projectId: string): Promise<GeminiJobRecord | null>;
      listForProject(projectId: string): Promise<GeminiJobRecord[]>;
    };
    /** 장르·저자·제목으로 Gemini에서 원문 가져오기 (본문에 채운 뒤 사용자가 검토·수정) */
    source: {
      start(projectId: string, query: { title: string; author?: string; genre?: Genre | 'all'; bibleTranslation?: string }): Promise<GeminiAnalysisStartResult>;
      latest(projectId: string): Promise<GeminiJobRecord | null>;
    };
    /** 아무것도 보내지 않고 Gemini 화면의 셀렉터 일치 현황만 확인 */
    probe(): Promise<GeminiProbeResult>;
    onJobUpdate(cb: (job: GeminiJobRecord) => void): () => void;
  };
};
export interface GeminiAnalysisStartResult { ok: boolean; job?: GeminiJobRecord; reused?: boolean; message?: string; }
export interface GeminiProbeResult { ok: boolean; message?: string; report?: unknown; tab?: { id: number; title: string }; }
