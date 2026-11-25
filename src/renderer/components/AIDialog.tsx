import {useEffect,useMemo,useRef,useState} from 'react';
import {AlertCircle,ArrowRight,CheckCircle2,ChevronDown,ClipboardPaste,Copy,FileJson2,Loader2,RefreshCw,Sparkles,X} from 'lucide-react';
import type {AIStage,GeminiJobRecord,StudioProject} from '../../shared/types';
import {applyAIResponse} from '../../shared/workflow';
import {makeAIPrompt} from '../../shared/prompts';
import {PROGRESS_STEPS,STAGE_META,guideFor,phaseView} from '../../shared/gemini-analysis';
import {Button,Tag} from './UI';
/** 새 요청을 시작해도 되는 상태 (나머지는 진행 중이거나 사용자 확인 대기) */
const TERMINAL:GeminiJobRecord['state'][]=['completed','failed','cancelled'];
type Props={project:StudioProject,stage:AIStage,onClose:()=>void,onApply:(p:StudioProject)=>Promise<boolean>,onCopy:(text:string)=>void,autoStart?:boolean,onNavigate?:(t:AINavTarget)=>void,flash?:(text:string,type?:'info'|'success'|'error')=>void};

/** 기존 수동 연결(프롬프트 복사 + JSON 붙여넣기). 모든 단계에서 접힌 보조 기능 */
function ManualPanel({project,stage,onApply,onCopy,onDone,initialAnswer}:{project:StudioProject,stage:AIStage,onApply:(p:StudioProject)=>Promise<boolean>,onCopy:(text:string)=>void,onDone:()=>void,initialAnswer?:string}){
  const [answer,setAnswer]=useState(initialAnswer??project.ai[stage]?.raw??'');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const prompt=useMemo(()=>makeAIPrompt(project,stage),[project,stage]);
  useEffect(()=>{setAnswer(initialAnswer??project.ai[stage]?.raw??'');setError('');},[project.id,stage,initialAnswer]);
  const validate=()=>{try{const next=applyAIResponse(project,stage,answer);setError('');return next;}catch(e){setError(e instanceof Error?e.message:String(e));return null;}};
  const apply=async()=>{const next=validate();if(!next)return;setBusy(true);const ok=await onApply(next);setBusy(false);if(ok)onDone();};
  return <div className="ai-columns"><div className="ai-pane"><div className="ai-pane-head"><div><strong>01. AI에게 보낼 요청</strong><p>기존 설계 규칙을 기반으로 자동 구성됩니다.</p></div><Button size="sm" kind="secondary" onClick={()=>onCopy(prompt)}><Copy size={15}/> 요청 복사</Button></div><textarea className="ai-prompt" value={prompt} readOnly spellCheck={false}/></div>
    <div className="ai-pane"><div className="ai-pane-head"><div><strong>02. JSON 결과 확인</strong><p>AI 응답을 그대로 붙여넣고 적용하세요.</p></div><Tag tone="muted"><FileJson2 size={12}/> Schema v1</Tag></div><textarea className="ai-response" spellCheck={false} value={answer} onChange={e=>{setAnswer(e.target.value);setError('');}} placeholder={'{\n  "schema": "creator.'+(stage==='editplan'?'editplan':stage==='prompt'?'prompts':stage)+'.v1",\n  ...\n}'}/>
      {error&&<div className="error-message"><AlertCircle size={15}/>{error}</div>}<div className="ai-actions"><Button size="sm" kind="outline" onClick={validate} disabled={!answer.trim()}>JSON 검사</Button><Button size="sm" onClick={()=>void apply()} disabled={!answer.trim()||busy}><CheckCircle2 size={16}/> 검사 후 적용</Button></div>
    </div></div>;
}

export type AINavTarget='select'|'storyboard'|'prompt'|'media'|'assembly'|'handoff';

/** 단계별 결과 요약과 다음 단계로 이어지는 버튼 */
function StageResult({project,stage,onNavigate,onClose}:{project:StudioProject,stage:AIStage,onNavigate?:(t:AINavTarget)=>void,onClose:()=>void}){
  const nav=(t:AINavTarget)=>{onNavigate?.(t);onClose();};
  const meta=STAGE_META[stage];
  if(stage==='analysis'&&project.analysis)return <div className="automation-result">
    <div className="micro">{meta.resultLabel}</div><h3>{project.analysis.summary}</h3><p>{project.analysis.emotion}</p>
    <div className="keywords">{project.analysis.keywords.map(k=><span key={k}>#{k}</span>)}</div>
    <div className="automation-choices"><div><strong>화풍 {project.analysis.styles.length}안</strong><ul>{project.analysis.styles.map(s=><li key={s.id}>{s.label}</li>)}</ul></div><div><strong>연출 {project.analysis.directions.length}안</strong><ul>{project.analysis.directions.map(s=><li key={s.id}>{s.label}</li>)}</ul></div></div>
    <div className="automation-cta"><span>JSON 검사를 통과해 작품에 저장했습니다. 이제 화풍과 연출안을 고르세요.</span><Button onClick={()=>nav('select')}>화풍·연출안 선택하기 <ArrowRight size={16}/></Button></div>
  </div>;
  if(stage==='storyboard'&&project.scenes.length){const total=project.scenes.reduce((n,s)=>n+s.durationSec,0);return <div className="automation-result">
    <div className="micro">{meta.resultLabel}</div><h3>장면 {project.scenes.length}개 · 예상 {total}초</h3><p>낭독 문장이 등록된 원문과 일치하는지 검사했습니다.</p>
    <ol className="automation-list">{project.scenes.map(s=><li key={s.id}><b>{s.id}</b> {s.title} <small>{s.kind==='video'?'영상':'이미지'} · {s.durationSec}초</small></li>)}</ol>
    <div className="automation-cta"><span>장면표를 확인·수정한 뒤 생성 프롬프트를 만드세요.</span><Button kind="secondary" onClick={()=>nav('storyboard')}>장면표 확인하기</Button><Button onClick={()=>nav('prompt')}>생성 프롬프트로 <ArrowRight size={16}/></Button></div>
  </div>;}
  if(stage==='prompt'&&project.scenes.some(s=>s.imagePrompt)){const n=project.scenes.filter(s=>s.imagePrompt).length;return <div className="automation-result">
    <div className="micro">{meta.resultLabel}</div><h3>장면 {n}/{project.scenes.length}개 프롬프트 생성</h3><p>장면마다 이미지·영상·제외 프롬프트를 저장했습니다.</p>
    <ol className="automation-list">{project.scenes.map(s=><li key={s.id}><b>{s.id}</b> {s.imagePrompt.slice(0,90)}{s.imagePrompt.length>90?'…':''}</li>)}</ol>
    <div className="automation-cta"><span>프롬프트로 이미지·영상을 만든 뒤 미디어를 연결하세요.</span><Button kind="secondary" onClick={()=>nav('prompt')}>프롬프트 확인하기</Button><Button onClick={()=>nav('media')}>미디어 제작으로 <ArrowRight size={16}/></Button></div>
  </div>;}
  if(stage==='editplan'&&project.assembly.clips.length){const total=project.assembly.clips.reduce((n,c)=>n+c.durationSec,0);return <div className="automation-result">
    <div className="micro">{meta.resultLabel}</div><h3>클립 {project.assembly.clips.length}개 · {total}초</h3><p>{project.ai.editplan.raw?'편집 순서·길이·전환을 저장했습니다.':''}</p>
    <ol className="automation-list">{project.assembly.clips.map((c,i)=><li key={c.sceneId+i}><b>{c.sceneId}</b> {c.durationSec}초 · {c.transition}</li>)}</ol>
    <div className="automation-cta"><span>편집안을 확인한 뒤 더빙 프로그램으로 전달하세요.</span><Button kind="secondary" onClick={()=>nav('assembly')}>편집안 확인하기</Button><Button onClick={()=>nav('handoff')}>더빙 전달로 <ArrowRight size={16}/></Button></div>
  </div>;}
  return null;
}

/** AI 단계 자동화 화면 (기획 분석·스토리보드·생성 프롬프트·최종 편집 구성 공용).
 *  작업 상태는 main의 작업 큐에 저장되므로 창을 닫아도 유지됩니다. */
function StageAutomation({project,stage,onClose,onApply,onCopy,autoStart,onNavigate,flash}:Props){
  const meta=STAGE_META[stage];
  const [job,setJob]=useState<GeminiJobRecord|null>(null);const [loaded,setLoaded]=useState(false);
  const [starting,setStarting]=useState(false);const [notice,setNotice]=useState('');const [manualOpen,setManualOpen]=useState(false);
  const autoStarted=useRef(false);
  const view=phaseView(job);const guide=guideFor(job);
  const label=view?.phase==='done'?meta.doneLabel:view?.label;
  useEffect(()=>{
    let alive=true;setLoaded(false);setJob(null);
    void window.studio.gemini.analysis.latest(project.id,stage).then(j=>{if(alive){setJob(j);setLoaded(true);}}).catch(()=>{if(alive)setLoaded(true);});
    const off=window.studio.gemini.onJobUpdate(j=>{if(j.projectId!==project.id||j.kind!==stage)return;setJob(cur=>!cur||j.jobId===cur.jobId||j.createdAt>=cur.createdAt?j:cur);});
    return()=>{alive=false;off();};
  },[project.id,stage]);
  const prerequisite=meta.prerequisite(project);
  const start=async(confirmReset=true)=>{
    if(starting||(job&&!TERMINAL.includes(job.state)))return;
    if(prerequisite){setNotice(prerequisite);return;}
    const warn=meta.resetWarning(project);
    if(confirmReset&&warn&&!confirm(warn))return;
    setStarting(true);setNotice('');
    try{const r=await window.studio.gemini.analysis.start(project.id,stage);if(r.job)setJob(r.job);if(r.message)setNotice(r.message);if(!r.ok)flash?.(r.message||'시작하지 못했습니다.','error');}
    catch(e){setNotice(String(e));}
    finally{setStarting(false);}
  };
  // 페이지의 시작 버튼으로 열린 경우: 진행 중인 작업이 없을 때만 한 번 자동 시작 (StrictMode 이중 실행 방지)
  useEffect(()=>{if(!autoStart||!loaded||autoStarted.current)return;autoStarted.current=true;if(!job||TERMINAL.includes(job.state))void start(true);},[autoStart,loaded]);
  const act=async(fn:()=>Promise<unknown>,msg?:string)=>{try{await fn();if(msg)setNotice(msg);}catch(e){setNotice(String(e));}};
  const jobs=window.studio.gemini.jobs;
  const applied=job?.outcome==='applied'&&project.revision>=(job.appliedRevision||0);
  const stepState=(i:number)=>{if(!view)return '';if(view.phase==='done')return 'done';if(i<view.step)return 'done';if(i===view.step)return view.phase==='error'?'error':view.phase==='needs_user'?'warn':'current';return '';};
  const canStart=!job||TERMINAL.includes(job.state);
  const steps=PROGRESS_STEPS.map(s=>s.key==='done'?{...s,label:meta.doneLabel}:s);
  const prompt=job?.prompt||makeAIPrompt(project,stage);
  return <>
    <div className="modal-head"><div className="modal-head-icon"><Sparkles size={21}/></div><div><div className="eyebrow">AI WORKBENCH · GEMINI</div><h2>{meta.name} · AI 자동 연결</h2><p>버튼 한 번으로 Chrome의 Gemini 탭에 요청을 보내고, 응답 JSON({meta.schema})을 검사해 작품에 바로 반영합니다.</p></div>{view&&<Tag tone={view.tone==='danger'?'warning':view.tone}>{label}</Tag>}<button className="icon-btn" onClick={onClose} aria-label="닫기"><X size={19}/></button></div>
    <div className="automation-body">
      <div className="automation-start">
        <div><strong>{applied?`${meta.name} 결과가 작품에 반영되었습니다`:view?.active?'Gemini와 작업 중입니다':`AI ${meta.name}`}</strong><p>{view?.active?'이 창을 닫아도 작업은 계속되며, 다시 열면 진행 상황을 볼 수 있습니다.':prerequisite||'로그인된 Chrome의 Gemini 탭(지금 열린 대화)을 사용합니다. 프롬프트 복사나 JSON 붙여넣기가 필요 없습니다.'}</p></div>
        {canStart&&<Button size="lg" onClick={()=>void start(true)} disabled={starting||!loaded||!!prerequisite}>{starting?<Loader2 size={17} className="spin"/>:<Sparkles size={17}/>} {job?meta.restartLabel:meta.startLabel}</Button>}
        {view?.active&&<Button kind="ghost" size="sm" onClick={()=>void act(()=>jobs.cancel(job!.jobId),'중단을 요청했습니다. Gemini 화면의 생성은 직접 확인해 주세요.')}>중단</Button>}
      </div>
      {job&&<ol className="automation-steps" aria-label="진행 단계">{steps.map((s,i)=><li key={s.key} className={stepState(i)}><span className="step-dot">{stepState(i)==='done'?<CheckCircle2 size={14}/>:stepState(i)==='current'?<Loader2 size={14} className="spin"/>:i+1}</span><span>{s.label}</span></li>)}</ol>}
      {job&&<div className={`automation-status tone-${view?.tone}`} role="status">
        <strong>{label}</strong>
        <span>{job.phase==='collecting'&&job.progressChars?`응답 ${job.progressChars.toLocaleString()}자 수집 중`:job.tab?.title?`Gemini 탭: ${job.tab.title}`:''}</span>
        <small>{meta.name} · 작업 {job.jobId.slice(0,8)} · 요청 {job.requestId.slice(0,8)} · 작품 {job.projectId.slice(0,8)}</small>
      </div>}
      {notice&&<p className="automation-notice">{notice}</p>}
      {guide&&(view?.phase==='needs_user'||view?.phase==='error')&&<div className={`automation-guide ${view.phase==='error'?'is-error':''}`}>
        <AlertCircle size={17}/><div><strong>{guide.cause}</strong><p>{guide.fix}</p>{job?.errorMessage&&job.errorMessage!==guide.cause&&<small>{job.errorMessage}</small>}
          <div className="ai-connect-actions">
            {job?.state==='failed'&&job.executable&&<Button size="sm" onClick={()=>void act(()=>jobs.retry(job.jobId),'다시 시도합니다.')}><RefreshCw size={14}/> 다시 시도</Button>}
            {job?.state==='needs_confirmation'&&!job.sendConfirmed&&<Button size="sm" kind="secondary" onClick={()=>void act(()=>jobs.continue(job.jobId),'재전송 없이 응답을 기다립니다.')}>Gemini에 올라간 것을 확인함 · 응답 기다리기</Button>}
            {job?.state==='needs_confirmation'&&!job.sendConfirmed&&<Button size="sm" kind="outline" onClick={()=>{if(confirm('Gemini 화면에 이 요청이 올라가지 않은 것을 확인하셨나요? 같은 요청을 한 번 더 보냅니다.'))void act(()=>jobs.confirm(job.jobId),'확인 후 다시 보냅니다.');}}>올라가지 않음 · 다시 보내기</Button>}
            {job?.state==='needs_confirmation'&&job.sendConfirmed&&<><Button size="sm" onClick={()=>void act(async()=>{const r=await window.studio.gemini.analysis.fetchResult(job.jobId);setNotice(r.message||'');})}>응답 다시 가져오기</Button><Button size="sm" kind="secondary" onClick={()=>void act(()=>jobs.continue(job.jobId),'계속 기다립니다.')}>계속 기다리기</Button></>}
            {job?.state==='completed'&&job.outcome==='stale'&&job.errorCode!=='OTHER_PROJECT'&&job.errorCode!=='PROJECT_NOT_FOUND'&&job.errorCode!=='WRONG_KIND'&&<Button size="sm" onClick={()=>{if(confirm(`이 응답을 현재 작품의 ${meta.name}에 적용할까요? ${meta.resetWarning(project)||''}`))void act(()=>window.studio.gemini.analysis.applyResult(job.jobId,stage));}}>이 결과 적용</Button>}
            {job?.state==='completed'&&job.outcome==='invalid'&&<Button size="sm" kind="secondary" onClick={()=>setManualOpen(true)}>응답을 직접 고쳐 적용</Button>}
            {job?.state==='needs_confirmation'&&<Button size="sm" kind="ghost" onClick={()=>void act(()=>jobs.cancel(job.jobId),'작업을 닫았습니다.')}>작업 닫기</Button>}
          </div></div></div>}
      {applied&&<StageResult project={project} stage={stage} onNavigate={onNavigate} onClose={onClose}/>}
      {job?.diagnostics&&<details className="automation-details" open={view?.phase==='needs_user'||view?.phase==='error'}><summary><ChevronDown size={14}/> 진단 정보 (복사해서 보내 주세요 · 프롬프트·응답 내용 없음)</summary><div className="details-actions"><Button size="sm" kind="secondary" onClick={()=>onCopy(job.diagnostics||'')}><Copy size={14}/> 진단 정보 복사</Button></div><pre>{job.diagnostics}</pre></details>}
      <details className="automation-details"><summary><ChevronDown size={14}/> 보낸 프롬프트 보기</summary><div className="details-actions"><Button size="sm" kind="secondary" onClick={()=>onCopy(prompt)}><Copy size={14}/> 복사</Button></div><pre>{prompt}</pre></details>
      {job?.resultText&&<details className="automation-details"><summary><ChevronDown size={14}/> Gemini 응답 원문 보기{job.codeBlocks?.length?` · 코드 블록 ${job.codeBlocks.length}개`:''}</summary><pre>{job.resultText}</pre></details>}
      <details className="automation-details" open={manualOpen} onToggle={e=>setManualOpen((e.target as HTMLDetailsElement).open)}><summary><ClipboardPaste size={14}/> 수동 연결 (복사·붙여넣기) — 보조 기능</summary>
        {manualOpen&&<ManualPanel project={project} stage={stage} onApply={onApply} onCopy={onCopy} onDone={onClose} initialAnswer={job?.outcome==='invalid'?job.resultText:undefined}/>}
      </details>
    </div>
    <div className="ai-footnote"><ClipboardPaste size={15}/> 전송 여부가 불분명하면 자동으로 다시 보내지 않습니다. 다른 작품·다른 단계의 응답이나 늦게 도착한 중복 응답은 적용되지 않습니다.</div>
  </>;
}

/** 오른쪽에 붙는 AI 작업 창 (팝업 대신: 화면을 가리지 않고 진행 상황·수동 연결을 함께 봄) */
export function AIDock(props:Props){
  return <aside className="side-panel ai-dock" role="complementary" aria-label="AI 작업 창">
    <StageAutomation {...props}/>
  </aside>;
}

export function AIDialog(props:Props){
  const {onClose}=props;
  return <div className="modal-backdrop ai-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal ai-modal" role="dialog" aria-modal="true" aria-label="AI 연결 워크벤치">
    <StageAutomation {...props}/>
  </section></div>;
}
