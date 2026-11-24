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
};
