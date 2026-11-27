/**
 * 「AI 기획 분석 시작」 자동화의 순수 로직 (Electron main·renderer·테스트에서 공용).
 * - 응답에서 JSON 후보 고르기 → 기존 applyAIResponse(creator.analysis.v1 검사기)로 검증
 * - 다른 작품/바뀐 작품 정보/더 새로운 결과를 덮어쓰지 않도록 적용 전 검사
 * - UI 단계 표시와 오류별 원인·해결 안내
 */
import type { AIStage, GeminiJobPhase, GeminiJobRecord, StudioProject } from './types';
import { applyAIResponse, extractJSON } from './workflow';
import { makeAIPrompt } from './prompts';

/** 자동화 대상 AI 단계: 모두 "프롬프트 → Gemini 텍스트 응답 → JSON 스키마 검사 → 작품 저장" 구조 */
export const AI_STAGES: readonly AIStage[] = ['analysis', 'storyboard', 'prompt', 'editplan'] as const;
export const isAIStage = (k: unknown): k is AIStage => typeof k === 'string' && (AI_STAGES as readonly string[]).includes(k);

/** Phase 5 MVP: 장면의 imagePrompt(+negativePrompt·화면비)로 Gemini 웹 이미지 생성 요청문을 만든다 */
export function makeImageGenerationPrompt(project: StudioProject, sceneId: string): string {
  const scene = project.scenes.find(s => s.id === sceneId);
  if (!scene) {
    throw new Error(`장면(${sceneId})을 찾을 수 없습니다.`);
  }
  const basePrompt = (scene.imagePrompt || '').trim();
  if (!basePrompt) {
    throw new Error(`${scene.id} 장면의 이미지 생성 프롬프트가 비어 있습니다. 생성 프롬프트 단계에서 먼저 프롬프트를 준비해 주세요.`);
  }
  const lines = [
    `Generate a single illustration image (${project.brief.aspectRatio} aspect ratio).`,
    `Image prompt: ${basePrompt}`
  ];
  if (scene.negativePrompt?.trim()) {
    lines.push(`Negative prompt (avoid): ${scene.negativePrompt.trim()}`);
  }
  const bible = visualBibleLine(project);
  if (bible) lines.push(bible);
  lines.push(MOTION_READY_COMPOSITION);
  lines.push('Important: Do not render any text, letters, subtitles, or watermarks inside the image.');
  return lines.join('\n');
}

/** 편집기에서 확대·이동·초점 다가가기를 하므로 여유 있는 구도로 */
export const MOTION_READY_COMPOSITION = 'Composition: wide, uncluttered framing with generous margins on all sides so the image can be slowly zoomed and panned (Ken Burns) without cropping the main subject; keep key subjects away from the edges; keep the bottom quarter simple and low-contrast for subtitles.';

/** 스타일 바이블(화풍 문장·주인공 고정 묘사·금지 요소)을 생성 요청 한 줄로 */
export function visualBibleLine(project: StudioProject): string {
  const b = project.analysis?.visualBible;
  if (!b) return '';
  const parts: string[] = [];
  if (b.styleSentence) parts.push(`Style: ${b.styleSentence}`);
  if (b.palette?.length) parts.push(`Palette: ${b.palette.join(', ')}`);
  if (b.character) parts.push(`Recurring character (keep identical in every scene): ${b.character}`);
  if (b.avoid?.length) parts.push(`Always avoid: ${b.avoid.join(', ')}`);
  return parts.join('\n');
}

/** 작품의 배경음악 프롬프트 조회 (project.bgmPrompt 우선, 없으면 기존 ai.prompt.raw JSON에서 추출) */
export function getProjectBgmPrompt(project: StudioProject): string {
  if (typeof project.bgmPrompt === 'string' && project.bgmPrompt.trim()) {
    return project.bgmPrompt.trim();
  }
  const raw = project.ai?.prompt?.raw;
  if (raw && raw.trim()) {
    try {
      const parsed = extractJSON(raw) as { bgmPrompt?: unknown };
      if (typeof parsed?.bgmPrompt === 'string' && parsed.bgmPrompt.trim()) {
        return parsed.bgmPrompt.trim();
      }
    } catch { /* ignore */ }
  }
  return '';
}

const GENRE_EN: Record<string, string> = { bible: 'biblical', poetry: 'poetry', essay: 'essay', novel: 'novel', classic: 'classic' };
const AUDIENCE_EN: Record<string, string> = { preschool: 'preschool children', kids: 'children', teens: 'teens', adult: 'adults', family: 'family' };

/**
 * 새 Gemini 채팅으로 넘어가도 화풍이 유지되도록, 선택된 화풍·키워드와 장르·시청 대상을 한 줄로 모은다.
 */
export function visualStyleConsistency(project: StudioProject): string {
  const bits: string[] = [];
  const styleId = project.selection?.styleId;
  const style = project.analysis?.styles?.find(s => s.id === styleId);
  if (style) {
    if (style.label?.trim()) bits.push(style.label.trim());
    if (style.description?.trim()) bits.push(style.description.trim());
  }
  const directionId = project.selection?.directionId;
  const direction = project.analysis?.directions?.find(d => d.id === directionId);
  if (direction?.label?.trim()) bits.push(`direction: ${direction.label.trim()}`);
  const keywords = project.analysis?.keywords;
  if (Array.isArray(keywords)) {
    const ks = keywords.map(k => String(k).trim()).filter(Boolean);
    if (ks.length) bits.push(`keywords: ${ks.join(', ')}`);
  }
  const genre = project.brief?.genre;
  if (genre) bits.push(`genre: ${GENRE_EN[genre] || genre}`);
  const audience = project.brief?.audience;
  if (audience) bits.push(`audience: ${AUDIENCE_EN[audience] || audience}`);
  return bits.join('. ');
}

/**
 * Phase 5 확장: 장면의 videoPrompt(+negativePrompt·화면비)로 Gemini 웹 동영상 생성 요청문을 만든다.
 * 참고: Gemini 웹의 동영상 생성(Veo 등)은 계정 등급·지역·UI 변경에 따라 불안정하거나 제한될 수 있다.
 * 도구 선택 시 새 채팅으로 넘어가면 앞 대화 맥락이 사라지므로, 확정 화풍·일관성 정보를 함께 넣는다.
 */
export function makeVideoGenerationPrompt(project: StudioProject, sceneId: string, opts?: { hasReferenceImage?: boolean }): string {
  const scene = project.scenes.find(s => s.id === sceneId);
  if (!scene) {
    throw new Error(`장면(${sceneId})을 찾을 수 없습니다.`);
  }
  const basePrompt = (scene.videoPrompt || '').trim();
  if (!basePrompt) {
    throw new Error(`${scene.id} 장면의 동영상 생성 프롬프트(videoPrompt)가 비어 있습니다. 생성 프롬프트 단계에서 먼저 작성해 주세요.`);
  }
  const lines = opts?.hasReferenceImage
    ? [
        `Animate the attached reference image into a short cinematic video (${project.brief.aspectRatio} aspect ratio, gentle single motion, slow camera movement).`,
        `Keep the exact characters, art style, composition, and colors from the attached reference image.`,
        `Video prompt: ${basePrompt}`
      ]
    : [
        `Generate a short cinematic video (${project.brief.aspectRatio} aspect ratio, gentle single motion, slow camera movement).`,
        `Video prompt: ${basePrompt}`
      ];
  const style = visualStyleConsistency(project);
  if (style) lines.push(`Visual style consistency: ${style}`);
  const bible = visualBibleLine(project);
  if (bible) lines.push(bible);
  if (scene.negativePrompt?.trim()) {
    lines.push(`Negative prompt (avoid): ${scene.negativePrompt.trim()}`);
  }
  lines.push('Important: Do not render any text, subtitles, or watermarks inside the video.');
  return lines.join('\n');
}

/**
 * Phase 5 확장: 작품의 bgmPrompt로 Gemini 웹 배경음악 생성 요청문을 만든다.
 * 참고: Gemini 웹의 음악 생성(Lyria 등)은 계정 등급·지역·UI 변경에 따라 불안정하거나 제한될 수 있다.
 */
export function makeMusicGenerationPrompt(project: StudioProject): string {
  const bgm = getProjectBgmPrompt(project);
  if (!bgm) {
    throw new Error('작품의 배경음악 프롬프트(bgmPrompt)가 비어 있습니다. 생성 프롬프트 단계에서 먼저 프롬프트를 생성해 주세요.');
  }
  return [
    'Generate an instrumental background music track (no vocals, no lyrics, original composition).',
    `Music prompt: ${bgm}`
  ].join('\n');
}

export interface StageMeta {
  name: string; schema: string; startLabel: string; restartLabel: string; doneLabel: string; resultLabel: string;
  /** 다시 실행하면 사라지는 것 (확인 창 문구). null = 확인 없이 시작 */
  resetWarning(p: StudioProject): string | null;
  /** 시작 전 필요한 앞 단계 결과. null = 시작 가능 */
  prerequisite(p: StudioProject): string | null;
  /** 앞 단계 결과가 바뀌었을 때의 안내 */
  upstreamChanged: string;
}
export const STAGE_META: Record<AIStage, StageMeta> = {
  analysis: {
    name: '기획 분석', schema: 'creator.analysis.v1', startLabel: 'AI 기획 분석 시작', restartLabel: 'AI 기획 분석 다시 시작', doneLabel: '분석 완료', resultLabel: 'ANALYSIS RESULT',
    resetWarning: p => p.analysis && (p.selection.styleId || p.scenes.length) ? '다시 분석하면 현재 화풍·연출 선택과 스토리보드 장면이 초기화됩니다. 계속할까요?' : null,
    prerequisite: p => (!p.brief.title.trim() || !p.brief.originalText.trim()) ? '작품 제목과 낭독 원문을 먼저 입력해 주세요.' : null,
    upstreamChanged: '요청을 보낸 뒤 작품 정보(원문·장르·대상 등)가 바뀌어 자동으로 적용하지 않았습니다.'
  },
  storyboard: {
    name: '스토리보드', schema: 'creator.storyboard.v2', startLabel: 'AI 장면 구성 시작', restartLabel: 'AI 장면 구성 다시 시작', doneLabel: '장면 구성 완료', resultLabel: 'STORYBOARD RESULT',
    resetWarning: p => p.scenes.length ? '다시 구성하면 바뀐 장면의 생성 프롬프트·미디어 연결과 최종 편집안이 초기화됩니다. 계속할까요?' : null,
    prerequisite: p => !p.analysis || !p.selection.styleId || !p.selection.directionId ? '기획 분석 후 화풍과 연출안을 먼저 선택해 주세요.' : null,
    upstreamChanged: '요청을 보낸 뒤 작품 정보나 선택한 화풍·연출안이 바뀌어 자동으로 적용하지 않았습니다.'
  },
  prompt: {
    name: '생성 프롬프트', schema: 'creator.prompts.v1', startLabel: 'AI 프롬프트 생성 시작', restartLabel: 'AI 프롬프트 다시 생성', doneLabel: '프롬프트 생성 완료', resultLabel: 'PROMPT RESULT',
    resetWarning: p => p.scenes.some(s => s.imagePrompt) ? '다시 생성하면 장면별 이미지·영상 프롬프트를 새 결과로 덮어씁니다. 계속할까요?' : null,
    prerequisite: p => !p.scenes.length ? '스토리보드 장면을 먼저 구성해 주세요.' : null,
    upstreamChanged: '요청을 보낸 뒤 작품 정보·화풍 또는 스토리보드 장면이 바뀌어 자동으로 적용하지 않았습니다.'
  },
  editplan: {
    name: '최종 편집 구성', schema: 'creator.editplan.v1', startLabel: 'AI 편집 구성 시작', restartLabel: 'AI 편집 구성 다시 시작', doneLabel: '편집 구성 완료', resultLabel: 'EDIT PLAN RESULT',
    resetWarning: p => p.assembly.clips.length ? '다시 구성하면 현재 최종 편집안(클립 순서·길이·전환)을 새 결과로 덮어씁니다. 계속할까요?' : null,
    prerequisite: p => !p.scenes.length ? '스토리보드 장면을 먼저 구성해 주세요.' : null,
    upstreamChanged: '요청을 보낸 뒤 작품 정보, 장면 또는 연결된 미디어가 바뀌어 자동으로 적용하지 않았습니다.'
  }
};

/** 응답 텍스트와 코드 블록에서 JSON 후보를 우선순위대로 (중복 제거).
 *  해당 단계 schema 표기가 있는 코드 블록 → 나머지 코드 블록(뒤에서부터) → 전체 텍스트 */
export function answerCandidates(text: string | undefined, codeBlocks: string[] | undefined, schema = 'creator.analysis.v1'): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => { const t = (s || '').trim(); if (t && !out.includes(t)) out.push(t); };
  const blocks = (codeBlocks || []).filter(b => b.includes('{'));
  for (const b of blocks.filter(b => b.includes(schema)).reverse()) push(b);
  for (const b of blocks.slice().reverse()) push(b);
  push(text);
  return out;
}

export type ApplyDecision =
  | { action: 'apply'; project: StudioProject; raw: string; candidateIndex: number }
  | { action: 'reject'; outcome: 'invalid' | 'stale'; code: string; message: string };

type ApplyJob = Pick<GeminiJobRecord, 'jobId' | 'projectId' | 'kind' | 'prompt' | 'createdAt' | 'resultText' | 'codeBlocks'>;

/**
 * 완료된 작업의 응답을 작품에 적용할지 결정 (모든 AI 단계 공용).
 * - expectedStage가 주어지면 그 단계의 작업만 (다른 단계 결과를 이 단계에 적용 불가)
 * - 다른 작품에는 force여도 절대 적용하지 않음
 * - force가 아니면: 프롬프트가 지금 작품으로 다시 만든 것과 다르면(앞 단계 결과·작품 정보 변경) 보류,
 *   이 요청 이후 같은 단계 결과가 이미 적용되었으면 보류
 * - JSON은 그 단계의 스키마 검사기(applyAIResponse)로만 검증 → 다른 단계의 JSON은 통과하지 못함
 */
export function decideStageApply(job: ApplyJob, project: StudioProject, opts: { force?: boolean; expectedStage?: AIStage } = {}): ApplyDecision {
  const stage = job.kind as AIStage;
  if (!isAIStage(job.kind) || (opts.expectedStage && opts.expectedStage !== stage)) {
    return { action: 'reject', outcome: 'stale', code: 'WRONG_KIND', message: opts.expectedStage ? `${STAGE_META[opts.expectedStage].name} 작업이 아닙니다.` : '자동 적용할 수 있는 AI 단계 작업이 아닙니다.' };
  }
  if (project.id !== job.projectId) return { action: 'reject', outcome: 'stale', code: 'OTHER_PROJECT', message: '다른 작품의 응답이므로 적용하지 않았습니다.' };
  if (!opts.force) {
    if (makeAIPrompt(project, stage) !== job.prompt) {
      return { action: 'reject', outcome: 'stale', code: stage === 'analysis' ? 'BRIEF_CHANGED' : 'UPSTREAM_CHANGED', message: STAGE_META[stage].upstreamChanged };
    }
    const at = project.ai[stage]?.updatedAt;
    const prev = at ? Date.parse(at) : 0;
    if (prev && prev > Date.parse(job.createdAt)) {
      return { action: 'reject', outcome: 'stale', code: stage === 'analysis' ? 'NEWER_ANALYSIS' : 'NEWER_RESULT', message: `이 요청 이후에 다른 ${STAGE_META[stage].name} 결과가 이미 적용되어 덮어쓰지 않았습니다.` };
    }
  }
  const candidates = answerCandidates(job.resultText, job.codeBlocks, STAGE_META[stage].schema);
  if (!candidates.length) return { action: 'reject', outcome: 'invalid', code: 'EMPTY_RESPONSE', message: 'Gemini 응답이 비어 있습니다.' };
  let firstError = '';
  for (let i = 0; i < candidates.length; i++) {
    try {
      const next = applyAIResponse(project, stage, candidates[i]);
      return { action: 'apply', project: next, raw: candidates[i], candidateIndex: i };
    } catch (e) {
      if (!firstError) firstError = e instanceof Error ? e.message : String(e);
    }
  }
  return { action: 'reject', outcome: 'invalid', code: 'INVALID_JSON', message: firstError || 'JSON을 찾지 못했습니다.' };
}

/** 기획 분석 전용 (기존 이름 유지 — 실제 Gemini에서 검증된 경로) */
export function decideAnalysisApply(job: ApplyJob, project: StudioProject, opts: { force?: boolean } = {}): ApplyDecision {
  if (job.kind !== 'analysis') return { action: 'reject', outcome: 'stale', code: 'WRONG_KIND', message: '기획 분석 작업이 아닙니다.' };
  return decideStageApply(job, project, { ...opts, expectedStage: 'analysis' });
}

/** UI 진행 단계 (요구된 8개 상태 표기) */
export const PHASE_LABEL: Record<GeminiJobPhase, string> = {
  queued: '연결 확인', checking: '연결 확인', sending: '프롬프트 전송 중', waiting: 'Gemini 응답 대기',
  collecting: '응답 수집 중', validating: 'JSON 검증 중', done: '분석 완료', needs_user: '사용자 확인 필요', error: '오류', cancelled: '취소됨'
};
export const PROGRESS_STEPS: { key: GeminiJobPhase; label: string }[] = [
  { key: 'checking', label: '연결 확인' },
  { key: 'sending', label: '프롬프트 전송' },
  { key: 'waiting', label: '응답 대기' },
  { key: 'collecting', label: '응답 수집' },
  { key: 'validating', label: 'JSON 검증' },
  { key: 'done', label: '분석 완료' }
];

export interface PhaseView { phase: GeminiJobPhase; label: string; tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted'; step: number; active: boolean; }

/** 작업 레코드 → 화면 표시 단계. 상태(state)와 phase가 어긋나도 안전하게 해석 */
export function phaseView(job: GeminiJobRecord | null | undefined): PhaseView | null {
  if (!job) return null;
  let phase: GeminiJobPhase = job.phase || 'queued';
  if (job.state === 'cancelled') phase = 'cancelled';
  else if (job.state === 'needs_confirmation') phase = 'needs_user';
  else if (job.state === 'failed') phase = job.needsUser ? 'needs_user' : 'error';
  else if (job.state === 'completed') {
    phase = job.outcome === 'applied' || job.outcome === 'received' ? 'done' : job.outcome === 'stale' ? 'needs_user' : job.outcome === 'invalid' ? 'error' : 'validating';
  }
  const order = PROGRESS_STEPS.map(s => s.key);
  let step = order.indexOf(phase === 'queued' ? 'checking' : phase);
  if (step < 0) {
    // 오류/확인 필요일 때 어디서 멈췄는지: 기록된 단계 → 없으면 상태로 추정
    const stopped = job.stoppedPhase === 'queued' ? 'checking' : job.stoppedPhase;
    step = job.state === 'completed' ? order.indexOf('validating')
      : stopped && order.includes(stopped) ? order.indexOf(stopped)
      : job.sendConfirmed ? order.indexOf('waiting') : 0;
  }
  const tone: PhaseView['tone'] = phase === 'done' ? 'success' : phase === 'needs_user' ? 'warning' : phase === 'error' ? 'danger' : phase === 'cancelled' ? 'muted' : 'accent';
  const active = !['done', 'needs_user', 'error', 'cancelled'].includes(phase);
  return { phase, label: PHASE_LABEL[phase], tone, step, active };
}

/** 오류 코드별 원인·해결 방법 */
export const ERROR_GUIDE: Record<string, { cause: string; fix: string }> = {
  HOST_NOT_CONNECTED: { cause: 'Native Host가 앱에 연결되지 않았습니다.', fix: 'Chrome을 실행하고 확장 프로그램이 켜져 있는지 확인한 뒤, 환경 설정 → AI 연결 → 연결 상태 확인을 눌러 주세요. 필요하면 npm run native:register 로 다시 등록합니다.' },
  EXTENSION_NOT_CONNECTED: { cause: 'Chrome 확장 프로그램이 응답하지 않습니다.', fix: 'chrome://extensions 에서 GOMO Gemini Connector를 새로고침하고 Chrome을 재시작해 주세요.' },
  HOST_OUTDATED: { cause: 'Native Host가 이전 버전으로 실행 중입니다(버전 확인에 응답하지 않음). Gemini에 보내지 않았습니다.', fix: '① chrome://extensions 에서 GOMO Gemini Connector의 새로고침(↻)을 누르면 Host가 새 코드로 다시 시작됩니다. ② 그래도 같으면 저장소 폴더(git pull 한 곳)에서 SETUP_GEMINI.bat 을 실행하고 Chrome을 완전히 종료했다가 다시 켜 주세요. ③ 「다시 시도」를 누르세요.' },
  EXTENSION_OUTDATED: { cause: 'Chrome이 GOMO Gemini Connector의 이전 서비스 워커 코드를 실행 중입니다(확장 카드의 버전과 다를 수 있음). Gemini에 입력·전송하지 않았습니다.', fix: '① chrome://extensions → GOMO Gemini Connector 「세부정보」의 소스 경로가 git pull 한 저장소의 extension 폴더(예: E:\Pjt\creator\extension)인지 확인 ② 카드의 ↻ 새로고침 → 버전 0.2.10 확인 → 「서비스 워커」 링크를 눌러 콘솔에 “GOMO background protocol 2 build 0.2.10 file gomo-sw.js”가 보이는지 확인 ③ 안 보이면 확장을 「삭제」한 뒤 「압축해제된 확장 프로그램을 로드합니다」로 같은 extension 폴더를 다시 로드(예전 ID 카드가 남아 있으면 제거). 필요하면 저장소 폴더에서 SETUP_GEMINI.bat 을 실행 ④ Chrome을 완전히 종료(트레이 아이콘까지)했다가 다시 켜고 Gemini 탭 열기 ⑤ 「다시 시도」. 그래도 같으면 「진단 정보」를 복사해 보내 주세요.' },
  EXTENSION_NO_REPLY: { cause: 'Native Host는 최신이지만 Chrome 확장 프로그램이 상태 요청에 응답하지 않았습니다. Gemini에 보내지 않았습니다.', fix: 'Chrome을 완전히 종료(창을 모두 닫고, 작업 표시줄 오른쪽 트레이의 Chrome 아이콘도 종료)한 뒤 다시 켜고 Gemini 탭을 연 다음 「다시 시도」를 눌러 주세요. 계속되면 아래 「진단 정보」를 복사해 보내 주세요.' },
  CONTENT_OUTDATED: { cause: 'Gemini 탭에 이전 버전의 확장 스크립트가 남아 있습니다. Gemini에 보내지 않았습니다.', fix: 'Gemini 탭을 새로고침(F5)한 뒤 「다시 시도」를 눌러 주세요.' },
  EXTENSION_OUTDATED_UNCERTAIN: { cause: '이전 버전 확장 프로그램이 요청을 처리해서 Gemini에 입력·전송되었는지 알 수 없습니다.', fix: 'Gemini 화면에서 이번 요청이 올라갔는지 직접 확인해 주세요. chrome://extensions 에서 확장을 새로고침(0.2.10)하고 Gemini 탭을 새로고침한 뒤, 올라갔으면 「응답 기다리기」, 없으면 「다시 보내기」를 누르세요. 앱은 자동으로 다시 보내지 않습니다.' },
  BAD_REQUEST: { cause: '요청에 jobId/requestId/projectId가 빠져 있어 전송하지 않았습니다(앱·확장 버전 불일치).', fix: 'chrome://extensions 에서 확장을 새로고침(0.2.10)하고 Gemini 탭을 새로고침한 뒤, 앱도 최신으로 다시 빌드·재시작(npm run build)하고 「다시 시도」를 눌러 주세요.' },
  NO_TAB: { cause: '열려 있는 Gemini 탭이 없습니다.', fix: 'Chrome에서 https://gemini.google.com 을 열고 로그인한 뒤 다시 시작해 주세요.' },
  NO_GEMINI_TAB: { cause: '열려 있는 Gemini 탭이 없습니다.', fix: 'Chrome에서 https://gemini.google.com 을 열고 로그인한 뒤 다시 시작해 주세요.' },
  NO_CONTENT_SCRIPT: { cause: 'Gemini 탭에 확장 스크립트가 아직 로드되지 않았습니다.', fix: 'Gemini 탭을 새로고침(F5)한 뒤 다시 시작해 주세요.' },
  LOGIN_REQUIRED: { cause: 'Gemini에 로그인되어 있지 않습니다.', fix: 'Chrome의 Gemini 탭에서 직접 Google 계정으로 로그인한 뒤 다시 시작해 주세요. 앱은 로그인을 대신하지 않습니다.' },
  BLOCKED: { cause: 'Google 보안 확인(로봇 확인 등) 또는 이용 제한 화면이 표시되었습니다.', fix: 'Gemini 탭에서 직접 확인을 마친 뒤 다시 시작해 주세요. 앱은 이 화면을 자동으로 우회하지 않습니다.' },
  NO_INPUT: { cause: 'Gemini 입력창을 찾지 못했습니다. Gemini 화면 구조가 바뀌었을 수 있습니다.', fix: '환경 설정 → AI 연결 → 선택자 진단 결과를 확인해 주세요. 아래 수동 연결(복사·붙여넣기)로도 진행할 수 있습니다.' },
  NO_SEND_BUTTON: { cause: '전송 버튼을 찾지 못했거나 비활성 상태입니다. 전송하지 않았습니다.', fix: '선택자 진단 결과를 확인하고, 수동 연결로 진행하거나 다시 시작해 주세요.' },
  INSERT_FAILED: { cause: '입력창에 프롬프트를 넣지 못했습니다. 전송하지 않았습니다.', fix: 'Gemini 탭을 새로고침한 뒤 다시 시작하거나 수동 연결을 사용해 주세요.' },
  COMPOSER_NOT_EMPTY: { cause: 'Gemini 입력창에 작성 중인 내용이 있어 덮어쓰지 않았습니다.', fix: 'Gemini 입력창을 비운 뒤 다시 시작해 주세요.' },
  GEMINI_BUSY: { cause: 'Gemini가 이전 답변을 아직 생성하고 있습니다.', fix: '답변이 끝난 뒤 다시 시작해 주세요.' },
  EXTENSION_BUSY: { cause: '같은 Gemini 탭에서 다른 요청을 처리 중입니다.', fix: '진행 중인 요청이 끝난 뒤 다시 시작해 주세요.' },
  SEND_UNCERTAIN: { cause: '전송 버튼은 눌렀지만 전송 여부를 확인하지 못했습니다.', fix: 'Gemini 화면에 이번 요청이 올라갔는지 직접 확인해 주세요. 올라갔다면 「응답 기다리기」, 없다면 「다시 보내기」를 누르세요. 앱은 자동으로 다시 보내지 않습니다.' },
  NO_RESPONSE: { cause: 'Gemini 탭과의 통신이 중간에 끊겨 전송 여부를 알 수 없습니다.', fix: 'Gemini 화면을 확인한 뒤 「응답 기다리기」 또는 「다시 보내기」를 선택해 주세요.' },
  TIMEOUT: { cause: '확장 프로그램이 제시간에 전송 결과를 알려주지 않았습니다. 전송 여부를 알 수 없습니다.', fix: 'Gemini 화면을 확인한 뒤 「응답 기다리기」 또는 「다시 보내기」를 선택해 주세요.' },
  CONNECTION_LOST: { cause: '전송 중 연결이 끊겼습니다. 전송 여부를 알 수 없습니다.', fix: 'Gemini 화면을 확인한 뒤 「응답 기다리기」 또는 「다시 보내기」를 선택해 주세요.' },
  CONNECTION_LOST_WAITING: { cause: '응답을 기다리는 중 Chrome 확장 연결이 끊겼습니다.', fix: 'Chrome이 열려 있는지 확인해 주세요. 다시 연결되면 「응답 다시 가져오기」로 받아올 수 있습니다.' },
  APP_RESTARTED_WAITING: { cause: '응답을 기다리는 동안 앱이 종료되었습니다.', fix: '「응답 다시 가져오기」를 누르면 확장 프로그램에 보관된 응답을 받아옵니다(재전송 아님).' },
  APP_RESTARTED_UNCERTAIN: { cause: '전송 도중 앱이 종료되어 전송 여부를 알 수 없습니다.', fix: 'Gemini 화면을 확인한 뒤 「응답 기다리기」 또는 「다시 보내기」를 선택해 주세요.' },
  RESPONSE_TIMEOUT: { cause: 'Gemini 응답 완료를 제시간에 확인하지 못했습니다.', fix: 'Gemini 화면에서 답변이 끝났는지 확인해 주세요. 끝났다면 「응답 다시 가져오기」 또는 수동 연결로 붙여넣을 수 있습니다.' },
  NO_RESPONSE_NODE: { cause: '전송 후 Gemini 응답 블록을 찾지 못했습니다(화면 구조 변경 가능).', fix: '선택자 진단 결과를 확인하고, 답변이 보이면 수동 연결로 붙여넣어 주세요.' },
  INVALID_JSON: { cause: 'Gemini 응답에서 이 단계의 올바른 JSON(스키마)을 찾지 못했습니다.', fix: '아래 「Gemini 응답 원문」을 확인하고 「다시 요청」하거나, 수동 연결에서 JSON을 고쳐 적용해 주세요.' },
  EMPTY_RESPONSE: { cause: 'Gemini 응답이 비어 있습니다.', fix: 'Gemini 화면을 확인하고 「다시 요청」해 주세요.' },
  BRIEF_CHANGED: { cause: '요청 후 작품 정보가 바뀌어 결과를 자동 적용하지 않았습니다.', fix: '바뀐 작품 정보로 「다시 요청」하는 것을 권장합니다. 그래도 이 결과를 쓰려면 「이 결과 적용」을 누르세요.' },
  UPSTREAM_CHANGED: { cause: '요청 후 앞 단계 결과(작품 정보·화풍·장면·미디어)가 바뀌어 결과를 자동 적용하지 않았습니다.', fix: '바뀐 내용으로 「다시 시작」하는 것을 권장합니다. 그래도 이 결과를 쓰려면 「이 결과 적용」을 누르세요.' },
  NEWER_RESULT: { cause: '이 요청 이후 같은 단계의 다른 결과가 이미 적용되어 있습니다.', fix: '덮어쓰려면 「이 결과 적용」을 누르세요. 그대로 두려면 닫으면 됩니다.' },
  NEWER_ANALYSIS: { cause: '이 요청 이후 다른 기획 분석 결과가 이미 적용되어 있습니다.', fix: '덮어쓰려면 「이 결과 적용」을 누르세요. 그대로 두려면 닫으면 됩니다.' },
  PROJECT_NOT_FOUND: { cause: '요청한 작품을 찾을 수 없습니다(보관·삭제됨).', fix: '작품을 복원한 뒤 다시 요청해 주세요.' },
  SAVE_FAILED: { cause: '결과를 작품 파일에 저장하지 못했습니다.', fix: '작품을 다시 열고 「응답 다시 가져오기」 또는 「이 결과 적용」을 눌러 주세요.' },
  NO_IMAGE_GENERATED: { cause: 'Gemini가 이미지를 생성하지 않고 텍스트로만 응답했습니다.', fix: '프롬프트가 이미지 생성 정책에 저촉되었거나 모델이 텍스트로만 답했을 수 있습니다. Gemini 탭의 응답을 확인하고 프롬프트를 다듬은 뒤 다시 시도하거나, 이미지가 있다면 다운로드 후 「미디어 가져오기」로 추가해 주세요.' },
  IMAGE_DETECT_FAILED: { cause: 'Gemini 응답이 완료되었으나 화면에서 생성된 이미지 요소를 자동으로 찾지 못했습니다(셀렉터 불일치 가능).', fix: 'Gemini에서 이미지가 생성되었습니다. 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.' },
  DOWNLOAD_BUTTON_NOT_FOUND: { cause: 'Gemini에서 이미지가 생성되었으나 다운로드 버튼을 자동으로 찾지 못했습니다.', fix: 'Gemini에서 이미지가 생성되었습니다. 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.' },
  DOWNLOAD_TIMEOUT: { cause: 'Gemini 이미지 다운로드 버튼을 클릭했으나 일정 시간 내에 다운로드 완료를 확인하지 못했습니다.', fix: 'Gemini에서 이미지가 생성되었습니다. 다운로드 폴더를 확인하거나 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.' },
  DOWNLOAD_NOT_STARTED: { cause: 'Gemini가 \'다운로드됨\'만 표시하고 실제 파일을 보내지 않았습니다(탭을 새로고침해 한 번 더 받아 봤지만 실패).', fix: 'Gemini 탭에서 F5를 누른 뒤 이미지를 직접 받아 「가져와서 연결」을 누르거나, 「다시 가져오기」를 눌러 주세요.' },
  MEDIA_NOT_FOUND: { cause: 'Gemini 대화에서 이 장면의 생성 결과를 다시 찾지 못했습니다.', fix: '생성했던 Gemini 대화를 열어 둔 뒤 「다시 가져오기」를 누르거나, 직접 받아 「가져와서 연결」을 눌러 주세요.' },
  RELOAD_FAILED: { cause: 'Gemini 탭을 새로고침하지 못했습니다.', fix: 'Gemini 탭에서 F5를 누른 뒤 「다시 가져오기」를 눌러 주세요.' },
  RELOAD_NOT_READY: { cause: '새로고침한 Gemini 탭이 제시간에 준비되지 않았습니다.', fix: 'Gemini 화면이 다 뜬 뒤 「다시 가져오기」를 눌러 주세요.' },
  DOWNLOAD_FAILED: { cause: '브라우저에서 이미지 다운로드가 중단되었거나 실패했습니다.', fix: 'Gemini에서 이미지가 생성되었습니다. 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.' },
  DOWNLOAD_PATH_MISSING: { cause: '다운로드는 감지되었으나 로컬 파일 경로를 확보하지 못했습니다.', fix: 'Gemini에서 이미지가 생성되었습니다. 다운로드한 파일을 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.' },
  IMAGE_DATA_MISSING: { cause: 'Gemini에서 이미지 생성은 감지되었으나 이미지 파일 데이터를 자동으로 가져오지 못했습니다.', fix: 'Gemini에서 이미지가 생성되었습니다. 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.' },
  NO_VIDEO_GENERATED: { cause: 'Gemini가 동영상을 생성하지 않고 텍스트로만 응답했습니다(계정 등급 또는 정책 제한 가능).', fix: 'Gemini 탭에서 응답을 확인하세요. 동영상이 생성되었다면 Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.' },
  NO_MUSIC_GENERATED: { cause: 'Gemini가 배경음악을 생성하지 않고 텍스트로만 응답했습니다(계정 등급 또는 기능 미지원 가능).', fix: 'Gemini 탭에서 응답을 확인하세요. 음악이 생성되었다면 Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.' },
  MEDIA_DETECT_FAILED: { cause: 'Gemini 응답이 완료되었으나 화면에서 생성된 동영상/음악 요소를 자동으로 감지하지 못했습니다.', fix: 'Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.' },
  MEDIA_DATA_MISSING: { cause: '생성된 동영상/음악 파일 데이터를 자동으로 확보하지 못했습니다.', fix: 'Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.' },
  SCENE_NOT_FOUND: { cause: '미디어를 연결할 대상 장면을 프로젝트에서 찾을 수 없습니다.', fix: '스토리보드에서 장면 목록을 확인한 뒤 다시 시도해 주세요.' },
  EMPTY_IMAGE_PROMPT: { cause: '이 장면의 이미지 생성 프롬프트가 비어 있습니다.', fix: '생성 프롬프트 단계에서 해당 장면의 이미지 프롬프트를 먼저 생성하거나 입력해 주세요.' },
  EMPTY_VIDEO_PROMPT: { cause: '이 장면의 동영상 생성 프롬프트가 비어 있습니다.', fix: '생성 프롬프트 단계의 고급 설정에서 동영상 프롬프트를 먼저 입력해 주세요.' },
  EMPTY_BGM_PROMPT: { cause: '작품의 배경음악 프롬프트(bgmPrompt)가 비어 있습니다.', fix: '생성 프롬프트 단계에서 프롬프트를 먼저 생성해 주세요.' },
  TOOL_MODE_SELECT_FAILED: { cause: 'Gemini 입력창에서 동영상/음악 만들기 도구를 자동으로 켜지 못했습니다.', fix: 'Gemini 탭에서 입력창 왼쪽 `+`를 눌러 `동영상 만들기` 또는 `음악 만들기`를 직접 선택한 뒤 「다시 시도」를 눌러 주세요.' },
  TOOL_MODE_CLEAR_FAILED: { cause: 'Gemini 입력창에 켜져 있던 동영상/이미지/음악 도구를 자동으로 끄지 못했습니다.', fix: '입력창 아래 도구 칩의 닫기(X)를 눌러 해제한 뒤 「다시 시도」를 눌러 주세요.' },
  IMAGE_ATTACH_FAILED: { cause: '기준 이미지를 Gemini 입력창에 자동으로 첨부하지 못했습니다.', fix: '이미지를 직접 붙여넣거나 「… → 텍스트만으로 동영상 생성」을 이용해 주세요.' },
  ORIGINAL_TEXT_MISSING: { cause: '제미나이 응답에서 작품 원문을 찾지 못했습니다.', fix: 'Gemini 탭의 답변을 확인한 뒤 다시 시도하거나, 파일을 첨부하거나 본문을 직접 붙여넣어 주세요.' }
};


export function guideFor(job: GeminiJobRecord | null | undefined): { cause: string; fix: string } | null {
  if (!job || !job.errorCode) return null;
  return ERROR_GUIDE[job.errorCode] || { cause: job.errorMessage || job.errorCode, fix: 'Gemini 화면과 연결 상태를 확인한 뒤 다시 시도하거나 수동 연결을 사용해 주세요.' };
}
