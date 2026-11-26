import type { AIRecords, AIStage, AnalysisResult, Assembly, Brief, Choice, EditClip, EditPlanResult, Genre, MediaAsset, ProjectSummary, PromptsResult, Scene, StageRecord, StudioProject, StoryboardResult } from './types';
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
  return { schema: 'creator.analysis.v1', summary: str(raw.summary,'summary'), emotion: str(raw.emotion, 'emotion'), keywords: array(raw.keywords,'keywords').map((v,i)=>str(v,`keywords[${i}]`)), styles: choiceArray(raw.styles,'styles'), directions: choiceArray(raw.directions,'directions'), cautions: Array.isArray(raw.cautions) ? raw.cautions.map(v => String(v)) : [] };
}
export function validateStoryboard(raw: unknown): StoryboardResult {
  if (!isRecord(raw) || raw.schema !== 'creator.storyboard.v1') throw Error('장면 schema는 creator.storyboard.v1이어야 합니다.');
  const scenes = array(raw.scenes,'scenes').map((r, i) => { if (!isRecord(r)) throw Error(`scenes[${i}] 형식 오류`); const durationSec = Number(r.durationSec); if (!Number.isFinite(durationSec) || durationSec < 2 || durationSec > 300) throw Error(`scenes[${i}].durationSec는 2~300초여야 합니다.`); return { id: str(r.id,`scenes[${i}].id`), title: str(r.title,`scenes[${i}].title`), narration: str(r.narration,`scenes[${i}].narration`), visual: str(r.visual,`scenes[${i}].visual`), durationSec, kind: r.kind === 'video' ? 'video' as const : 'image' as const }; });
  if (!scenes.length) throw Error('장면이 최소 1개 필요합니다.');
  if (new Set(scenes.map(x=>x.id)).size !== scenes.length) throw Error('장면 ID가 중복됩니다.');
  return { schema: 'creator.storyboard.v1', scenes };
}
export function validatePrompts(raw: unknown, scenes: Scene[]): PromptsResult {
  if (!isRecord(raw) || raw.schema !== 'creator.prompts.v1') throw Error('프롬프트 schema는 creator.prompts.v1이어야 합니다.');
  const items = array(raw.items, 'items').map((r,i)=> { if(!isRecord(r)) throw Error(`items[${i}] 형식 오류`); return { sceneId: str(r.sceneId,`items[${i}].sceneId`), imagePrompt: str(r.imagePrompt,`items[${i}].imagePrompt`), videoPrompt: typeof r.videoPrompt === 'string' ? r.videoPrompt : '', negativePrompt: typeof r.negativePrompt === 'string' ? r.negativePrompt : '' }; });
  if (items.length !== scenes.length || new Set(items.map(x => x.sceneId)).size !== items.length || items.some(x => !scenes.some(s => s.id === x.sceneId))) throw Error('프롬프트 items는 장면 ID와 정확히 1:1로 대응해야 합니다.');
  return { schema: 'creator.prompts.v1', items, bgmPrompt: typeof raw.bgmPrompt === 'string' ? raw.bgmPrompt : '' };
}
export function validateEditPlan(raw: unknown, scenes: Scene[]): EditPlanResult {
  if (!isRecord(raw) || raw.schema !== 'creator.editplan.v1') throw Error('편집안 schema는 creator.editplan.v1이어야 합니다.');
  const clips = array(raw.clips,'clips').map((r,i)=> { if(!isRecord(r)) throw Error(`clips[${i}] 형식 오류`); const sceneId = str(r.sceneId,`clips[${i}].sceneId`); const durationSec = Number(r.durationSec); if(!scenes.some(s=>s.id===sceneId)) throw Error(`존재하지 않는 장면: ${sceneId}`); if(!Number.isFinite(durationSec)||durationSec<1||durationSec>600) throw Error(`clips[${i}].durationSec 오류`); const transition = r.transition; if(transition!=='cut'&&transition!=='fade'&&transition!=='dissolve') throw Error(`clips[${i}].transition 오류`); return { sceneId, durationSec, transition: transition as EditClip['transition'] }; });
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
      return {...s,imagePrompt:same?previous!.imagePrompt:'',videoPrompt:same?previous!.videoPrompt:'',negativePrompt:same?previous!.negativePrompt:'',assetId:same?previous!.assetId:null,status:same?previous!.status:'draft'}; }); p.ai.prompt=emptyStage(); p.ai.editplan=emptyStage(); p.assembly.clips=[]; }
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
    scenes: p.scenes.map(s=> ({ id:s.id,title:s.title,narration:s.narration,visual:s.visual,durationSec:s.durationSec,asset:s.assetId? p.assets.find(a=>a.id===s.assetId)?.relativePath || null:null })),
    assembly: p.assembly, media: p.assets.map(a=>({id:a.id,kind:a.kind,path:a.relativePath,name:a.name})), note: 'GOMO 제작 패키지입니다. 기존 knhanul/dubbing의 native project.json과는 다른 중간 교환 규격이며, 직접 열기 변환 어댑터는 후속 구현이 필요합니다.' };
}

/** Draft export for knhanul/dubbing v2. Must be integration-tested against the user's installed composer. */
export function toComposerDraft(p:StudioProject): {project:Record<string,unknown>; srt:string}|null {
  if (!p.assembly.clips.length)return null;
  type ComposerClip={file:string;type:'image'|'video';duration?:number;fit_duration?:number;mute?:boolean;label?:string;transition:{type:string;duration:number}};
  const clips:ComposerClip[]=[];
  const subtitles:{index:number;start:number;end:number;text:string}[]=[];
  let cursor=0;
  for(const c of p.assembly.clips){
    const scene=p.scenes.find(s=>s.id===c.sceneId);
    const asset=scene?.assetId?p.assets.find(a=>a.id===scene.assetId):undefined;
    if(!scene||!asset||(asset.kind!=='image'&&asset.kind!=='video'))return null;
    const transition=c.transition==='cut'?'none':c.transition==='fade'?'fade':'dissolve';
    const item:ComposerClip={file:asset.relativePath,type:asset.kind,label:scene.title,transition:{type:transition,duration:transition==='none'?0:Math.min(.5,c.durationSec/4)}};
    if(asset.kind==='image')item.duration=c.durationSec;
    else {item.fit_duration=c.durationSec;item.mute=true;}
    clips.push(item);
    if(p.assembly.subtitleMode==='original'&&scene.narration.trim())subtitles.push({index:subtitles.length+1,start:cursor,end:cursor+c.durationSec,text:scene.narration});
    cursor+=c.durationSec;
  }
  const size=p.brief.aspectRatio==='9:16'?{width:1080,height:1920}:p.brief.aspectRatio==='1:1'?{width:1080,height:1080}:{width:1920,height:1080};
  const music=p.assets.find(a=>a.id===p.assembly.bgmAssetId&&a.kind==='audio');
  const project:Record<string,unknown>={version:2,title:p.brief.title,output:{...size,fps:30,fit:'cover',file:'output.mp4'},transition:{type:'crossfade',duration:.5},clips,
    subtitle:{file:'captions.srt',burn_in:true,offset:0,items:subtitles,style:{font:'Malgun Gothic',size:52,color:'#FFFFFF',outline:2.5,position:'bottom',margin_v:70}},
    ...(music?{bgm:{file:music.relativePath,volume:.25,fade_in:1,fade_out:2,loop:true,duck_under_voice:true}}:{}),dubbing:{folder:'takes',takes:[]}};
  const hhmmss=(sec:number)=>{const ms=Math.max(0,Math.round(sec*1000));const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),remainder=ms%1000;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(remainder).padStart(3,'0')}`;};
  const srt=subtitles.map(s=>`${s.index}\n${hhmmss(s.start)} --> ${hhmmss(s.end)}\n${s.text}`).join('\n\n')+'\n';
  return {project,srt};
}
