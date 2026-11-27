import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useTheme} from './theme/useTheme';
import {THEME_META, THEMES, type ThemeId} from './theme/themes';
import {
  Archive, ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, CheckCircle2,
  ChevronDown, Clapperboard, MoreHorizontal, Clock3, Copy, Feather, Film, FolderOpen, FolderInput, HardDriveDownload, Home, Image as ImageIcon, Info,
  Landmark, Layers3, LayoutGrid, ListOrdered, Mic2, MonitorPlay, Music2, NotebookPen, Palette,
  PenLine, Plus, RotateCcw, ScrollText, Search, Settings2, ShieldAlert, Sparkles, Trash2, Upload,
  WandSparkles, X
} from 'lucide-react';
import {BRAND} from '../shared/brand';
import brandLogo from './assets/brand-logo.svg?url';
import {AUDIENCES,GENRES,NEW_DRAFT_BRIEF,STAGE_ORDER,UNTITLED,buildTimeline,clipsFromScenes,isEmptyDraft,readyForHandoff,stageComplete,withSceneEffects} from '../shared/workflow';
import {TRANSITION_LABEL,TRANSITION_TYPES,describeShots,type TransitionType} from '../shared/effects';
import {EffectsEditor,EffectsSummary} from './components/EffectsEditor';
import {AI_STAGES,ERROR_GUIDE,PHASE_LABEL,STAGE_META,getProjectBgmPrompt,guideFor,isAIStage,makeImageGenerationPrompt,makeMusicGenerationPrompt,makeVideoGenerationPrompt,phaseView} from '../shared/gemini-analysis';
import {findSceneReferenceImage} from '../shared/reference-image';
import type {AIStage,Brief,Genre,MediaAsset,ProjectSummary,Scene,Stage,StudioProject,EditClip,GeminiJobRecord} from '../shared/types';
import {useStudio} from './hooks/useStudio';
import {AIDock,type AINavTarget} from './components/AIDialog';
import {type ApprovedOriginalPayload} from './components/OriginalSourcePanel';
import {RIGHTS_STATUS_META} from '../shared/copyright';
import {approveOriginalInProject} from '../shared/original-versioning';
import {applyBriefAutosave} from '../shared/brief-edit';
import {notifiedError} from '../shared/brief-autosave';
import {STEP_TITLES,TOTAL_STEPS,completedSteps,stepGuide} from '../shared/step-guide';
import {Button,Card,Empty,Field,IconButton,Tag} from './components/UI';
import {ActionBar,DocHeader,SAVE_LABEL,StepLayout,type SaveState} from './components/Shell';
import {ProjectPropsPanel} from './components/ProjectPanel';
import {BriefPage,type BriefFlush} from './pages/BriefPage';

const EMPTY_STAGE_JOBS:Record<AIStage,GeminiJobRecord|null>={analysis:null,storyboard:null,prompt:null,editplan:null};
const STAGE_DONE_FLASH:Record<AIStage,string>={
  analysis:'Gemini 기획 분석 결과를 검사하고 작품에 저장했습니다. 화풍과 연출안을 선택하세요.',
  storyboard:'Gemini 장면 구성 결과를 검사하고 스토리보드에 저장했습니다.',
  prompt:'Gemini 생성 프롬프트를 검사하고 장면별로 저장했습니다.',
  editplan:'Gemini 최종 편집 구성을 검사하고 편집안에 저장했습니다.'
};
const stageHasResult=(p:StudioProject,st:AIStage)=>st==='analysis'?!!p.analysis:st==='storyboard'?p.scenes.length>0:st==='prompt'?p.scenes.some(s=>!!s.imagePrompt||!!s.videoPrompt):p.assembly.clips.length>0;

type View = 'home'|'projects'|'brief'|'analysis'|'storyboard'|'prompt'|'media'|'assembly'|'handoff'|'settings';
const STEP_VIEWS:Stage[]=['brief','analysis','storyboard','prompt','media','assembly','handoff'];
const isStepView=(v:View):v is Stage=>(STEP_VIEWS as string[]).includes(v);
const iconFor:Record<string,typeof Home>={home:Home,projects:Layers3,brief:BookOpen,analysis:Sparkles,storyboard:LayoutGrid,prompt:WandSparkles,media:ImageIcon,assembly:Clapperboard,handoff:HardDriveDownload,settings:Settings2};
const STAGE_HINTS:Record<Stage,string>={
  brief:'원문을 찾아 채우거나 직접 입력해 제작 기준 원문을 정합니다.',
  analysis:'작품의 분위기와 시각적 방향을 정합니다. 원하는 화풍과 연출안을 직접 선택하세요.',
  storyboard:'장면별 원문과 시각 연출을 구성하고, 개별 장면을 수정할 수 있습니다.',
  prompt:'이미지와 동영상 생성 지시문을 장면별로 관리합니다. 내용은 직접 수정할 수도 있습니다.',
  media:'장면별 이미지·동영상과 배경음악을 Gemini로 만들거나 파일을 가져와 연결합니다.',
  assembly:'미디어 배치, 재생 시간, 전환과 자막을 설계합니다. 녹음은 더빙 프로그램에서 합니다.',
  handoff:'미디어·기획·편집안이 들어 있는 제작 패키지를 내보냅니다.'
};
const GENRE_TILES:{genre:Genre,icon:typeof Home,desc:string}[]=[
  {genre:'poetry',icon:Feather,desc:'시 한 편을 낭독 영상으로'},
  {genre:'bible',icon:BookOpen,desc:'성경 범위를 골라 바로 본문 채우기'},
  {genre:'essay',icon:NotebookPen,desc:'에세이·수필'},
  {genre:'novel',icon:ScrollText,desc:'소설의 한 장면'},
  {genre:'classic',icon:Landmark,desc:'고전 작품'}
];
const PANEL_KEYS={brief:'creator-props-panel-brief',steps:'creator-props-panel-steps'} as const;
const readPanel=(k:string,def:boolean)=>{try{const v=localStorage.getItem(k);return v===null?def:v==='open';}catch{return def;}};
const formatDate=(d:string)=>new Date(d).toLocaleDateString('ko-KR',{month:'short',day:'numeric'});
const formatTime=(d:string)=>new Date(d).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
const fileSize=(n:number)=>n<1024*1024?`${(n/1024).toFixed(0)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
const mediaUrl=(p:StudioProject,a:MediaAsset)=>`gomo-asset://media/${p.id}/${a.id}`;
const sceneAsset=(p:StudioProject,s:Scene)=>p.assets.find(a=>a.id===s.assetId);
function BrandIcon({size=34}:{size?:number}){return <div className="brand-icon" style={{width:size,height:size}} aria-hidden="true"><img src={brandLogo} alt="" width={size} height={size}/></div>;}
function Photo({project,asset}:{project:StudioProject,asset?:MediaAsset}){
  if(!asset)return <div className="media-placeholder"><ImageIcon size={23}/><span>미디어 미연결</span></div>;
  if(asset.kind==='image')return <img className="media-image" src={mediaUrl(project,asset)} alt={asset.name}/>;
  if(asset.kind==='video')return <video className="media-image" src={mediaUrl(project,asset)} controls preload="metadata"/>;
  return <div className="media-placeholder audio-placeholder"><Music2 size={27}/><span>오디오 파일</span></div>;
}
/** 스토리보드 카드 안에서 바로 고치는 장면 편집 (팝업 없음) */
function SceneEditor({scene,index,isNew,onCancel,onSave}:{scene:Scene,index:number,isNew:boolean,onCancel:()=>void,onSave:(s:Scene)=>void}){
  const [draft,setDraft]=useState(scene);const update=<K extends keyof Scene>(k:K,v:Scene[K])=>setDraft(old=>({...old,[k]:v}));
  const firstRef=useRef<HTMLInputElement>(null);useEffect(()=>{firstRef.current?.focus();firstRef.current?.select();},[]);
  return <div className="scene-editor" onKeyDown={e=>{if(e.key==='Escape')onCancel();}}>
    <div className="form-row"><Field label="장면 제목"><input ref={firstRef} value={draft.title} onChange={e=>update('title',e.target.value)}/></Field><Field label="권장 유형"><select value={draft.kind} onChange={e=>update('kind',e.target.value as Scene['kind'])}><option value="image">이미지</option><option value="video">동영상</option></select></Field></div>
    <Field label="예상 재생 시간 (초)"><input type="number" min={2} max={300} value={draft.durationSec} onChange={e=>update('durationSec',Math.max(2,Number(e.target.value)||2))}/></Field>
    <Field label="낭독 원문"><textarea rows={3} value={draft.narration} onChange={e=>update('narration',e.target.value)} placeholder="이 장면에서 읽을 원문"/></Field>
    <Field label="장면 묘사"><textarea rows={3} value={draft.visual} onChange={e=>update('visual',e.target.value)} placeholder="화면에 보일 모습"/></Field>
    <EffectsEditor scene={draft} index={index} onChange={fx=>update('effects',fx)}/>
    {!isNew&&<p className="muted-text scene-editor-note">원문·묘사·유형을 바꾸면 이 장면의 프롬프트와 연결된 미디어를 다시 만들어야 해요.</p>}
    <div className="scene-editor-actions"><Button kind="secondary" size="sm" onClick={onCancel}>취소</Button><Button size="sm" onClick={()=>onSave(draft)} disabled={!draft.title.trim()}><Check size={14}/> {isNew?'장면 추가':'저장'}</Button></div>
  </div>;
}

/** 장면 종류 표시: 스토리보드에서 정한 이미지/영상 */
function KindBadge({kind}:{kind:'image'|'video'}){return <span className={`kind-badge kind-${kind}`}>{kind==='video'?<Film size={12}/>:<ImageIcon size={12}/>} {kind==='video'?'영상':'이미지'}</span>;}
function PromptCard({scene,onSave,onCopy}:{scene:Scene,onSave:(scene:Scene)=>void,onCopy:(str:string)=>void}){
  const [image,setImage]=useState(scene.imagePrompt);const [video,setVideo]=useState(scene.videoPrompt);
  useEffect(()=>{setImage(scene.imagePrompt);setVideo(scene.videoPrompt);},[scene.id,scene.imagePrompt,scene.videoPrompt]);
  const isVideo=scene.kind==='video';
  const imageField=(rows:number)=><textarea rows={rows} value={image} onChange={e=>setImage(e.target.value)} onBlur={()=>{if(image!==scene.imagePrompt)onSave({...scene,imagePrompt:image});}} placeholder="AI가 생성하거나 직접 작성한 이미지 프롬프트"/>;
  const videoField=(rows:number)=><textarea rows={rows} value={video} onChange={e=>setVideo(e.target.value)} onBlur={()=>{if(video!==scene.videoPrompt)onSave({...scene,videoPrompt:video});}} placeholder="Gemini 등 동영상 생성 도구에 보낼 지시문"/>;
  const primary=isVideo?video:image;
  return <article className="prompt-card"><div className="prompt-card-head"><div><span className="micro">{scene.id} <KindBadge kind={scene.kind}/></span><h3>{scene.title}</h3></div><Tag tone={primary.trim()?'success':'muted'}>{primary.trim()?'준비됨':'입력 필요'}</Tag></div>
    <label className="field"><span className="field-label">{isVideo?'동영상':'이미지'} 생성 프롬프트 · 영어</span>{isVideo?videoField(5):imageField(5)}</label>
    <div className="prompt-card-actions"><Button kind="outline" size="sm" onClick={()=>onCopy(primary)} disabled={!primary}><Copy size={14}/> {isVideo?'동영상':'이미지'} 요청 복사</Button></div>
    <details className="advanced-details"><summary>{isVideo?'이미지 프롬프트 · 선택 사항':'동영상 프롬프트 · 선택 사항'}</summary>{isVideo?imageField(3):videoField(3)}<Button kind="outline" size="sm" onClick={()=>onCopy(isVideo?image:video)} disabled={!(isVideo?image:video)}><Copy size={14}/> {isVideo?'이미지':'동영상'} 요청 복사</Button></details>
  </article>;
}
function JobQueueCard({flash}:{flash:(text:string,type?:'info'|'success'|'error')=>void}){
  const [jobs,setJobs]=useState<GeminiJobRecord[]>([]);
  const refresh=async()=>{try{setJobs(await window.studio.gemini.jobs.list());}catch{/* ignore */}};
  useEffect(()=>{void refresh();return window.studio.gemini.onJobUpdate(()=>{void refresh();});},[]);
  const label:Record<string,string>={queued:'대기',dispatching:'전송 중',waiting:'응답 대기',completed:'완료',failed:'실패',needs_confirmation:'확인 필요',cancelled:'취소됨',cancelling:'취소 중'};
  return <Card className="theme-settings-card"><div className="setting-head"><div className="setting-icon"><ListOrdered size={21}/></div><div><h3>Gemini 작업 큐</h3><p>한 번에 하나의 작업만 실행합니다. 전송 여부가 불분명하면 자동 재전송하지 않습니다.</p></div></div>
    <div className="ai-connect-actions"><Button size="sm" kind="secondary" onClick={()=>void refresh()}>목록 새로고침</Button></div>
    {jobs.length===0?<p className="setting-note">등록된 작업이 없습니다.</p>:<div className="job-list">{jobs.slice().reverse().map(j=><div className="job-row" key={j.jobId}><div><strong>{j.kind}</strong> <Tag tone={j.state==='completed'?'success':j.state==='failed'?'warning':'muted'}>{label[j.state]||j.state}</Tag>{j.phase&&<Tag tone="muted">{PHASE_LABEL[j.phase]||j.phase}</Tag>}<small>{j.jobId.slice(0,8)} · {j.projectId.slice(0,8)}</small>{j.errorMessage&&<p className="setting-note">{j.errorMessage}</p>}</div>
      <div className="ai-connect-actions">
        {j.state==='failed'&&j.executable&&<Button size="sm" onClick={async()=>{await window.studio.gemini.jobs.retry(j.jobId);flash('실패 작업을 다시 대기열에 넣었습니다.','info');void refresh();}}>재시도</Button>}
        {j.state==='needs_confirmation'&&<Button size="sm" kind="outline" onClick={async()=>{await window.studio.gemini.jobs.confirm(j.jobId);flash('사용자 확인 후 재전송 대기열에 넣었습니다.','info');void refresh();}}>확인 후 재전송</Button>}
        {j.state==='needs_confirmation'&&j.sendConfirmed&&<Button size="sm" kind="secondary" onClick={async()=>{await window.studio.gemini.jobs.continue(j.jobId);flash('재전송 없이 응답 대기로 전환했습니다.','info');void refresh();}}>기다리기</Button>}
        {j.state!=='completed'&&j.state!=='cancelled'&&<Button size="sm" kind="ghost" onClick={async()=>{await window.studio.gemini.jobs.cancel(j.jobId);flash('취소 요청을 보냈습니다. 외부 취소가 확인되지 않으면 완료로 표시하지 않습니다.','info');void refresh();}}>취소</Button>}
      </div></div>)}</div>}
  </Card>;
}
function ProjectRow({p,onOpen,onArchive}:{p:ProjectSummary,onOpen:()=>void,onArchive?:()=>void}){
  return <article className={`project-row ${p.draft?'is-draft':''}`} onDoubleClick={onOpen}>
    <div className="row-icon"><BookOpen size={18}/></div>
    <div className="row-primary"><h3>{p.title}{p.draft&&<Tag tone="warning">작성 중</Tag>}</h3><p>{GENRES[p.genre]} · {AUDIENCES[p.audience]} · 마지막 수정 {formatDate(p.updatedAt)}</p></div>
    <span className="row-muted">{p.sceneCount} 장면</span><span className="row-muted">{p.mediaCount} 미디어</span>
    <Button size="sm" kind="secondary" onClick={onOpen}>열기 <ArrowRight size={14}/></Button>
    {onArchive&&<IconButton label="작품 보관 (지우지 않고 보관 목록으로)" onClick={onArchive}><Archive size={16}/></IconButton>}
  </article>;
}
function App(){
  const studio=useStudio();const {project,projects,loading,busy,flash,copy,mutate}=studio;
  const themeApi = useTheme();
  const [view,setView]=useState<View>('home');const [aiStage,setAiStage]=useState<AIStage|null>(null);const [aiView,setAiView]=useState<View|null>(null);const [aiAuto,setAiAuto]=useState(false);
  const [stageJobs,setStageJobs]=useState<Record<AIStage,GeminiJobRecord|null>>(EMPTY_STAGE_JOBS);
  const [imageJobs,setImageJobs]=useState<Record<string,GeminiJobRecord>>({});
  const [videoJobs,setVideoJobs]=useState<Record<string,GeminiJobRecord>>({});
  const [musicJob,setMusicJob]=useState<GeminiJobRecord|null>(null);
  const [probe,setProbe]=useState('');
  const projectRef=useRef(project);projectRef.current=project;const handledJobs=useRef(new Set<string>());
  const [search,setSearch]=useState('');
  const [editingSceneId,setEditingSceneId]=useState<string|null>(null);const [newScene,setNewScene]=useState<Scene|null>(null);
  const [activeAsset,setActiveAsset]=useState<string|null>(null);const [showArchived,setShowArchived]=useState(false);
  const [infoPath,setInfoPath]=useState('');const [appVersion,setAppVersion]=useState('0.1.0');
  const [briefPanel,setBriefPanel]=useState(()=>readPanel(PANEL_KEYS.brief,true));
  const [stepPanel,setStepPanel]=useState(()=>readPanel(PANEL_KEYS.steps,false));
  const [briefPending,setBriefPending]=useState(false);
  const flushRef=useRef<BriefFlush|null>(null);
  const saveState:SaveState=busy?'saving':briefPending?'pending':'saved';
  useEffect(()=>{void window.studio.app.info().then(i=>{setInfoPath(i.dataRoot);if(i.version)setAppVersion(i.version);}).catch(()=>{});},[]);
  useEffect(()=>{if(project&&!activeAsset&&project.assets.length)setActiveAsset(project.assets[0].id);},[project?.id]);
  const toggleBriefPanel=()=>setBriefPanel(v=>{try{localStorage.setItem(PANEL_KEYS.brief,v?'closed':'open');}catch{/* ignore */}return !v;});
  const toggleStepPanel=()=>{setAiStage(null);setStepPanel(v=>{try{localStorage.setItem(PANEL_KEYS.steps,v?'closed':'open');}catch{/* ignore */}return !v;});};
  // Gemini AI 단계(기획 분석·스토리보드·생성 프롬프트·최종 편집 구성) 및 장면별 이미지·동영상·배경음악 생성 작업 상태 구독
  useEffect(()=>{
    const id=project?.id;let alive=true;setStageJobs(EMPTY_STAGE_JOBS);setImageJobs({});setVideoJobs({});setMusicJob(null);
    if(id){
      for(const st of AI_STAGES)void window.studio.gemini.analysis.latest(id,st).then(j=>{if(alive)setStageJobs(o=>({...o,[st]:j}));}).catch(()=>{});
      const indexByScene=(list:GeminiJobRecord[])=>{
        const byScene:Record<string,GeminiJobRecord>={};
        for(const j of list){
          if(!j.sceneId)continue;
          const prev=byScene[j.sceneId];
          if(!prev||j.createdAt>=prev.createdAt)byScene[j.sceneId]=j;
        }
        return byScene;
      };
      void window.studio.gemini.image?.listForProject(id).then(list=>{if(alive&&Array.isArray(list))setImageJobs(indexByScene(list));}).catch(()=>{});
      void window.studio.gemini.video?.listForProject(id).then(list=>{if(alive&&Array.isArray(list))setVideoJobs(indexByScene(list));}).catch(()=>{});
      void window.studio.gemini.music?.latest(id).then(j=>{if(alive)setMusicJob(j);}).catch(()=>{});
    }
    const off=window.studio.gemini.onJobUpdate(j=>{
      const cur=projectRef.current;
      if(j.kind==='image'||j.kind==='video'||j.kind==='music'){
        if(cur&&j.projectId===cur.id){
          if(j.kind==='image'&&j.sceneId){const sid=j.sceneId;setImageJobs(o=>{const old=o[sid];return !old||old.jobId===j.jobId||j.createdAt>=old.createdAt?{...o,[sid]:j}:o;});}
          if(j.kind==='video'&&j.sceneId){const sid=j.sceneId;setVideoJobs(o=>{const old=o[sid];return !old||old.jobId===j.jobId||j.createdAt>=old.createdAt?{...o,[sid]:j}:o;});}
          if(j.kind==='music'){setMusicJob(old=>!old||old.jobId===j.jobId||j.createdAt>=old.createdAt?j:old);}
        }
        if(j.outcome!=='applied'||handledJobs.current.has(j.jobId))return;
        handledJobs.current.add(j.jobId);
        const doneMsg=j.kind==='image'
          ? `${j.sceneId||'장면'} 이미지를 Gemini에서 생성해 프로젝트에 저장하고 연결했습니다.`
          : j.kind==='video'
          ? `${j.sceneId||'장면'} 동영상을 Gemini에서 생성해 프로젝트에 저장하고 연결했습니다.`
          : '배경음악(BGM)을 Gemini에서 생성해 오디오 보관함에 추가했습니다. 최종 편집안에서 선택할 수 있습니다.';
        if(cur&&j.projectId===cur.id){
          if(!j.appliedRevision||cur.revision<j.appliedRevision){
            void studio.load(cur.id).then(p=>{
              if(p){
                if(j.assetId)setActiveAsset(j.assetId);
                flash(doneMsg,'success');
              }
            });
          }
        }else{
          void studio.refresh();
          flash('다른 작품의 Gemini 생성 미디어가 저장되었습니다.','info');
        }
        return;
      }
      if(!isAIStage(j.kind))return;const st=j.kind;
      if(cur&&j.projectId===cur.id)setStageJobs(o=>{const old=o[st];return !old||old.jobId===j.jobId||j.createdAt>=old.createdAt?{...o,[st]:j}:o;});
      if(j.outcome!=='applied'||handledJobs.current.has(j.jobId))return;
      handledJobs.current.add(j.jobId);
      const name=STAGE_META[st].name;
      if(cur&&j.projectId===cur.id){if(!j.appliedRevision||cur.revision<j.appliedRevision)void studio.load(cur.id).then(p=>{if(p)flash(STAGE_DONE_FLASH[st],'success');});}
      else{void studio.refresh();flash(`다른 작품의 Gemini ${name} 결과가 저장되었습니다.`,'info');}
    });
    return()=>{alive=false;off();};
  },[project?.id]);

  // 「…」 메뉴: 항목을 고르거나 바깥을 누르면 닫힘
  useEffect(()=>{
    const close=(e:MouseEvent)=>{document.querySelectorAll('details.more-menu[open]').forEach(d=>{const t=e.target as Node;if(!d.contains(t)||(t instanceof Element&&t.closest('.more-menu-list button')))d.removeAttribute('open');});};
    document.addEventListener('click',close);return()=>document.removeEventListener('click',close);
  },[]);
  const startSceneImage=async(sceneId:string)=>{
    if(!project)return;
    try{
      const r=await window.studio.gemini.image.start(project.id,sceneId);
      if(!r.ok){flash(r.message||'이미지 생성을 시작하지 못했습니다.','error');return;}
      if(r.job&&r.job.sceneId)setImageJobs(o=>({...o,[r.job!.sceneId!]:r.job!}));
      flash(r.reused?(r.message||`${sceneId} 이미지 생성 작업이 이미 진행 중입니다.`):`${sceneId} 장면 이미지 생성 요청을 Gemini 작업 큐에 등록했습니다.`,'info');
    }catch(e){flash(String(e),'error');}
  };
  const startSceneVideo=async(sceneId:string,options?:{useReferenceImage?:boolean})=>{
    if(!project)return;
    try{
      const r=await window.studio.gemini.video.start(project.id,sceneId,options);
      if(!r.ok){flash(r.message||'동영상 생성을 시작하지 못했습니다.','error');return;}
      if(r.job&&r.job.sceneId)setVideoJobs(o=>({...o,[r.job!.sceneId!]:r.job!}));
      const viaRef=!!options?.useReferenceImage;
      flash(r.reused?(r.message||`${sceneId} 동영상 생성 작업이 이미 진행 중입니다.`):`${sceneId} 장면 ${viaRef?'기준 이미지로 동영상':'동영상'} 생성 요청을 Gemini 작업 큐에 등록했습니다.`,'info');
    }catch(e){flash(String(e),'error');}
  };
  const startProjectMusic=async()=>{
    if(!project)return;
    try{
      const r=await window.studio.gemini.music.start(project.id);
      if(!r.ok){flash(r.message||'배경음악 생성을 시작하지 못했습니다.','error');return;}
      if(r.job)setMusicJob(r.job);
      flash(r.reused?(r.message||'이미 진행 중인 배경음악 생성 작업이 있습니다.'):'배경음악 생성 요청을 Gemini 작업 큐에 등록했습니다.','info');
    }catch(e){flash(String(e),'error');}
  };
  const copySceneImagePrompt=async(sceneId:string)=>{
    if(!project)return;
    try{await copy(makeImageGenerationPrompt(project,sceneId));}
    catch(e){
      const sc=project.scenes.find(x=>x.id===sceneId);
      if(sc?.imagePrompt?.trim())await copy(sc.imagePrompt.trim());
      else flash(e instanceof Error?e.message:String(e),'error');
    }
  };
  const copySceneVideoPrompt=async(sceneId:string)=>{
    if(!project)return;
    try{await copy(makeVideoGenerationPrompt(project,sceneId,{hasReferenceImage:!!findSceneReferenceImage(project,sceneId)}));}
    catch(e){
      const sc=project.scenes.find(x=>x.id===sceneId);
      if(sc?.videoPrompt?.trim())await copy(sc.videoPrompt.trim());
      else flash(e instanceof Error?e.message:String(e),'error');
    }
  };
  const copyProjectMusicPrompt=async()=>{
    if(!project)return;
    try{await copy(makeMusicGenerationPrompt(project));}
    catch(e){
      const bgm=getProjectBgmPrompt(project);
      if(bgm)await copy(bgm);
      else flash(e instanceof Error?e.message:String(e),'error');
    }
  };
  const analysisJob=stageJobs.analysis;
  const analysisView=phaseView(analysisJob);
  const busyOf=(st:AIStage)=>{const j=stageJobs[st];return !!j&&!['completed','failed','cancelled'].includes(j.state);};
  const analysisBusy=busyOf('analysis');
  const openStage=(st:AIStage,auto:boolean)=>{setAiAuto(auto&&!busyOf(st));setAiStage(st);setAiView(view);};
  const openAnalysis=(auto:boolean)=>openStage('analysis',auto);
  /** 단계 페이지 상단 버튼: 진행 중이면 「진행 상황 보기」, 아니면 「AI … 시작」 */
  const stageButton=(st:AIStage,disabled=false)=>busyOf(st)?<Button size="sm" onClick={()=>openStage(st,false)}><Sparkles size={15}/> 진행 상황 보기</Button>:<Button size="sm" onClick={()=>openStage(st,true)} disabled={disabled}><Sparkles size={15}/> {project&&stageHasResult(project,st)?STAGE_META[st].restartLabel:STAGE_META[st].startLabel}</Button>;
  /** 진행 중·확인 필요 작업 배너 (모달을 닫아도 표시) */
  const stageBanner=(st:AIStage)=>{const j=stageJobs[st];const v=phaseView(j);if(!j||!v||!(v.active||v.phase==='needs_user'||v.phase==='error'))return null;return <button className={`analysis-job-banner tone-${v.tone}`} onClick={()=>openStage(st,false)}><Sparkles size={16}/><strong>Gemini {STAGE_META[st].name} · {v.label}</strong><span>{v.active?'창을 닫아도 계속 진행됩니다.':'확인이 필요합니다.'} 눌러서 자세히 보기</span><ArrowRight size={15}/></button>;};
  const onNavigate=(t:AINavTarget)=>{if(t==='select'){goSelect();return;}void go(t);};
  // AI 작업 창은 연 화면에서만 보인다. 다른 화면으로 옮기면 닫고 자동 시작도 끈다
  // (이전 단계 창이 새 화면에서 다시 만들어지며 그 단계를 다시 시작하려던 문제 방지)
  useEffect(()=>{if(aiView&&aiView!==view){setAiStage(null);setAiAuto(false);setAiView(null);}},[view]);
  const goSelect=()=>{setView('analysis');setTimeout(()=>document.querySelector('.choice-layout')?.scrollIntoView({behavior:'smooth',block:'start'}),120);};
  /** 작품 정보 자동 저장을 끝낸다. 실패하면 오류를 알리고 false를 돌려 화면 이동을 막는다. */
  const flushBrief=async()=>{
    const flushed=await flushRef.current?.();
    if(flushed&&!flushed.ok){
      if(flushed.error&&!flushed.notified)flash(flushed.error,'error');
      return false;
    }
    return true;
  };
  /** 작성 중인 입력을 먼저 저장하고, 아무것도 입력하지 않은 빈 작품이면 지운다 */
  const leaveProject=async()=>{
    if(!await flushBrief())return false;
    const cur=studio.current();
    if(cur&&isEmptyDraft(cur))await studio.discardDraft(cur.id);
    return true;
  };
  const go=async(next:View)=>{
    if(next!=='projects'&&next!=='home'&&next!=='settings'&&!studio.current()){setView('projects');return;}
    if(next==='home'||next==='projects'){if(!await leaveProject())return;}
    else if(!await flushBrief())return;
    setView(next);
  };
  const open=async(id:string)=>{if(studio.current()?.id!==id&&!await leaveProject())return;const p=await studio.load(id);if(p){setView('brief');setActiveAsset(null);setEditingSceneId(null);setNewScene(null);}};
  /** 「새 작품」: 입력 창 없이 바로 빈 작품을 만들고 작품 정보 화면을 연다 */
  const newProject=async(genre?:Genre)=>{
    if(!await leaveProject())return;
    const p=await studio.create({...NEW_DRAFT_BRIEF,genre:genre??NEW_DRAFT_BRIEF.genre});
    if(p){setView('brief');setActiveAsset(null);setEditingSceneId(null);setNewScene(null);}
  };
  const onBriefAutosave=async(projectId:string,brief:Brief,continueSession:boolean)=>{
    let started=false;
    const saved=await mutate(p=>{const r=applyBriefAutosave(p,brief,{continueSession});started=r.startedSession;return r.project;},projectId,{notify:false});
    if(!saved)throw notifiedError('작품 정보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    return started;
  };
  const onApproveOriginal=async(projectId:string,payload:ApprovedOriginalPayload,base:Brief)=>{
    const saved=await mutate(p=>approveOriginalInProject(p,{briefPatch:{...base,originalMeta:undefined},meta:payload.meta,reason:`${payload.meta.providerName}에서 기준 원문 확정`}),projectId);
    if(saved)flash('원문을 채우고 기준 원문으로 확정했어요. 이제 기획 분석으로 넘어갈 수 있어요.','success');
    return !!saved;
  };
  const saveScene=(s:Scene)=>{void mutate(p=>{const old=p.scenes.find(x=>x.id===s.id);const changed=old&&(old.narration!==s.narration||old.visual!==s.visual||old.kind!==s.kind);
    const next=changed?{...s,imagePrompt:'',videoPrompt:'',negativePrompt:'',assetId:null,status:'draft' as const}:s;
    const empty={status:'idle' as const,raw:'',updatedAt:null};
    return withSceneEffects({...p,scenes:p.scenes.map(x=>x.id===s.id?next:x),...(changed?{ai:{...p.ai,prompt:empty,editplan:empty},assembly:{...p.assembly,clips:[]}}:{})});
  });};
  const addScene=()=>{if(!project)return;const n=Math.max(0,...project.scenes.map(s=>Number(s.id.slice(1))||0))+1;const id='S'+String(n).padStart(2,'0');setEditingSceneId(null);setNewScene({id,title:`새 장면 ${n}`,narration:'',visual:'',durationSec:10,kind:'image',imagePrompt:'',videoPrompt:'',negativePrompt:'',assetId:null,status:'draft'});setTimeout(()=>document.querySelector('.scene-card.is-new')?.scrollIntoView({behavior:'smooth',block:'center'}),60);};
  const activeMedia=project?.assets.find(a=>a.id===activeAsset);
  const completed=project?completedSteps(project):0;
  const activeJob=AI_STAGES.map(st=>({st,v:phaseView(stageJobs[st])})).find(x=>x.v&&(x.v.active||x.v.phase==='needs_user'));

  /** 단계 화면 공통 틀: 한 줄 머리 + 본문 + (오른쪽 창) + 아래 고정 줄 */
  const renderStep=(stage:Stage,opts:{actions?:ReactNode,body:ReactNode,primaryLabel?:string,onPrimary?:()=>void}):ReactNode=>{
    if(!project)return null;
    const guide=stepGuide(project,stage);
    const Icon=iconFor[stage];
    const panel=aiStage&&aiView===view?<AIDock key={project.id+aiStage} project={project} stage={aiStage} autoStart={aiAuto} onAutoStartConsumed={()=>setAiAuto(false)} onNavigate={onNavigate} flash={flash} onClose={()=>{setAiStage(null);setAiAuto(false);setAiView(null);}} onCopy={t=>void copy(t)} onApply={async(next)=>{const saved=await mutate(()=>next);if(saved){flash('AI 결과를 검사하고 적용했습니다.','success');return true;}return false;}}/>
      :stepPanel?<ProjectPropsPanel project={project} brief={project.brief} onChange={patch=>void mutate(p=>({...p,brief:{...p.brief,...patch}}))} onClose={toggleStepPanel}/>:null;
    return <StepLayout key={stage} focusKey={`${stage}-${project.id}`}
      header={<DocHeader icon={<Icon size={16}/>} title={STEP_TITLES[stage]} description={STAGE_HINTS[stage]} project={project} saveState={saveState} actions={opts.actions} panelOpen={stepPanel&&!aiStage} onTogglePanel={toggleStepPanel}/>}
      panel={panel}
      actionBar={<ActionBar guide={guide} primaryLabel={opts.primaryLabel} onNext={opts.onPrimary||(()=>{if(guide.next)void go(guide.next);})}/>}>
      {opts.body}
    </StepLayout>;
  };
  const pageLayout=(icon:ReactNode,title:string,actions:ReactNode,body:ReactNode)=><div className="step-layout"><DocHeader icon={icon} title={title} actions={actions}/><div className="workspace"><div className="workspace-main page-scroll">{body}</div></div></div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-area"><BrandIcon size={28}/><div><strong>{BRAND.productKo}</strong><small>{BRAND.productEn}</small></div></div>
      <div className="sidebar-project">
        <button className="current-project" onClick={()=>void go('projects')} title="다른 작품 열기 (내 작품)"><FolderOpen size={15}/><div><small>현재 작품</small><strong>{project?(project.brief.title.trim()||UNTITLED):'열린 작품 없음'}</strong></div><ChevronDown size={14}/></button>
        <Button size="sm" onClick={()=>void newProject()} title="입력 창 없이 바로 새 작품을 만들고 작품 정보 화면을 엽니다"><Plus size={14}/> 새 작품</Button>
      </div>
      <div className="nav-groups"><div className="nav-label">작업 공간</div>
        {[['home','대시보드'],['projects','내 작품']].map(([id,label])=>{const Icon=iconFor[id];return <button key={id} className={`nav-link ${view===id?'active':''}`} onClick={()=>void go(id as View)}><Icon size={17}/><span>{label}</span>{id==='projects'&&<small>{projects.length}</small>}</button>;})}
        <div className="nav-label nav-separator">제작 단계</div>
        {STEP_VIEWS.map((id,i)=>{const Icon=iconFor[id];const done=!!project&&stageComplete(project,id);return <button key={id} className={`nav-link step-link ${view===id?'active':''} ${!project?'disabled-link':''} ${done?'done':''}`} onClick={()=>void go(id)} title={project?STAGE_HINTS[id]:'작품을 먼저 열거나 새로 만들어 주세요'}><span className="step-num">{done?<Check size={12}/>:i+1}</span><Icon size={16}/><span>{STEP_TITLES[id]}</span></button>;})}
      </div>
      <div className="sidebar-bottom"><button className={`nav-link ${view==='settings'?'active':''}`} onClick={()=>void go('settings')}><Settings2 size={17}/> <span>환경 설정</span></button></div>
    </aside>
    <div className="main-shell">
      <main className="main-content">
        {loading?<div className="loading-content"><Sparkles size={29}/> 작품을 불러오는 중…</div>:<>
        {view==='home'&&pageLayout(<Home size={16}/>,'대시보드',<span className="header-stats">작품 {projects.length} · 장면 {projects.reduce((n,p)=>n+p.sceneCount,0)} · 미디어 {projects.reduce((n,p)=>n+p.mediaCount,0)}</span>,<div className="home-page">
          <section className="start-section"><div className="section-row"><h3>새로 만들기</h3><span className="muted-text">종류를 고르면 바로 작품 정보 화면이 열려요. 내용은 그 화면에서 채우면 돼요.</span></div>
            <div className="new-tiles">{GENRE_TILES.map(t=>{const Icon=t.icon;return <button key={t.genre} className="new-tile" onClick={()=>void newProject(t.genre)} disabled={busy}><span className="new-tile-icon"><Icon size={22}/></span><strong>{GENRES[t.genre]}</strong><small>{t.desc}</small></button>;})}</div>
          </section>
          <section><div className="section-row"><h3>최근 작업</h3>{projects.length>0&&<Button size="sm" kind="ghost" onClick={()=>void go('projects')}>전체 보기 <ArrowRight size={14}/></Button>}</div>
            {projects.length?<div className="project-list">{projects.slice(0,6).map(p=><ProjectRow key={p.id} p={p} onOpen={()=>void open(p.id)}/>)}</div>:<Card><Empty title="아직 작품이 없어요" description="위에서 종류를 고르면 첫 작품이 바로 만들어져요."/></Card>}
          </section>
        </div>)}
        {view==='projects'&&pageLayout(<Layers3 size={16}/>,'내 작품',<><div className="search-field compact"><Search size={15}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="작품 제목으로 검색"/></div><button className={`filter-btn ${showArchived?'on':''}`} onClick={()=>setShowArchived(v=>!v)}><Archive size={15}/> {showArchived?'보관한 작품 숨기기':'보관한 작품 보기'}</button><Button size="sm" kind="secondary" onClick={()=>void studio.importProject()} disabled={busy}><FolderInput size={14}/> 작품 가져오기</Button><Button size="sm" onClick={()=>void newProject()} disabled={busy}><Plus size={14}/> 새 작품</Button></>,<>
          <div className="project-list">{projects.filter(p=>p.title.toLowerCase().includes(search.toLowerCase())).map(p=><ProjectRow key={p.id} p={p} onOpen={()=>void open(p.id)} onArchive={()=>{if(confirm('작품을 보관 목록으로 옮길까요? 파일은 지워지지 않아요.'))void studio.archive(p.id,true);}}/>)}{!projects.length&&<Empty title="작품이 없어요" description="「새 작품」을 누르면 바로 만들어져요." action={<Button onClick={()=>void newProject()}><Plus size={15}/> 새 작품</Button>}/>}</div>
          {showArchived&&<div className="archive-section"><div className="section-row"><h3>보관한 작품</h3><span className="muted-text">보관한 작품은 지워지지 않으며 복원할 수 있어요.</span></div><ArchivedList onRestore={id=>void studio.archive(id,false)}/></div>}
        </>)}
        {project&&view==='brief'&&<BriefPage
          project={project}
          flash={flash}
          saveState={saveState}
          panelOpen={briefPanel}
          onTogglePanel={toggleBriefPanel}
          registerFlush={fn=>{flushRef.current=fn;}}
          onAutosave={onBriefAutosave}
          onApproveOriginal={onApproveOriginal}
          onPendingChange={setBriefPending}
          onNext={()=>void go('analysis')}/>}
        {project&&view==='analysis'&&renderStep('analysis',{
          actions:<>{analysisBusy?<Button size="sm" onClick={()=>openAnalysis(false)}><Sparkles size={15}/> 진행 상황 보기</Button>:<Button size="sm" onClick={()=>openAnalysis(true)} disabled={!stageComplete(project,'brief')} title={!stageComplete(project,'brief')?'작품 제목과 낭독 원문을 먼저 입력해 주세요.':undefined}><Sparkles size={15}/> {project.analysis?'AI 기획 분석 다시 시작':'AI 기획 분석 시작'}</Button>}<Button size="sm" kind="outline" onClick={()=>openAnalysis(false)}>상세·수동 연결</Button></>,
          body:<div className="step-body">
            {project.reviewNeeded?.analysis&&<div className="review-needed-banner"><ShieldAlert size={16}/><div><strong>기준 원문 변경 — 기획 분석 재검토 필요</strong><span>{project.reviewNeeded.reason||'기준 원문이 변경되었습니다.'} 기존 미디어 파일은 삭제되지 않습니다. 새 원문으로 기획 분석을 다시 실행하세요.</span></div></div>}
            <div className="ai-transfer-note"><Info size={14}/><span>확정된 기준 원문{project.brief.originalMeta?` (v${project.brief.originalMeta.version} · ${RIGHTS_STATUS_META[project.brief.originalMeta.rights.status].shortLabel})`:''}이 AI 기획 시작 시 외부 Gemini 서비스로 전송됩니다.</span></div>
            {stageBanner('analysis')}
            {!project.analysis?<Card><Empty title={stageComplete(project,'brief')?'아직 기획안이 없습니다':'작품 제목과 원문이 없어요'} description={stageComplete(project,'brief')?'「AI 기획 분석 시작」을 누르면 Chrome의 Gemini 탭에 요청을 보내고 응답 JSON을 검사해 바로 반영합니다. 결과를 바탕으로 화풍과 연출 방향을 선택합니다.':'작품 정보에서 제목과 낭독 원문을 입력하고 저장한 뒤 다시 와 주세요. 저장되지 않은 채로 이 단계로 오면 분석을 시작할 수 없어요.'} action={stageComplete(project,'brief')?<Button onClick={()=>openAnalysis(true)} disabled={analysisBusy}><WandSparkles size={16}/> AI 기획 분석 시작</Button>:<Button onClick={()=>void go('brief')}>1 작품 정보로 이동</Button>}/></Card>:<><div className="analysis-intro"><div className="analysis-symbol"><Palette size={29}/></div><div><div className="micro">AI ANALYSIS SUMMARY</div><h3>{project.analysis.summary}</h3><p>{project.analysis.emotion}</p><div className="keywords">{project.analysis.keywords.map(k=><span key={k}>#{k}</span>)}</div>{project.analysis.emotionArc?.length?<div className="emotion-arc">{project.analysis.emotionArc.map((a,i)=><span key={i}>{a}</span>)}</div>:null}</div></div>
            {project.analysis.visualBible&&<details className="advanced-details visual-bible"><summary>스타일 바이블 · 모든 이미지·영상 요청에 반복해 넣어요</summary><dl>{project.analysis.visualBible.styleSentence&&<><dt>화풍 문장</dt><dd>{project.analysis.visualBible.styleSentence}</dd></>}{project.analysis.visualBible.palette.length>0&&<><dt>팔레트</dt><dd>{project.analysis.visualBible.palette.join(' · ')}</dd></>}{project.analysis.visualBible.lighting&&<><dt>빛 흐름</dt><dd>{project.analysis.visualBible.lighting}</dd></>}{project.analysis.visualBible.character&&<><dt>주인공 고정 묘사</dt><dd>{project.analysis.visualBible.character}</dd></>}{project.analysis.visualBible.motionStyle&&<><dt>움직임 원칙</dt><dd>{project.analysis.visualBible.motionStyle}</dd></>}{project.analysis.visualBible.avoid.length>0&&<><dt>금지 요소</dt><dd>{project.analysis.visualBible.avoid.join(', ')}</dd></>}</dl></details>}
            {project.analysis.recommendationReason&&<div className="ai-pick-reason"><Sparkles size={14}/><span><b>AI 추천 이유</b> {project.analysis.recommendationReason}</span></div>}<div className="choice-layout"><div><div className="choice-title"><h3>01. 화풍 선택</h3><p>모든 장면에 일관되게 적용할 스타일입니다.</p></div><div className="choice-list">{project.analysis.styles.map((o,i)=><button key={o.id} className={`choice-card ${project.selection.styleId===o.id?'selected':''}`} onClick={()=>{if(project.scenes.length&&!confirm('화풍을 바꾸면 승인된 장면과 후속 결과를 초기화합니다. 계속할까요?'))return;void mutate(p=>({...p,selection:{...p.selection,styleId:o.id},scenes:[],ai:{...p.ai,storyboard:{status:'idle',raw:'',updatedAt:null},prompt:{status:'idle',raw:'',updatedAt:null},editplan:{status:'idle',raw:'',updatedAt:null}},assembly:{...p.assembly,clips:[]}}));}}><div className={`choice-visual choice-v${i%3}`}><Palette size={22}/></div><div><strong>{o.label}{project.analysis!.recommendedStyleId===o.id&&<span className="ai-pick">AI 추천</span>}</strong><span>{o.description}</span></div><div className="choice-check">{project.selection.styleId===o.id&&<Check size={14}/>}</div></button>)}</div></div>
              <div><div className="choice-title"><h3>02. 연출 방향 선택</h3><p>장면의 흐름과 감정 전달 방식입니다.</p></div><div className="choice-list">{project.analysis.directions.map((o,i)=><button key={o.id} className={`choice-card ${project.selection.directionId===o.id?'selected':''}`} onClick={()=>{if(project.scenes.length&&!confirm('연출안을 바꾸면 승인된 장면과 후속 결과를 초기화합니다. 계속할까요?'))return;void mutate(p=>({...p,selection:{...p.selection,directionId:o.id},scenes:[],ai:{...p.ai,storyboard:{status:'idle',raw:'',updatedAt:null},prompt:{status:'idle',raw:'',updatedAt:null},editplan:{status:'idle',raw:'',updatedAt:null}},assembly:{...p.assembly,clips:[]}}));}}><div className={`choice-visual choice-d${i%3}`}><MonitorPlay size={22}/></div><div><strong>{o.label}{project.analysis!.recommendedDirectionId===o.id&&<span className="ai-pick">AI 추천</span>}</strong><span>{o.description}</span></div><div className="choice-check">{project.selection.directionId===o.id&&<Check size={14}/>}</div></button>)}</div></div></div>
              {!!project.analysis.cautions.length&&<div className="notice"><ShieldAlert size={17}/><div><b>제작 시 유의사항</b><p>{project.analysis.cautions.join(' · ')}</p></div></div>}
              </>}
          </div>})}
        {project&&view==='storyboard'&&renderStep('storyboard',{
          actions:<><Button size="sm" kind="outline" onClick={addScene}><Plus size={14}/> 장면 추가</Button><Button size="sm" kind="outline" disabled={!project.scenes.length} title="모든 장면의 움직임·효과·전환을 장면 순서에 맞춰 다시 구성합니다(자막 줄은 유지)" onClick={()=>{if(project.scenes.some(s=>s.effects?.shots?.length)&&!confirm('모든 장면의 샷·효과·전환을 자동으로 다시 구성할까요? 직접 고친 효과는 바뀝니다.'))return;void mutate(p=>withSceneEffects(p,{regenerate:true}));}}><WandSparkles size={14}/> 효과 자동 구성</Button>{stageButton('storyboard',!!STAGE_META.storyboard.prerequisite(project))}<Button size="sm" kind="outline" onClick={()=>openStage('storyboard',false)}>상세·수동 연결</Button></>,
          body:<div className="step-body">
            {project.reviewNeeded?.storyboard&&<div className="review-needed-banner"><ShieldAlert size={16}/><div><strong>기준 원문 변경 — 스토리보드 재검토 필요</strong><span>{project.reviewNeeded.reason||'기준 원문이 변경되어 장면 낭독 문장을 새 원문과 대조해야 합니다.'} 이미 확보한 미디어 파일은 그대로 유지됩니다.</span></div></div>}
            {stageBanner('storyboard')}
            {project.scenes.length||newScene?<div className="scene-grid">{project.scenes.map((scene,i)=>editingSceneId===scene.id?<article className="scene-card is-editing" key={scene.id}><div className="scene-card-body"><div className="scene-card-top"><div className="micro">SCENE {String(i+1).padStart(2,'0')} · {scene.id}</div></div><SceneEditor scene={scene} index={i} isNew={false} onCancel={()=>setEditingSceneId(null)} onSave={s=>{saveScene(s);setEditingSceneId(null);}}/></div></article>:<article className="scene-card" key={scene.id}><div className="scene-cover"><Photo project={project} asset={sceneAsset(project,scene)}/><div className="scene-index">{scene.id}</div><div className="scene-kind">{scene.kind==='video'?<Film size={13}/>:<ImageIcon size={13}/>} {scene.kind==='video'?'동영상':'이미지'}</div></div><div className="scene-card-body"><div className="scene-card-top"><div className="micro">SCENE {String(i+1).padStart(2,'0')}</div><span className="duration"><Clock3 size={13}/>{scene.durationSec}초</span></div><h3>{scene.title}</h3><p className="scene-visual">{scene.visual}</p>{scene.mood&&<p className="scene-mood">{scene.mood}</p>}<blockquote>{scene.narration}</blockquote><EffectsSummary scene={scene}/><div className="scene-card-actions"><Button kind="secondary" size="sm" onClick={()=>{setNewScene(null);setEditingSceneId(scene.id);}}><PenLine size={14}/> 바로 고치기</Button><span className="scene-reorder"><IconButton label="앞으로 이동" disabled={i===0} onClick={()=>void mutate(p=>{const a=[...p.scenes];[a[i-1],a[i]]=[a[i],a[i-1]];return {...p,scenes:a};})}><ArrowUp size={15}/></IconButton><IconButton label="뒤로 이동" disabled={i===project.scenes.length-1} onClick={()=>void mutate(p=>{const a=[...p.scenes];[a[i],a[i+1]]=[a[i+1],a[i]];return {...p,scenes:a};})}><ArrowDown size={15}/></IconButton><IconButton label="삭제" onClick={()=>{if(confirm('이 장면을 삭제할까요?'))void mutate(p=>({...p,scenes:p.scenes.filter(s=>s.id!==scene.id),assembly:{...p.assembly,clips:p.assembly.clips.filter(c=>c.sceneId!==scene.id)}}));}}><Trash2 size={15}/></IconButton></span></div></div></article>)}
              {newScene&&<article className="scene-card is-editing is-new" key={newScene.id}><div className="scene-card-body"><div className="scene-card-top"><div className="micro">새 장면 · {newScene.id}</div></div><SceneEditor scene={newScene} index={project.scenes.length} isNew onCancel={()=>setNewScene(null)} onSave={s=>{void mutate(p=>withSceneEffects({...p,scenes:[...p.scenes,s]}));setNewScene(null);}}/></div></article>}
            </div>:<Card><Empty title="아직 장면 구성이 없어요" description="「AI 장면 구성 시작」을 누르면 선택한 화풍·연출로 Gemini에 장면 구성을 요청하고 결과를 바로 반영해요. 「장면 추가」로 직접 만들 수도 있어요." action={<div className="action-group"><Button disabled={!stageComplete(project,'analysis')||busyOf('storyboard')} onClick={()=>openStage('storyboard',true)}><Sparkles size={16}/> AI 장면 구성 시작</Button><Button kind="outline" onClick={addScene}><Plus size={15}/> 장면 추가</Button></div>}/></Card>}
          </div>})}
        {project&&view==='prompt'&&renderStep('prompt',{
          actions:<>{stageButton('prompt',!project.scenes.length)}<Button size="sm" kind="outline" onClick={()=>openStage('prompt',false)} disabled={!project.scenes.length}>상세·수동 연결</Button></>,
          body:<div className="step-body">
            {project.reviewNeeded?.prompt&&<div className="review-needed-banner"><ShieldAlert size={16}/><div><strong>기준 원문 변경 — 생성 프롬프트 재검토 필요</strong><span>장면 구성이 바뀌었다면 필요한 프롬프트만 다시 생성하세요.</span></div></div>}
            {stageBanner('prompt')}
            {project.scenes.length?<><div className="prompt-grid">{project.scenes.map(s=><PromptCard key={s.id} scene={s} onSave={saveScene} onCopy={t=>void copy(t)}/>)}</div><div className="notice"><Info size={17}/><div><b>화풍과 기준 이미지의 일관성</b><p>현 단계는 프롬프트와 설정을 보관합니다. 실제 Gemini 웹 자동 생성과 기준 이미지 참조 기능은 후속 연결 모듈에서 구현합니다.</p></div></div></>:<Card><Empty title="장면을 먼저 구성해 주세요" description="스토리보드 장면이 생성되면 프롬프트를 관리할 수 있습니다." action={<Button onClick={()=>go('storyboard')}>스토리보드 열기</Button>}/></Card>}
          </div>})}
        {project&&view==='media'&&renderStep('media',{
          actions:<Button size="sm" onClick={()=>void studio.importAssets()}><Upload size={15}/> 미디어 가져오기</Button>,
          body:<div className="step-body">
            {(()=>{
              const busyOf=(j?:GeminiJobRecord|null)=>!!j&&!['completed','failed','cancelled'].includes(j.state);
              const needsUserOf=(pv:ReturnType<typeof phaseView>)=>pv?.phase==='needs_user'||pv?.phase==='error';
              const label:Record<'image'|'video'|'music',{name:string;obj:string}>={image:{name:'이미지',obj:'이미지를'},video:{name:'동영상',obj:'동영상을'},music:{name:'배경음악',obj:'배경음악을'}};
              /** 「다시 가져오기」: Gemini에 다시 보내지 않고, 이미 만든 결과를 다시 받음(보관 응답 → 대화에서 다시 받기 → 탭 새로고침 후 한 번 더) */
              const refetch=async(job:GeminiJobRecord,setState:(u:GeminiJobRecord)=>void)=>{
                if(job.state==='needs_confirmation'&&!job.sendConfirmed){const u=await window.studio.gemini.jobs.continue(job.jobId);if(u)setState(u);}
                const r=await window.studio.gemini.analysis.fetchResult(job.jobId);
                flash(r.success?'Gemini에서 다시 받는 중입니다. 프롬프트는 다시 보내지 않습니다.':(r.message||'다시 가져오지 못했습니다.'),r.success?'info':'error');
              };
              /** 「다시 생성」: Gemini에 같은 프롬프트를 다시 보냄 → 확인 후에만 */
              const regenerate=async(job:GeminiJobRecord,kind:'image'|'video'|'music',setState:(u:GeminiJobRecord)=>void,startNew:()=>Promise<void>)=>{
                if(!confirm(`Gemini에 ${label[kind].name} 프롬프트를 다시 보낼까요?\n이미 만든 결과가 Gemini에 있다면 먼저 「다시 가져오기」를 써 보세요.`))return;
                if(job.state==='needs_confirmation'){const u=await window.studio.gemini.jobs.confirm(job.jobId);if(u){setState(u);flash('다시 생성하도록 대기열에 넣었습니다.','info');return;}}
                if(job.state==='failed'&&job.executable){const u=await window.studio.gemini.jobs.retry(job.jobId);if(u){setState(u);flash('다시 생성하도록 대기열에 넣었습니다.','info');return;}}
                await startNew();
              };
              /** 자동으로 받지 못했을 때 안내 상자: 버튼 3개(가져와서 연결 · 다시 가져오기 · 다시 생성). 취소는 오른쪽 하나만 */
              const recoveryBox=(job:GeminiJobRecord|undefined|null,kind:'image'|'video'|'music',importLabel:string,onImport:()=>void,setState:(u:GeminiJobRecord)=>void,startNew:()=>Promise<void>)=>{
                const pv=phaseView(job);
                if(!job||!needsUserOf(pv))return null;
                const g=guideFor(job);
                const canRefetch=job.state==='needs_confirmation'||job.state==='waiting'||(job.state==='completed'&&job.outcome!=='applied');
                return <div className="scene-image-gen-guide">
                  <ShieldAlert size={14}/>
                  <div>
                    <strong>{label[kind].obj} 자동으로 받지 못했습니다</strong>
                    <p>Gemini에서 {label[kind].obj} 받아 '가져와서 연결'을 누르세요. 다운로드가 안 되면 Gemini 탭에서 F5를 누른 뒤 다시 받아 보세요.</p>
                    {(g?.cause||job.errorMessage)&&<><small className="guide-cause" title={g?.fix||''}>{g?.cause||job.errorMessage}</small>{job.errorMessage&&job.errorMessage!==g?.cause&&<small className="guide-detail">{job.errorMessage}</small>}</>}
                    <div className="scene-image-gen-recovery">
                      <Button size="sm" onClick={onImport}><Upload size={13}/> {importLabel}</Button>
                      {canRefetch&&<Button size="sm" kind="secondary" title="Gemini에 다시 보내지 않고, 이미 만든 결과를 다시 받습니다" onClick={()=>void refetch(job,setState)}><RotateCcw size={13}/> 다시 가져오기</Button>}
                      {(job.executable||job.state==='completed')&&<Button size="sm" kind="outline" title="Gemini에 프롬프트를 다시 보냅니다(확인 후)" onClick={()=>void regenerate(job,kind,setState,startNew)}><Sparkles size={13}/> 다시 생성</Button>}
                    </div>
                  </div>
                </div>;
              };
              const cancelJob=async(job:GeminiJobRecord,setState:(u:GeminiJobRecord)=>void,name:string)=>{const u=await window.studio.gemini.jobs.cancel(job.jobId);if(u)setState(u);flash(`${name} 작업 취소를 요청했습니다.`,'info');};

              const bgmPromptText=getProjectBgmPrompt(project);
              const audioAssets=project.assets.filter(a=>a.kind==='audio');
              const selectedBgm=audioAssets.find(a=>a.id===project.assembly.bgmAssetId);
              const mpv=phaseView(musicJob);
              const musicActive=busyOf(musicJob);
              const musicWorking=musicActive&&!needsUserOf(mpv);
              const sceneCard=<Card className="scene-image-gen-card">
                <div className="subsection-head">
                  <div>
                    <h3>장면별 미디어</h3>
                    <p className="muted-text">장면마다 스토리보드에서 정한 종류(이미지·영상)로 Gemini에서 만들고 장면에 자동 연결합니다. 파일은 S01_image.png, S01_video.mp4처럼 장면 번호로 저장됩니다.</p>
                  </div>
                  <Tag tone="accent">{project.scenes.filter(s=>!!sceneAsset(project,s)).length} / {project.scenes.length} 장면 연결됨</Tag>
                </div>
                {project.scenes.length===0?<Empty title="스토리보드 장면이 없습니다" description="먼저 스토리보드와 생성 프롬프트를 준비하면 장면별로 Gemini 이미지·동영상을 생성할 수 있습니다." action={<Button size="sm" onClick={()=>go('storyboard')}>스토리보드로 이동</Button>}/>:<div className="scene-image-gen-list">
                  {project.scenes.map(s=>{
                    const linked=sceneAsset(project,s);
                    const isVideo=s.kind==='video';
                    const mainKind:'image'|'video'=isVideo?'video':'image';
                    const imgJob=imageJobs[s.id];const vidJob=videoJobs[s.id];
                    const mainJob=isVideo?vidJob:imgJob;const otherJob=isVideo?imgJob:vidJob;
                    const setImg=(u:GeminiJobRecord)=>setImageJobs(o=>({...o,[s.id]:u}));
                    const setVid=(u:GeminiJobRecord)=>setVideoJobs(o=>({...o,[s.id]:u}));
                    const setMain=isVideo?setVid:setImg;const setOther=isVideo?setImg:setVid;
                    const mainPv=phaseView(mainJob);const otherPv=phaseView(otherJob);
                    const mainPrompt=(isVideo?s.videoPrompt:s.imagePrompt)?.trim()||'';
                    const otherPrompt=(isVideo?s.imagePrompt:s.videoPrompt)?.trim()||'';
                    const refImage=isVideo?findSceneReferenceImage(project,s.id):null;
                    const videoLinked=isVideo&&linked?.kind==='video';
                    const startMain=()=>isVideo?startSceneVideo(s.id,refImage?{useReferenceImage:true}:undefined):startSceneImage(s.id);
                    const startOther=()=>isVideo?startSceneImage(s.id):startSceneVideo(s.id);
                    const startTextVideo=()=>startSceneVideo(s.id,{useReferenceImage:false});
                    const copyMain=()=>void (isVideo?copySceneVideoPrompt(s.id):copySceneImagePrompt(s.id));
                    const copyOther=()=>void (isVideo?copySceneImagePrompt(s.id):copySceneVideoPrompt(s.id));
                    const mainActive=busyOf(mainJob);const otherActive=busyOf(otherJob);
                    const mainWorking=mainActive&&!needsUserOf(mainPv);
                    const otherName=label[isVideo?'image':'video'].name;
                    const onImport=async()=>{const res=await studio.importAssets(s.id);if(res){const linkedNow=res.scenes.find(x=>x.id===s.id)?.assetId||res.scenes.find(x=>x.id===s.id)?.referenceImageAssetId;if(linkedNow)setActiveAsset(linkedNow);}};
                    const mainLabel=isVideo
                      ?(refImage?(videoLinked?'기준 이미지로 동영상 다시 생성':'기준 이미지로 동영상 생성'):(videoLinked?'동영상 다시 생성':'Gemini로 동영상 생성'))
                      :(linked?`${label[mainKind].name} 다시 생성`:'Gemini로 이미지 생성');
                    return <div key={s.id} className={`scene-image-gen-row ${linked?'has-asset':''}`}>
                      <div className="scene-image-gen-thumb" onClick={()=>{if(linked)setActiveAsset(linked.id);}}>
                        <Photo project={project} asset={linked}/>
                      </div>
                      <div className="scene-image-gen-main">
                        <div className="scene-image-gen-top">
                          <strong>{s.id} · {s.title}</strong>
                          <KindBadge kind={s.kind}/>
                          {linked?<Tag tone="success"><Check size={12}/> {linked.name}</Tag>:<Tag tone="muted">미디어 미연결</Tag>}
                          {refImage&&<Tag tone="accent">기준 이미지 연결됨 · {refImage.name}</Tag>}
                          {mainPv&&<Tag tone={mainPv.tone==='danger'?'warning':mainPv.tone}>{label[mainKind].name} · {mainPv.label}</Tag>}
                          {otherPv&&<Tag tone={otherPv.tone==='danger'?'warning':otherPv.tone}>{otherName} · {otherPv.label}</Tag>}
                        </div>
                        {mainPrompt?<p className="scene-image-gen-prompt">{mainPrompt}</p>:<p className="scene-image-gen-noprompt">{label[mainKind].name} 프롬프트가 비어 있습니다. 생성 프롬프트 단계에서 먼저 작성해 주세요.</p>}
                        {recoveryBox(mainJob,mainKind,`미디어 가져와서 ${s.id}에 연결`,()=>void onImport(),setMain,startMain)}
                        {recoveryBox(otherJob,isVideo?'image':'video',`미디어 가져와서 ${s.id}에 연결`,()=>void onImport(),setOther,startOther)}
                      </div>
                      <div className="scene-image-gen-actions">
                        <div className="scene-media-btn-row">
                          {!mainPrompt?<Button size="sm" kind="outline" onClick={()=>go('prompt')}>프롬프트 작성</Button>
                            :mainWorking?<Button size="sm" kind="secondary" disabled>{isVideo?<Film size={14}/>:<Sparkles size={14}/>} {mainPv?.label||'생성 중…'}</Button>
                            :mainActive?null
                            :<Button size="sm" onClick={()=>void startMain()}>{isVideo?<Film size={14}/>:<Sparkles size={14}/>} {mainLabel}</Button>}
                          {isVideo&&!refImage&&!mainWorking&&!mainActive&&<Button size="sm" kind="outline" disabled={!otherPrompt||otherActive} title={otherPrompt?'':'이미지 프롬프트가 없습니다'} onClick={()=>void startSceneImage(s.id)}><ImageIcon size={14}/> 기준 이미지 먼저 만들기</Button>}
                          <details className="more-menu">
                            <summary aria-label="더 보기" title="더 보기"><MoreHorizontal size={15}/></summary>
                            <div className="more-menu-list">
                              {mainPrompt&&<button type="button" onClick={copyMain}><Copy size={13}/> {label[mainKind].name} 프롬프트 복사</button>}
                              {isVideo&&refImage&&mainPrompt&&<button type="button" disabled={mainActive} onClick={()=>void startTextVideo()}><Film size={13}/> 텍스트만으로 동영상 생성</button>}
                              {isVideo&&refImage&&<button type="button" disabled={!otherPrompt||otherActive} title={otherPrompt?'':'이미지 프롬프트가 없습니다'} onClick={()=>void startSceneImage(s.id)}><ImageIcon size={13}/> 기준 이미지 다시 만들기</button>}
                              {!isVideo&&<button type="button" disabled={!otherPrompt||otherActive} title={otherPrompt?'':`${otherName} 프롬프트가 없습니다`} onClick={()=>void startOther()}><Film size={13}/> 동영상으로도 만들기</button>}
                              {otherPrompt&&<button type="button" onClick={copyOther}><Copy size={13}/> {otherName} 프롬프트 복사</button>}
                              <button type="button" onClick={()=>void onImport()}><Upload size={13}/> 파일 가져와서 연결</button>
                            </div>
                          </details>
                        </div>
                        <div className="scene-media-btn-row">
                          {mainActive&&mainJob&&<Button size="sm" kind="ghost" onClick={()=>void cancelJob(mainJob,setMain,label[mainKind].name)}>{label[mainKind].name} 취소</Button>}
                          {otherActive&&otherJob&&<Button size="sm" kind="ghost" onClick={()=>void cancelJob(otherJob,setOther,otherName)}>{otherName} 취소</Button>}
                        </div>
                      </div>
                    </div>;
                  })}
                </div>}
              </Card>;
              const bgmCard=<Card className="bgm-gen-card">
                <div className="subsection-head">
                  <div>
                    <h3>작품 배경음악(BGM)</h3>
                    <p className="muted-text">장면에 연결되지 않고 BGM_01.mp3처럼 오디오 보관함에 저장되어 「최종 편집안」 배경음악 선택 목록에 나타납니다.</p>
                  </div>
                  <div className="bgm-status-tags">
                    <Tag tone={audioAssets.length?'success':'muted'}><Music2 size={12}/> 오디오 {audioAssets.length}개</Tag>
                    <Tag tone={selectedBgm?'accent':'muted'}>선택 BGM: {selectedBgm?selectedBgm.name:'미선택'}</Tag>
                    {mpv&&<Tag tone={mpv.tone==='danger'?'warning':mpv.tone}>Gemini · {mpv.label}</Tag>}
                  </div>
                </div>
                <div className="bgm-gen-body">
                  <div className="bgm-gen-main">
                    {bgmPromptText?<p className="scene-image-gen-prompt"><strong>BGM 프롬프트:</strong> {bgmPromptText}</p>:<p className="scene-image-gen-noprompt">작품의 배경음악 프롬프트(bgmPrompt)가 없습니다. 생성 프롬프트 단계에서 프롬프트를 먼저 생성해 주세요.</p>}
                    {recoveryBox(musicJob,'music','배경음악 파일 가져오기',()=>void studio.importAssets(),u=>setMusicJob(u),startProjectMusic)}
                  </div>
                  <div className="bgm-gen-actions">
                    {!bgmPromptText?<Button size="sm" kind="outline" onClick={()=>go('prompt')}>프롬프트 단계 열기</Button>:musicWorking?<Button size="sm" kind="secondary" disabled><Music2 size={14}/> {mpv?.label||'생성 중…'}</Button>:musicActive?null:<Button size="sm" onClick={()=>void startProjectMusic()}><Music2 size={14}/> 배경음악 생성</Button>}
                    {bgmPromptText&&<Button size="sm" kind="outline" onClick={()=>void copyProjectMusicPrompt()}><Copy size={13}/> BGM 프롬프트 복사</Button>}
                    {musicActive&&musicJob&&<Button size="sm" kind="ghost" onClick={()=>void cancelJob(musicJob,u=>setMusicJob(u),'배경음악')}>배경음악 취소</Button>}
                  </div>
                </div>
              </Card>;
              return <>{sceneCard}{bgmCard}</>;
            })()}
            <div className="media-layout"><div className="media-list"><div className="subsection-head"><h3>프로젝트 미디어</h3><Tag>{project.assets.length}개 파일</Tag></div>{project.assets.length?<div className="asset-grid">{project.assets.map(a=><button key={a.id} className={`asset-card ${activeAsset===a.id?'selected':''}`} onClick={()=>setActiveAsset(a.id)}><div className="asset-preview"><Photo project={project} asset={a}/></div><div className="asset-info"><span>{a.name}</span><small>{a.kind.toUpperCase()} · {fileSize(a.bytes)}</small></div></button>)}</div>:<Empty title="미디어를 가져오세요" description="위 장면별 「Gemini로 이미지 생성」을 사용하거나, 다운로드한 이미지·영상·음악 파일을 이 프로젝트에 복사해 저장합니다." action={<Button kind="secondary" onClick={()=>void studio.importAssets()}><Upload size={15}/> 파일 선택</Button>}/>}</div>
              <aside className="media-inspector"><div className="subsection-head"><h3>파일 정보</h3></div>{activeMedia?<><div className="inspector-preview"><Photo project={project} asset={activeMedia}/></div><h3 className="inspector-filename">{activeMedia.name}</h3><div className="inspector-props"><div><span>유형</span><b>{activeMedia.kind}</b></div><div><span>파일 크기</span><b>{fileSize(activeMedia.bytes)}</b></div><div><span>연결된 장면</span><b>{project.scenes.find(s=>s.assetId===activeMedia.id||s.referenceImageAssetId===activeMedia.id)?.id||'없음'}</b></div></div>{activeMedia.kind==='audio'&&<audio controls src={mediaUrl(project,activeMedia)} style={{width:'100%'}}/>}<div className="subsection-head"><h3>장면에 연결</h3></div>{activeMedia.kind==='audio'?<p className="muted-text" style={{marginBottom:16}}>오디오 파일은 최종 편집안의 배경음악 선택에서 연결합니다.</p>:<div className="scene-link-list">{project.scenes.map(s=><button className={`scene-link ${s.assetId===activeMedia.id?'selected':''}`} key={s.id} onClick={()=>void mutate(p=>({...p,scenes:p.scenes.map(scene=>scene.id===s.id?{...scene,assetId:activeMedia.id}:scene)}))}><span>{s.id} · {s.title}</span>{s.assetId===activeMedia.id&&<Check size={15}/>}</button>)}</div>}<Button kind="outline" onClick={()=>void window.studio.assets.reveal(project.id,activeMedia.id)}><FolderOpen size={15}/> 탐색기에서 보기</Button></>:<p className="inspector-empty">파일을 선택하면 상세 정보와 장면 연결 설정이 나타납니다.</p>}</aside></div>
          </div>})}
        {project&&view==='assembly'&&renderStep('assembly',{
          actions:<><Button size="sm" kind="outline" onClick={()=>void mutate(p=>{const q=withSceneEffects(p);return {...q,assembly:{...q.assembly,clips:clipsFromScenes(q)}};})} disabled={!project.scenes.length}><ListOrdered size={14}/> 장면 순서로 구성</Button>{stageButton('editplan',!project.scenes.length)}<Button size="sm" kind="outline" onClick={()=>openStage('editplan',false)} disabled={!project.scenes.length}>상세·수동 연결</Button></>,
          body:<div className="step-body">
            {(project.reviewNeeded?.editplan||project.reviewNeeded?.subtitles)&&<div className="review-needed-banner"><ShieldAlert size={16}/><div><strong>기준 원문 변경 — 편집안·자막 재검토 필요</strong><span>원문이 수정되어 기존 자막이 새 원문과 다를 수 있습니다. 스토리보드와 최종 편집안을 확인하세요.</span></div></div>}
            {stageBanner('editplan')}
            <div className="assembly-layout"><div className="assembly-main"><Card><div className="subsection-head"><h3>타임라인 초안</h3><Tag tone="accent">{project.assembly.clips.length} 클립</Tag></div>{project.assembly.clips.length?<div className="assembly-rows">{project.assembly.clips.map((c,i)=>{const scene=project.scenes.find(s=>s.id===c.sceneId);const asset=scene?sceneAsset(project,scene):null;return <div className="assembly-row" key={i}><div className="assembly-thumb">{asset?<Photo project={project} asset={asset}/>:<ImageIcon size={19}/>}</div><div className="assembly-row-name"><strong>{scene?.title||c.sceneId}</strong><small>{c.sceneId} · {asset?.name||'파일 미연결'}</small>{scene?.effects?.shots?.length?<small className="assembly-shots">{describeShots(scene.effects.shots)}</small>:null}</div><div className="assembly-row-controls"><label><span>초</span><input aria-label={`${c.sceneId} 재생 시간`} type="number" min={1} max={600} value={c.durationSec} onChange={e=>void mutate(p=>({...p,assembly:{...p.assembly,clips:p.assembly.clips.map((x,j)=>j===i?{...x,durationSec:Math.max(1,Number(e.target.value)||1)}:x)}}))}/></label><select aria-label="전환 효과" value={c.transition} onChange={e=>void mutate(p=>({...p,assembly:{...p.assembly,clips:p.assembly.clips.map((x,j)=>j===i?{...x,transition:e.target.value as EditClip['transition']}:x)}}))}>{TRANSITION_TYPES.map(t=><option key={t} value={t}>{TRANSITION_LABEL[t]}</option>)}</select><label><span>전환</span><input aria-label={`${c.sceneId} 전환 길이`} type="number" min={0} max={3} step={0.1} value={c.transition==='cut'?0:(c.transitionSec??1)} disabled={c.transition==='cut'} onChange={e=>void mutate(p=>({...p,assembly:{...p.assembly,clips:p.assembly.clips.map((x,j)=>j===i?{...x,transitionSec:Math.min(3,Math.max(0,Number(e.target.value)||0))}:x)}}))}/></label></div></div>;})}</div>:<Empty title="아직 최종 편집안이 없습니다" description="AI에게 최종 구성안을 요청하거나 스토리보드 순서대로 초안을 만들 수 있습니다." action={<Button onClick={()=>void mutate(p=>{const q=withSceneEffects(p);return {...q,assembly:{...q.assembly,clips:clipsFromScenes(q)}};})} disabled={!project.scenes.length}>편집 초안 만들기</Button>}/>}</Card>
                <Card><div className="subsection-head"><h3>원문 자막 미리보기</h3><Tag>임시 시간</Tag></div>{project.assembly.clips.length?<div className="subtitle-lines">{buildTimeline(project).flatMap(seg=>seg.captions.length?seg.captions.map((c,k)=><div key={`${seg.sceneId}-${k}`}><span>{c.start.toFixed(1)}s – {c.end.toFixed(1)}s</span><p>{c.text}</p></div>):[<div key={seg.sceneId}><span>{seg.start.toFixed(1)}s – {seg.end.toFixed(1)}s</span><p className="muted-text">{seg.title} · 자막 없음</p></div>])}</div>:<p className="muted-text">편집안이 생성되면 예상 시간에 맞춘 자막이 여기에 나타납니다.</p>}<div className="inline-notice"><Mic2 size={16}/> 실제 녹음에 맞춘 자막 시간 조정은 더빙 프로그램에서 진행합니다.</div></Card></div>
              <aside className="media-inspector assembly-inspector"><h3>편집 기본 설정</h3><Field label="전환 기본값"><select value={project.assembly.transitionDefault} onChange={e=>void mutate(p=>({...p,assembly:{...p.assembly,transitionDefault:e.target.value as TransitionType}}))}>{TRANSITION_TYPES.map(t=><option key={t} value={t}>{TRANSITION_LABEL[t]}</option>)}</select></Field><Field label="배경음악"><select value={project.assembly.bgmAssetId||''} onChange={e=>void mutate(p=>({...p,assembly:{...p.assembly,bgmAssetId:e.target.value||null}}))}><option value="">사용하지 않음</option>{project.assets.filter(a=>a.kind==='audio').map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="자막 기본값"><select value={project.assembly.subtitleMode} onChange={e=>void mutate(p=>({...p,assembly:{...p.assembly,subtitleMode:e.target.value as 'original'|'none'}}))}><option value="original">확정 원문으로 생성</option><option value="none">자막 없음</option></select></Field><div className="assembly-total"><span>예상 전체 길이</span><strong>{project.assembly.clips.reduce((n,c)=>n+c.durationSec,0)}<small>초</small></strong></div><div className="inline-notice"><Info size={16}/> 영상 렌더링은 이 프로그램에서 수행하지 않습니다.</div></aside></div>
          </div>})}
        {project&&view==='handoff'&&renderStep('handoff',{
          primaryLabel:'제작 패키지 내보내기',
          onPrimary:()=>void studio.exportFolder(),
          body:<div className="step-body">
            <div className="handoff-layout"><Card className="handoff-main"><div className="handoff-icon"><Clapperboard size={30}/></div><h2>목소리를 더해<br/>작품을 완성하세요.</h2><p>창작실은 여기서 작업을 마칩니다. 아래 「제작 패키지 내보내기」를 누르면 패키지 폴더가 만들어집니다. 최종 영상 조립, 사람 목소리 녹음, 자막 정렬, 렌더링은 별도 더빙 프로그램에서 진행하세요.</p><div className="handoff-steps"><div><CheckCircle2 size={18}/><span>작품 원문 · 스토리보드 저장</span></div><div><CheckCircle2 size={18}/><span>이미지·영상·음악 파일 함께 전달</span></div><div><CheckCircle2 size={18}/><span>편집안 JSON · 가능한 경우 더빙용 프로젝트 초안 포함</span></div></div><div className="inline-notice"><Info size={16}/> 미디어가 모두 연결되면 composer_project.json 및 captions.srt 초안을 함께 출력합니다. 기존 더빙 프로그램에서 열기 전 실제 호환성 검증이 필요합니다.</div></Card>
              <Card className="handoff-check"><h3>최종 점검</h3>{readyForHandoff(project).warnings.length?<><Tag tone="warning"><ShieldAlert size={13}/> 확인 항목 있음</Tag><div className="checklist">{readyForHandoff(project).warnings.map((w,i)=><div key={i} className="check-warning"><ShieldAlert size={17}/><span>{w}</span></div>)}</div></>:<><Tag tone="success"><Check size={13}/> 준비 완료</Tag><p>모든 필수 항목이 준비되었습니다.</p></>}<div className="handoff-summary"><div><span>장면</span><strong>{project.scenes.length}개</strong></div><div><span>미디어</span><strong>{project.assets.length}개</strong></div><div><span>예상 길이</span><strong>{project.assembly.clips.reduce((n,c)=>n+c.durationSec,0)}초</strong></div></div></Card></div>
          </div>})}
        {view==='settings'&&pageLayout(<Settings2 size={16}/>,'환경 설정',null,<>
          <div className="settings-grid">
            <Card className="theme-settings-card">
              <div className="setting-head"><div className="setting-icon"><Palette size={21}/></div><div><h3>화면 테마</h3><p>프로그램 전체 색상을 즉시 변경합니다. 재시작 없이 적용됩니다.</p></div></div>
              <div className="theme-grid">
                {(Object.keys(THEME_META) as ThemeId[]).map(id => {
                  const meta = THEME_META[id];
                  const tokens = THEMES[id];
                  const selected = themeApi.effectiveTheme === id;
                  return (
                    <button key={id} className={`theme-card ${selected ? 'selected' : ''}`} onClick={() => themeApi.setTheme(id)} type="button">
                      <div className="theme-preview" style={{ background: tokens['--color-bg'] }}>
                        <div className="theme-preview-sidebar" style={{ background: tokens['--color-sidebar'] }} />
                        <div className="theme-preview-main">
                          <div className="theme-preview-bar" style={{ background: tokens['--color-topbar'], borderColor: tokens['--color-border'] }} />
                          <div className="theme-preview-card" style={{ background: tokens['--color-surface'], borderColor: tokens['--color-border'] }} />
                        </div>
                      </div>
                      <div className="theme-card-info">
                        <strong>{meta.name}</strong>
                        <span>{meta.nameEn}</span>
                      </div>
                      <div className="theme-swatches">
                        <i style={{ background: tokens['--color-primary'] }} />
                        <i style={{ background: tokens['--color-text'] }} />
                        <i style={{ background: tokens['--color-border'] }} />
                      </div>
                      {selected && <div className="theme-check"><Check size={14}/></div>}
                    </button>
                  );
                })}
              </div>
              <label className="system-sync-row">
                <input type="checkbox" checked={themeApi.systemSync} onChange={e => themeApi.setSystemSync(e.target.checked)} />
                <span>Windows 시스템 테마에 따라 자동 변경</span>
              </label>
              <p className="setting-note">켜면 Windows가 밝은 테마일 때 화이트 블루, 어두운 테마일 때 다크를 사용합니다. 끄면 마지막으로 직접 선택한 테마가 유지됩니다.</p>
            </Card>
            <Card>
              <div className="setting-head"><div className="setting-icon"><Sparkles size={21}/></div><div><h3>AI 연결 · Google Gemini</h3><p>Chrome Native Messaging으로 일반 Chrome의 Gemini 탭과 연결합니다. API 키를 사용하지 않습니다.</p></div></div>
              <div className="setting-line"><div><strong>연결 방식</strong><small>Chrome 웹 로그인 (Native Messaging)</small></div><Tag tone="muted">Chrome</Tag></div>
              <div className="setting-line"><div><strong>수동 JSON 워크벤치</strong><small>기획·장면·프롬프트·편집 구성</small></div><Tag tone="success">사용 가능</Tag></div>
              <div className="ai-connect-actions">
                <Button size="sm" kind="secondary" onClick={async () => {
                  try {
                    const s = await window.studio.gemini.status();
                    const g = s.versionIssue ? ERROR_GUIDE[s.versionIssue.code] : undefined;
                    setProbe([s.diagnosticText || s.message, ...(g ? ['', '해결 방법: ' + g.fix] : [])].join('\n'));
                    flash(s.message, s.versionIssue ? 'error' : s.connected ? 'success' : 'info');
                  } catch (e) { flash(String(e), 'error'); }
                }}>연결 상태 확인</Button>
                <Button size="sm" kind="outline" onClick={async () => {
                  try {
                    const r = await window.studio.gemini.ping();
                    flash(r.message, r.ok ? 'success' : 'error');
                  } catch (e) { flash(String(e), 'error'); }
                }}>테스트 요청 (PING)</Button>
                <Button size="sm" kind="outline" onClick={async () => {
                  setProbe('Gemini 탭 확인 중… (아무것도 입력·전송하지 않습니다)');
                  try { const r = await window.studio.gemini.probe(); setProbe(JSON.stringify(r, null, 2)); flash(r.ok ? '선택자 진단을 받았습니다.' : (r.message || '진단 실패'), r.ok ? 'success' : 'error'); }
                  catch (e) { setProbe(String(e)); }
                }}>선택자 진단 (전송 없음)</Button>
                <Button size="sm" kind="ghost" onClick={() => window.open('https://gemini.google.com/', '_blank')}>Gemini 열기</Button>
              </div>
              {probe&&<details className="automation-details" open><summary>연결·진단 결과 (복사해서 보내 주세요 · 프롬프트·응답 내용 없음)</summary><div className="details-actions"><Button size="sm" kind="secondary" onClick={()=>void copy(probe)}><Copy size={14}/> 복사</Button></div><pre>{probe}</pre></details>}
              <p className="setting-note">Chrome 확장 프로그램과 Native Host가 설치·등록되어야 연결됩니다. 연결이 실패해도 기존 기능은 정상 작동합니다. 기획 분석 자동 전송은 실제 Gemini에서 확인되었고, 장면 구성·생성 프롬프트·최종 편집 구성은 같은 경로를 씁니다. 먼저 「선택자 진단」으로 입력창·전송 버튼이 인식되는지 확인하세요.</p>
            </Card>
            <JobQueueCard flash={flash}/>
            <Card><div className="setting-head"><div className="setting-icon"><FolderOpen size={21}/></div><div><h3>로컬 데이터</h3><p>프로젝트와 미디어는 컴퓨터에 저장됩니다.</p></div></div><div className="setting-line"><div><strong>데이터 폴더</strong><small className="path-text">{infoPath||'확인 중...'}</small></div></div><p className="setting-note">화면 표시용 브랜드를 변경해도 내부 프로젝트 스키마와 저장 경로는 유지합니다.</p></Card>
            <Card><div className="setting-head"><div className="setting-icon"><Palette size={21}/></div><div><h3>브랜드 관리</h3><p>초기 GOMO 표시 → 향후 NUNI 변경을 위한 구조</p></div></div><div className="setting-line"><div><strong>제품군</strong><small>{BRAND.suiteKo}</small></div><Tag>{BRAND.companyMark}</Tag></div><div className="setting-line"><div><strong>제품</strong><small>{BRAND.productKo}</small></div></div><p className="setting-note">브랜드 표시 이름: src/shared/brand.ts · 테마: src/renderer/theme/ · 설치 표시 이름: package.json</p></Card>
          </div>
        </>)}
        </>}
      </main>
      <footer className="statusbar">
        <div className={`status-save save-${project?saveState:'saved'}`}><span className="status-indicator"/>{project?`${SAVE_LABEL[saveState]} · ${formatTime(project.updatedAt)}`:'모든 작업은 이 컴퓨터에 저장돼요'}</div>
        {project&&<div className="status-mid"><span>작품 ID {project.id.slice(0,8)}</span><span>원문 v{project.brief.originalMeta?.version??'-'}</span><span title="완료한 제작 단계">{completed}/{TOTAL_STEPS} 단계</span></div>}
        <div className="status-right">{activeJob&&<button className="status-job" onClick={()=>openStage(activeJob.st,false)} title="AI 작업 창 열기"><Sparkles size={12}/> Gemini {STAGE_META[activeJob.st].name} · {activeJob.v!.label}</button>}<span>{BRAND.productKo} v{appVersion}</span></div>
      </footer>
    </div>
    {studio.toast&&<div className={`toast toast-${studio.toast.type}`} role="status"><Info size={17}/><span>{studio.toast.text}</span><button className="icon-btn" onClick={()=>studio.setToast(null)}><X size={16}/></button></div>}
  </div>;
}
function ArchivedList({onRestore}:{onRestore:(id:string)=>void}){const [all,setAll]=useState<Awaited<ReturnType<typeof window.studio.projects.list>>>([]);useEffect(()=>{void window.studio.projects.list(true).then(p=>setAll(p.filter(x=>x.archived)));},[]);return <div className="project-list">{all.length?all.map(p=><article className="project-row" key={p.id}><div className="row-icon"><Archive size={18}/></div><div className="row-primary"><h3>{p.title}</h3><p>{formatDate(p.updatedAt)} · 보관됨</p></div><Button size="sm" kind="secondary" onClick={()=>onRestore(p.id)}><RotateCcw size={14}/> 복원</Button></article>):<p className="muted-text">보관한 작품이 없어요.</p>}</div>;}
export default App;
