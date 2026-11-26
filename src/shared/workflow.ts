import type { AIRecords, AIStage, AnalysisResult, Assembly, Brief, Choice, EditClip, EditPlanResult, Genre, MediaAsset, ProjectSummary, PromptsResult, Scene, StageRecord, StudioProject, StoryboardResult, VisualBible } from './types';
import { TRANSITION_XFADE, fitShots, normalizeSceneEffects, parseSceneEffects, parseTransition, timeCaptions, type MotionType, type SceneEffects, type Shot, type TimedCaption, type TransitionType } from './effects';
import { INTERNAL } from './brand';
import { clearStageReviewFlag } from './original-versioning';

export const GENRES: Record<Genre, string> = { bible: '성경', poetry: '시', essay: '에세이', novel: '소설', classic: '고전' };
export const AUDIENCES = { preschool: '유아', kids: '어린이', teens: '청소년', adult: '성인', family: '가족' } as const;
export const STAGE_NAMES = { brief: '작품 등록', analysis: '기획 분석', storyboard: '스토리보드', prompt: '생성 프롬프트', media: '미디어 제작', assembly: '최종 편집안', handoff: '더빙 전달' } as const;
export const STAGE_ORDER = ['brief', 'analysis', 'storyboard', 'prompt', 'media', 'assembly', 'handoff'] as const;
const now = () => new Date().toISOString();
const emptyStage = (): StageRecord => ({ status: 'idle', raw: '', updatedAt: null });
export const DEFAULT_BRIEF: Brief = { genre: 'bible', audience: 'kids', title: '', author: '', source: '', sourceUrl: '', originalText: '', rightsStatus: 'unreviewed', targetDuration: 120, aspectRatio: '16:9', bibleTranslation: 'NKRV' };
export function makeProject(id: string, input: Brief, timestamp = now()): StudioProject {
  return { schema: INTERNAL.projectSchema, id, revision: 1, createdAt: timestamp, updatedAt: timestamp, archived: false,
    brief: { ...input }, selection: { styleId: '', directionId: '' }, analysis: null, scenes: [], assets: [],
    ai: { analysis: emptyStage(), storyboard: emptyStage(), prompt: emptyStage(), editplan: emptyStage() },
    assembly: { clips: [], subtitleMode: 'original', transitionDefault: 'fade', bgmAssetId: null },
    originalHistory: [] };
}
/** 「새 작품」을 누르면 바로 만들어지는 빈 작품의 기본값 */
export const NEW_DRAFT_BRIEF: Brief = { ...DEFAULT_BRIEF, genre: 'poetry' };
export const UNTITLED = '제목 없는 작품';
export function summarize(p: StudioProject): ProjectSummary {
  return { id: p.id, title: p.brief.title.trim() || UNTITLED, genre: p.brief.genre, audience: p.brief.audience, updatedAt: p.updatedAt, createdAt: p.createdAt, sceneCount: p.scenes.length, mediaCount: p.assets.length, archived: p.archived, draft: !stageComplete(p, 'brief') };
}
/** 아무것도 입력하지 않은 빈 작품인가 (이럴 때만 자동으로 지움) */
export function isEmptyDraft(p: StudioProject): boolean {
  const b = p.brief;
  return !b.title.trim() && !b.originalText.trim() && !b.author.trim() && !b.source.trim() && !b.sourceUrl.trim()
    && !b.originalMeta && !p.analysis && p.scenes.length === 0 && p.assets.length === 0
    && !(p.originalHistory && p.originalHistory.length) && !p.archived;
}
function isRecord(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
function str(x: unknown, label: string): string { if (typeof x !== 'string' || !x.trim()) throw Error(`${label}: 비어 있거나 문자열이 아닙니다.`); return x.trim(); }
function array(x: unknown, label: string): unknown[] { if (!Array.isArray(x)) throw Error(`${label}: 배열이어야 합니다.`); return x; }
function choiceArray(x: unknown, label: string): Choice[] { const result = array(x, label).map((raw, i) => { if (!isRecord(raw)) throw Error(`${label}[${i}] 형식 오류`); return { id: str(raw.id, `${label}[${i}].id`), label: str(raw.label, `${label}[${i}].label`), description: typeof raw.description === 'string' ? raw.description : '' }; }); if (!result.length) throw Error(`${label} 최소 1개가 필요합니다.`); if (new Set(result.map(c => c.id)).size !== result.length) throw Error(`${label} ID 중복`); return result; }
export function extractJSON(input: string): unknown {
  let text = input.trim();
  if (!text) throw Error('AI 답변이 비어 있습니다.');
  const code = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (code) text = code[1].trim();
  try { return JSON.parse(text); } catch { /* extract a balanced object below */ }
  const first = text.indexOf('{');
  if (first < 0) throw Error('JSON 객체를 찾을 수 없습니다.');
  let depth = 0; let quote = false; let escape = false;
  for (let i = first; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quote = false; continue; }
    if (c === '"') { quote = true; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0 && c === '}') { try { return JSON.parse(text.slice(first, i + 1)); } catch { throw Error('JSON 문법 오류입니다. 코드 블록과 따옴표·쉼표를 확인하세요.'); } }
    // JSON arrays are only supported within a top-level object, per stage schema.
  }
  throw Error('완결된 JSON 객체를 찾을 수 없습니다.');
}
export function validateAnalysis(raw: unknown): AnalysisResult {
  if (!isRecord(raw) || raw.schema !== 'creator.analysis.v1') throw Error('분석 schema는 creator.analysis.v1이어야 합니다.');
  const result: AnalysisResult = { schema: 'creator.analysis.v1', summary: str(raw.summary,'summary'), emotion: str(raw.emotion, 'emotion'), keywords: array(raw.keywords,'keywords').map((v,i)=>str(v,`keywords[${i}]`)), styles: choiceArray(raw.styles,'styles'), directions: choiceArray(raw.directions,'directions'), cautions: Array.isArray(raw.cautions) ? raw.cautions.map(v => String(v)) : [] };
  const arc = strList(raw.emotionArc); if (arc.length) result.emotionArc = arc;
  const bible = parseVisualBible(raw.visualBible); if (bible) result.visualBible = bible;
  return result;
}
function strList(x: unknown): string[] { return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim()) : []; }
const optStr = (x: unknown) => typeof x === 'string' ? x.trim() : '';
/** 스타일 바이블(선택). 내용이 하나도 없으면 undefined */
export function parseVisualBible(x: unknown): VisualBible | undefined {
  if (!isRecord(x)) return undefined;
  const b: VisualBible = { styleSentence: optStr(x.styleSentence), palette: strList(x.palette), lighting: optStr(x.lighting), character: optStr(x.character), avoid: strList(x.avoid), motionStyle: optStr(x.motionStyle) };
  return b.styleSentence || b.palette.length || b.lighting || b.character || b.avoid.length || b.motionStyle ? b : undefined;
}
export function validateStoryboard(raw: unknown): StoryboardResult {
  if (!isRecord(raw) || (raw.schema !== 'creator.storyboard.v1' && raw.schema !== 'creator.storyboard.v2')) throw Error('장면 schema는 creator.storyboard.v2(또는 v1)이어야 합니다.');
  const scenes = array(raw.scenes,'scenes').map((r, i) => { if (!isRecord(r)) throw Error(`scenes[${i}] 형식 오류`); const durationSec = Number(r.durationSec); if (!Number.isFinite(durationSec) || durationSec < 2 || durationSec > 300) throw Error(`scenes[${i}].durationSec는 2~300초여야 합니다.`);
    const kind = r.kind === 'video' ? 'video' as const : 'image' as const;
    const fxSource = isRecord(r.effects) ? r.effects : r;
    const effects = parseSceneEffects(fxSource, kind);
    const scene = { id: str(r.id,`scenes[${i}].id`), title: str(r.title,`scenes[${i}].title`), narration: str(r.narration,`scenes[${i}].narration`), visual: str(r.visual,`scenes[${i}].visual`), durationSec, kind,
      ...(Object.keys(effects).length ? { effects } : {}), ...(typeof r.mood === 'string' && r.mood.trim() ? { mood: r.mood.trim() } : {}) };
    return scene; });
  if (!scenes.length) throw Error('장면이 최소 1개 필요합니다.');
  if (new Set(scenes.map(x=>x.id)).size !== scenes.length) throw Error('장면 ID가 중복됩니다.');
  return { schema: raw.schema === 'creator.storyboard.v1' ? 'creator.storyboard.v1' : 'creator.storyboard.v2', scenes };
}
/** 모든 장면의 효과를 완성(빈 항목 자동 채움·샷 길이 맞춤·자막 줄 원문 대조). 이미 채운 값은 유지 */
export function withSceneEffects(p: StudioProject, opts: { regenerate?: boolean } = {}): StudioProject {
  let prev: MotionType | undefined;
  const scenes = p.scenes.map((s, i) => {
    const effects = normalizeSceneEffects(opts.regenerate ? { ...s, effects: { captions: s.effects?.captions } } : s, i, p.brief.audience, prev);
    const shots = effects.shots || [];
    prev = shots.length ? shots[shots.length - 1].motion : prev;
    return { ...s, effects };
  });
  return { ...p, scenes };
}
/** 스토리보드 장면 순서·효과로 편집 클립 초안 */
export function clipsFromScenes(p: StudioProject): EditClip[] {
  return p.scenes.map((s, i) => { const t = s.effects?.transitionIn; const type = t?.type || (i === 0 ? 'fade_black' : p.assembly.transitionDefault); return { sceneId: s.id, durationSec: s.durationSec, transition: type, transitionSec: t ? t.durationSec : (type === 'cut' ? 0 : 1) }; });
}
export function validatePrompts(raw: unknown, scenes: Scene[]): PromptsResult {
  if (!isRecord(raw) || raw.schema !== 'creator.prompts.v1') throw Error('프롬프트 schema는 creator.prompts.v1이어야 합니다.');
  const items = array(raw.items, 'items').map((r,i)=> { if(!isRecord(r)) throw Error(`items[${i}] 형식 오류`); return { sceneId: str(r.sceneId,`items[${i}].sceneId`), imagePrompt: str(r.imagePrompt,`items[${i}].imagePrompt`), videoPrompt: typeof r.videoPrompt === 'string' ? r.videoPrompt : '', negativePrompt: typeof r.negativePrompt === 'string' ? r.negativePrompt : '' }; });
  if (items.length !== scenes.length || new Set(items.map(x => x.sceneId)).size !== items.length || items.some(x => !scenes.some(s => s.id === x.sceneId))) throw Error('프롬프트 items는 장면 ID와 정확히 1:1로 대응해야 합니다.');
  return { schema: 'creator.prompts.v1', items, bgmPrompt: typeof raw.bgmPrompt === 'string' ? raw.bgmPrompt : '' };
}
export function validateEditPlan(raw: unknown, scenes: Scene[]): EditPlanResult {
  if (!isRecord(raw) || raw.schema !== 'creator.editplan.v1') throw Error('편집안 schema는 creator.editplan.v1이어야 합니다.');
  const clips = array(raw.clips,'clips').map((r,i)=> { if(!isRecord(r)) throw Error(`clips[${i}] 형식 오류`); const sceneId = str(r.sceneId,`clips[${i}].sceneId`); const durationSec = Number(r.durationSec); if(!scenes.some(s=>s.id===sceneId)) throw Error(`존재하지 않는 장면: ${sceneId}`); if(!Number.isFinite(durationSec)||durationSec<1||durationSec>600) throw Error(`clips[${i}].durationSec 오류`); const transition = parseTransition(r.transition); if(!transition) throw Error(`clips[${i}].transition 오류`); const ts = Number(r.transitionSec); return { sceneId, durationSec, transition, ...(Number.isFinite(ts) ? { transitionSec: Math.min(3, Math.max(0, ts)) } : {}) }; });
  if (!clips.length) throw Error('편집 클립이 필요합니다.');
  return { schema: 'creator.editplan.v1', clips, notes: typeof raw.notes==='string' ? raw.notes : '' };
}
/** Purposely no global state. Apply a validated AI response to a copy of one project. */
export function applyAIResponse(project: StudioProject, stage: AIStage, answer: string): StudioProject {
  const result = extractJSON(answer); const p: StudioProject = structuredClone(project);
  if (stage === 'analysis') { const analysis=validateAnalysis(result); p.analysis=analysis; p.selection={styleId:'',directionId:''}; p.scenes=[]; p.ai.storyboard=emptyStage(); p.ai.prompt=emptyStage(); p.ai.editplan=emptyStage(); p.assembly.clips=[]; }
  if (stage === 'storyboard') { if(!p.analysis || !p.selection.styleId || !p.selection.directionId) throw Error('화풍과 연출안을 먼저 승인하세요.'); const story=validateStoryboard(result);
    const normalize=(t:string)=>t.replace(/\s+/g,'').replace(/[“”‘’]/g,'');
    const original=normalize(p.brief.originalText);
    const mismatch=story.scenes.find(s=>!original.includes(normalize(s.narration)));
    if(mismatch)throw Error(`${mismatch.id} 낭독 문장이 등록된 원문과 정확히 일치하지 않습니다. 원문을 임의로 변경하지 마세요.`);
    const byId = new Map(p.scenes.map(s=>[s.id,s])); p.scenes=story.scenes.map(s => { const previous=byId.get(s.id);
      const same=!!previous&&previous.narration===s.narration&&previous.visual===s.visual&&previous.kind===s.kind;
      return {...s,imagePrompt:same?previous!.imagePrompt:'',videoPrompt:same?previous!.videoPrompt:'',negativePrompt:same?previous!.negativePrompt:'',assetId:same?previous!.assetId:null,referenceImageAssetId:same?previous!.referenceImageAssetId:null,status:same?previous!.status:'draft'}; });
    const effected = withSceneEffects(p); p.scenes = effected.scenes; p.ai.prompt=emptyStage(); p.ai.editplan=emptyStage(); p.assembly.clips=[]; }
  if (stage === 'prompt') { const prompts=validatePrompts(result,p.scenes); const map=new Map(prompts.items.map(x=>[x.sceneId,x])); p.scenes=p.scenes.map(s=> ({...s,...{ imagePrompt:map.get(s.id)?.imagePrompt||'',videoPrompt:map.get(s.id)?.videoPrompt||'',negativePrompt:map.get(s.id)?.negativePrompt||''},status:'ready'})); p.bgmPrompt=prompts.bgmPrompt||''; }
  if (stage === 'editplan') { const plan=validateEditPlan(result,p.scenes); p.assembly.clips=plan.clips; }
  p.ai[stage]={ raw:answer, updatedAt:now(), status:'approved' };
  p.reviewNeeded = clearStageReviewFlag(p, stage);
  return p;
}
/** 장면 종류(스토리보드에서 정한 이미지/영상)에 맞는 생성 프롬프트 — 영상 장면은 videoPrompt, 이미지 장면은 imagePrompt */
export function scenePrimaryPrompt(s:Pick<Scene,'kind'|'imagePrompt'|'videoPrompt'>):string { return ((s.kind==='video'?s.videoPrompt:s.imagePrompt)||'').trim(); }
export function stageComplete(p:StudioProject,stage: keyof typeof STAGE_NAMES): boolean {
  if(stage==='brief')return !!p.brief.title.trim() && !!p.brief.originalText.trim();
  if(stage==='analysis')return !!p.analysis && !!p.selection.styleId && !!p.selection.directionId;
  if(stage==='storyboard')return p.scenes.length>0;
  if(stage==='prompt')return p.scenes.length>0 && p.scenes.every(x=>!!scenePrimaryPrompt(x));
  if(stage==='media')return p.scenes.length>0 && p.scenes.every(s=>!!s.assetId && p.assets.some(a=>a.id===s.assetId));
  if(stage==='assembly')return p.assembly.clips.length>0;
  return stageComplete(p,'assembly') && stageComplete(p,'media');
}
export function readyForHandoff(p:StudioProject): {ready:boolean; warnings:string[]} {
  const warnings:string[]=[];
  if(!stageComplete(p,'brief'))warnings.push('원문과 작품 제목이 비어 있습니다.');
  if(!p.scenes.length)warnings.push('스토리보드 장면이 없습니다.');
  const missing=p.scenes.filter(s=> !s.assetId || !p.assets.some(a=>a.id===s.assetId));
  if(missing.length)warnings.push(`미디어 미연결 장면 ${missing.length}개가 있습니다.`);
  if(!p.assembly.clips.length)warnings.push('최종 편집안이 없습니다.');
  if(p.reviewNeeded && (p.reviewNeeded.analysis || p.reviewNeeded.storyboard || p.reviewNeeded.prompt || p.reviewNeeded.editplan || p.reviewNeeded.subtitles)) {
    warnings.push('기준 원문이 변경되어 재검토가 필요한 후속 단계가 남아 있습니다.');
  }
  return {ready:warnings.length===0,warnings};
}
export function toHandoff(p:StudioProject) {
  return { schema: INTERNAL.handoffSchema, createdAt: now(), projectId: p.id, title: p.brief.title, genre: p.brief.genre, audience: p.brief.audience, originalText: p.brief.originalText, output: { ratio: p.brief.aspectRatio },
    scenes: p.scenes.map(s=> ({ id:s.id,title:s.title,narration:s.narration,visual:s.visual,durationSec:s.durationSec,mood:s.mood||'',effects:s.effects||null,asset:s.assetId? p.assets.find(a=>a.id===s.assetId)?.relativePath || null:null })),
    assembly: p.assembly, media: p.assets.map(a=>({id:a.id,kind:a.kind,path:a.relativePath,name:a.name})), note: 'GOMO 제작 패키지입니다. 기존 knhanul/dubbing의 native project.json과는 다른 중간 교환 규격이며, 직접 열기 변환 어댑터는 후속 구현이 필요합니다.' };
}

/** 타임라인의 한 장면 구간 (편집안 클립 1개) */
export interface TimelineSegment {
  sceneId: string; title: string; start: number; end: number; durationSec: number;
  transition: TransitionType; transitionSec: number;
  shots: (Shot & { start: number; end: number })[];
  captions: TimedCaption[];
  effects: SceneEffects;
}
/**
 * 편집안 클립 순서대로 장면 효과를 펼친 타임라인 (UI 미리보기·composer 내보내기 공용).
 * 클립 길이가 장면 길이와 다르면 샷·자막을 클립 길이에 맞춰 다시 배분한다. 시간은 모두 절대 초.
 */
export function buildTimeline(p: StudioProject): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  let cursor = 0; let prev: MotionType | undefined;
  p.assembly.clips.forEach((c) => {
    const index = p.scenes.findIndex(s => s.id === c.sceneId);
    const scene = p.scenes[index];
    if (!scene) return;
    const effects = normalizeSceneEffects({ ...scene, durationSec: c.durationSec, effects: scene.effects ? { ...scene.effects, shots: scene.effects.shots ? fitShots(scene.effects.shots, c.durationSec) : undefined } : undefined }, index, p.brief.audience, prev);
    const shots = effects.shots || [];
    prev = shots.length ? shots[shots.length - 1].motion : prev;
    let t = cursor;
    const timedShots = shots.map(sh => { const start = t; t += sh.durationSec; return { ...sh, start: round2(start), end: round2(t) }; });
    const captions = p.assembly.subtitleMode === 'original'
      ? timeCaptions(effects.captions || [], c.durationSec).map(x => ({ ...x, start: round2(cursor + x.start), end: round2(cursor + x.end) }))
      : [];
    const transitionSec = c.transition === 'cut' ? 0 : (c.transitionSec ?? effects.transitionIn?.durationSec ?? 1);
    out.push({ sceneId: scene.id, title: scene.title, start: round2(cursor), end: round2(cursor + c.durationSec), durationSec: c.durationSec, transition: c.transition, transitionSec, shots: timedShots, captions, effects });
    cursor += c.durationSec;
  });
  return out;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 편집기(composer)에 넘기는 효과 규격 설명 — 편집실에서 구현할 필드 */
export const COMPOSER_EFFECTS_SPEC = {
  name: 'gomo.effects.v1',
  clip_fields: {
    motion: 'static | zoom_in | zoom_out | pan_left | pan_right | pan_up | pan_down | focus_in | focus_out | drift — 이미지 클립의 카메라 움직임(켄 번스)',
    motion_strength: '0~0.3. 확대 비율(1+strength) 또는 화면 폭 대비 이동 거리',
    motion_focus: '{x,y} 0~1. focus_in/focus_out/zoom이 향하는 지점(왼쪽 위 기준)',
    overlay: 'none | light_rays | glow | sparkle | dust | petals | snow | rain | fog | stars | fireflies | vignette — 화면 위에 얹는 분위기 효과',
    overlay_strength: '0~1',
    tone: 'none | warm | cool | golden | dusk | night | bright | sepia | mono — 색감 보정',
    'transition.type': 'none·fade·dissolve·fadeblack·fadewhite·wipeleft·wiperight·slideleft·slideright·slideup·zoomin·circleopen·hblur (FFmpeg xfade 이름)',
    scene_id: '같은 장면(같은 미디어)에서 나뉜 샷은 같은 scene_id를 가진다',
    shot_index: '장면 안 샷 순서(0부터)'
  },
  note: '편집기가 아직 모르는 필드는 무시해도 영상은 만들어진다(움직임 없이). 같은 장면의 샷 사이 전환은 짧은 fade로 이어 붙인다.'
};

/** Draft export for knhanul/dubbing v2. Must be integration-tested against the user's installed composer. */
export function toComposerDraft(p:StudioProject): {project:Record<string,unknown>; srt:string}|null {
  if (!p.assembly.clips.length)return null;
  type ComposerClip={file:string;type:'image'|'video';duration?:number;fit_duration?:number;mute?:boolean;label?:string;scene_id:string;shot_index:number;
    motion?:string;motion_strength?:number;motion_focus?:{x:number;y:number};overlay?:string;overlay_strength?:number;tone?:string;
    transition:{type:string;duration:number;effect?:string}};
  const clips:ComposerClip[]=[];
  const subtitles:{index:number;start:number;end:number;text:string}[]=[];
  for(const c of p.assembly.clips){
    const scene=p.scenes.find(s=>s.id===c.sceneId);
    const asset=scene?.assetId?p.assets.find(a=>a.id===scene.assetId):undefined;
    if(!scene||!asset||(asset.kind!=='image'&&asset.kind!=='video'))return null;
  }
  const timeline=buildTimeline(p);
  for(const seg of timeline){
    const scene=p.scenes.find(s=>s.id===seg.sceneId)!;
    const asset=p.assets.find(a=>a.id===scene.assetId)!;
    const still=scene.referenceImageAssetId?p.assets.find(a=>a.id===scene.referenceImageAssetId&&a.kind==='image'):undefined;
    // 영상 장면의 정지 구간은 기준 이미지가 있을 때만. 없으면 그 시간을 영상 구간에 합친다.
    let shots=seg.shots;
    if(asset.kind==='video'){
      if(!still)shots=[{...shots[0],durationSec:seg.durationSec,motion:'static',strength:0,source:'video',start:seg.start,end:seg.end}];
    } else shots=shots.map(sh=>({...sh,source:'image' as const}));
    const fx=seg.effects;
    shots.forEach((sh,k)=>{
      const first=k===0;
      const tType:TransitionType=first?seg.transition:'fade';
      const tDur=first?seg.transitionSec:Math.min(.5,sh.durationSec/4);
      const isVideo=sh.source==='video'&&asset.kind==='video';
      const file=isVideo?asset.relativePath:(asset.kind==='image'?asset.relativePath:still!.relativePath);
      const item:ComposerClip={file,type:isVideo?'video':'image',label:shots.length>1?`${scene.title} (${k+1}/${shots.length})`:scene.title,scene_id:scene.id,shot_index:k,
        transition:{type:TRANSITION_XFADE[tType],duration:tType==='cut'?0:Math.round(tDur*100)/100,effect:tType}};
      if(isVideo){item.fit_duration=Math.round(sh.durationSec*100)/100;item.mute=true;}
      else {item.duration=Math.round(sh.durationSec*100)/100;item.motion=sh.motion;item.motion_strength=sh.strength;if(sh.focus)item.motion_focus=sh.focus;}
      if(fx.overlay&&fx.overlay!=='none'){item.overlay=fx.overlay;item.overlay_strength=fx.overlayStrength??.5;}
      if(fx.tone&&fx.tone!=='none')item.tone=fx.tone;
      clips.push(item);
    });
    for(const cap of seg.captions)subtitles.push({index:subtitles.length+1,start:cap.start,end:cap.end,text:cap.text});
  }
  const size=p.brief.aspectRatio==='9:16'?{width:1080,height:1920}:p.brief.aspectRatio==='1:1'?{width:1080,height:1080}:{width:1920,height:1080};
  const music=p.assets.find(a=>a.id===p.assembly.bgmAssetId&&a.kind==='audio');
  const project:Record<string,unknown>={version:2,title:p.brief.title,output:{...size,fps:30,fit:'cover',file:'output.mp4'},transition:{type:'crossfade',duration:.5},
    effects_spec:COMPOSER_EFFECTS_SPEC.name,clips,
    subtitle:{file:'captions.srt',burn_in:true,offset:0,items:subtitles,style:{font:'Malgun Gothic',size:52,color:'#FFFFFF',outline:2.5,position:'bottom',margin_v:70}},
    ...(music?{bgm:{file:music.relativePath,volume:.25,fade_in:1,fade_out:2,loop:true,duck_under_voice:true}}:{}),dubbing:{folder:'takes',takes:[]}};
  const hhmmss=(sec:number)=>{const ms=Math.max(0,Math.round(sec*1000));const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),remainder=ms%1000;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(remainder).padStart(3,'0')}`;};
  const srt=subtitles.map(s=>`${s.index}\n${hhmmss(s.start)} --> ${hhmmss(s.end)}\n${s.text}`).join('\n\n')+'\n';
  return {project,srt};
}
