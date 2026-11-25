import {useEffect,useRef,useState} from 'react';
import {BookOpen,ChevronDown,ChevronRight,ExternalLink,Lock,Search,X} from 'lucide-react';
import type {AutoFillField,Audience,Brief,Genre,StudioProject} from '../../shared/types';
import {AUDIENCES,GENRES} from '../../shared/workflow';
import {RIGHTS_STATUS_META} from '../../shared/copyright';
import {assessOriginalChangeImpact} from '../../shared/original-versioning';
import {AUTO_FILL_FIELDS,AUTO_FILL_LABELS,clearAutoFilled,userFieldsToOverwrite} from '../../shared/brief-edit';
import {stepGuide} from '../../shared/step-guide';
import {OriginalSourcePanel,type ApprovedOriginalPayload} from '../components/OriginalSourcePanel';
import {ActionBar,DocHeader,StepLayout,type SaveState} from '../components/Shell';
import {ProjectPropsPanel} from '../components/ProjectPanel';
import {Button,Field,Tag} from '../components/UI';

const AUTOSAVE_MS=700;
const formatDate=(d:string)=>new Date(d).toLocaleDateString('ko-KR',{month:'short',day:'numeric'});

export type BriefFlush=()=>Promise<void>;

export function BriefPage({project,flash,saveState,panelOpen,onTogglePanel,registerFlush,onAutosave,onApproveOriginal,onPendingChange,onNext}:{
  project:StudioProject,
  flash:(text:string,type?:'info'|'success'|'error')=>void,
  saveState:SaveState,
  panelOpen:boolean,
  onTogglePanel:()=>void,
  registerFlush:(fn:BriefFlush|null)=>void,
  /** 작품 정보 자동 저장. 원문 새 버전을 시작했으면 true */
  onAutosave:(projectId:string,brief:Brief,continueSession:boolean)=>Promise<boolean>,
  onApproveOriginal:(projectId:string,payload:ApprovedOriginalPayload,base:Brief)=>Promise<boolean>,
  onPendingChange:(pending:boolean)=>void,
  onNext:()=>void
}){
  const [draft,setDraft]=useState<Brief>(project.brief);
  const draftRef=useRef(draft);draftRef.current=draft;
  const pendingRef=useRef(false);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const sessionRef=useRef(false);
  const saveRef=useRef(onAutosave);saveRef.current=onAutosave;
  const pendingCb=useRef(onPendingChange);pendingCb.current=onPendingChange;
  const projectId=project.id;
  const [finderOpen,setFinderOpen]=useState(false);const [finderKey,setFinderKey]=useState(0);
  const [summaryOpen,setSummaryOpen]=useState(false);
  const [unlocked,setUnlocked]=useState(false);

  const saveNow=async()=>{
    if(timer.current){clearTimeout(timer.current);timer.current=null;}
    if(!pendingRef.current)return;
    pendingRef.current=false;
    const started=await saveRef.current(projectId,draftRef.current,sessionRef.current);
    if(started)sessionRef.current=true;
    if(!pendingRef.current)pendingCb.current(false);
  };
  const saveNowRef=useRef(saveNow);saveNowRef.current=saveNow;
  useEffect(()=>{
    const flush=()=>saveNowRef.current();
    registerFlush(flush);
    const beforeUnload=()=>{void flush();};
    window.addEventListener('beforeunload',beforeUnload);
    return()=>{registerFlush(null);window.removeEventListener('beforeunload',beforeUnload);void flush();};
  },[projectId]);
  // 다른 작품으로 바뀌면 새로 읽기 / 밖에서 바뀐 내용은 입력 중이 아닐 때만 반영
  useEffect(()=>{setDraft(project.brief);sessionRef.current=false;setUnlocked(false);setFinderOpen(false);},[projectId]);
  useEffect(()=>{if(!pendingRef.current&&!timer.current)setDraft(project.brief);},[JSON.stringify(project.brief)]);

  const markPending=()=>{
    pendingRef.current=true;pendingCb.current(true);
    if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(()=>{timer.current=null;void saveNowRef.current();},AUTOSAVE_MS);
  };
  const set=<K extends keyof Brief>(k:K,v:Brief[K])=>{
    setDraft(d=>{let next={...d,[k]:v} as Brief;if((AUTO_FILL_FIELDS as string[]).includes(k as string))next=clearAutoFilled(next,k as AutoFillField);return next;});
    markPending();
  };
  const patch=(p:Partial<Brief>)=>{setDraft(d=>({...d,...p}));markPending();};

  const downstream=assessOriginalChangeImpact(project,'').hasDownstreamWork;
  const locked=downstream&&!unlocked&&!!draft.originalText.trim();
  const unlock=()=>{
    if(confirm('원문을 고치면 이미 만든 기획 분석·스토리보드·자막이 새 원문과 달라질 수 있어요.\n고친 원문은 새 버전으로 저장되고 이전 원문은 이력에 남아요. 미디어 파일은 지워지지 않아요.\n\n원문을 고칠까요?')){
      setUnlocked(true);setTimeout(()=>document.querySelector<HTMLTextAreaElement>('.original-text')?.focus(),30);
    }
  };

  const handleApprove=(payload:ApprovedOriginalPayload)=>{
    const incoming:Partial<Record<AutoFillField,string>>={title:payload.title,author:payload.author,source:payload.source,sourceUrl:payload.sourceUrl,originalText:payload.originalText};
    const overwrite=userFieldsToOverwrite(draftRef.current,incoming);
    const impact=assessOriginalChangeImpact(project,payload.originalText);
    const parts:string[]=[];
    if(overwrite.length)parts.push(`직접 입력한 ${overwrite.map(f=>AUTO_FILL_LABELS[f]).join(', ')} 칸을 가져온 내용으로 바꿉니다.`);
    if(impact.warningMessage)parts.push(impact.warningMessage);
    else if(parts.length)parts.push('바꿀까요?');
    if(parts.length&&!confirm(parts.join('\n\n')))return false;
    if(timer.current){clearTimeout(timer.current);timer.current=null;}
    pendingRef.current=false;pendingCb.current(false);
    const autoFilled:Partial<Record<AutoFillField,string>>={...(draftRef.current.autoFilled||{})};
    for(const f of AUTO_FILL_FIELDS){if((incoming[f]||'').trim())autoFilled[f]=payload.meta.providerName;else delete autoFilled[f];}
    const base:Brief={...draftRef.current,...incoming,genre:payload.genre??draftRef.current.genre,autoFilled:Object.keys(autoFilled).length?autoFilled:undefined} as Brief;
    setDraft(base);sessionRef.current=false;setUnlocked(false);setFinderOpen(false);
    void onApproveOriginal(projectId,payload,base);
    return true;
  };

  const isBible=draft.genre==='bible';
  const meta=project.brief.originalMeta;
  const guide=stepGuide({...project,brief:draft},'brief');
  const textEmpty=!draft.originalText.trim();
  const bibleRef=meta?.bibleRef;
  const autoBadge=(f:AutoFillField)=>draft.autoFilled?.[f]?<span className="auto-badge" title="자동으로 채운 칸이에요. 고치면 표시가 사라져요.">자동 입력됨 · {draft.autoFilled[f]}</span>:null;

  const header=<DocHeader icon={<BookOpen size={16}/>} title="작품 정보" description="원문을 찾아 채우거나 직접 입력해 제작 기준 원문을 정합니다." project={{...project,brief:draft}} saveState={saveState} panelOpen={panelOpen} onTogglePanel={onTogglePanel}/>;
  const panel=panelOpen?<ProjectPropsPanel project={project} brief={draft} onChange={patch} onClose={onTogglePanel}/>:null;
  const actionBar=<ActionBar guide={guide} onNext={()=>{void saveNow().then(onNext);}}/>;

  return <StepLayout header={header} panel={panel} actionBar={actionBar} focusKey={`brief-${projectId}`} fill>
    <div className="brief-sheet">
      <div className="brief-grid">
        <Field label="콘텐츠 유형"><select value={draft.genre} onChange={e=>set('genre',e.target.value as Genre)}>{Object.entries(GENRES).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></Field>
        <Field label="시청 대상"><select value={draft.audience} onChange={e=>set('audience',e.target.value as Audience)}>{Object.entries(AUDIENCES).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></Field>
        <Field label="작품 제목" badge={autoBadge('title')} className="span-2">
          <div className="input-with-button">
            <input value={draft.title} onChange={e=>set('title',e.target.value)} placeholder={isBible?'본문을 가져오면 자동으로 채워져요 (예: 시편 23편 1~6절)':'작품 제목 (예: 서시, 진달래꽃)'} data-skip-focus={isBible?'':undefined} onKeyDown={e=>{if(e.key==='Enter'&&!isBible&&draft.title.trim()){e.preventDefault();setFinderKey(k=>k+1);setFinderOpen(true);}}}/>
            {!isBible&&<Button type="button" kind={textEmpty&&!finderOpen?'primary':'outline'} size="sm" aria-expanded={finderOpen} title="위키문헌·구텐베르크·공유마당 검색, URL, 파일에서 원문을 찾아 칸을 채웁니다" onClick={()=>{if(!finderOpen)setFinderKey(k=>k+1);setFinderOpen(v=>!v);}}>{finderOpen?<><X size={14}/> 찾기 닫기</>:<><Search size={14}/> 원문 찾아 채우기</>}</Button>}
          </div>
        </Field>
        {!isBible&&<>
          <Field label="저자 · 기록자" badge={autoBadge('author')}><input value={draft.author} onChange={e=>set('author',e.target.value)} placeholder="저자"/></Field>
          <Field label="출처 · 역본" badge={autoBadge('source')}><input value={draft.source} onChange={e=>set('source',e.target.value)} placeholder="출처 / 역본"/></Field>
          <Field label="원문 출처 URL" badge={autoBadge('sourceUrl')} className="span-2"><input value={draft.sourceUrl} onChange={e=>set('sourceUrl',e.target.value)} placeholder="https:// (선택 사항)"/></Field>
        </>}
      </div>

      {isBible&&<div className="bible-inline">
        <OriginalSourcePanel
          key={`bible-${projectId}`}
          tabs={['bible']}
          defaultGenre="bible"
          initialBible={bibleRef?{translationId:bibleRef.translationId,testament:bibleRef.testament,bookId:bibleRef.bookId,chapter:bibleRef.chapter,startVerse:bibleRef.startVerse,endVerse:bibleRef.endVerse}:undefined}
          onApprove={handleApprove}
          resetAfterApprove
          flash={flash}
          compact
        />
      </div>}

      {!isBible&&finderOpen&&<div className="finder-inline" role="region" aria-label="원문 찾아 채우기">
        <OriginalSourcePanel
          key={`finder-${projectId}-${finderKey}`}
          tabs={['search','url','file']}
          defaultGenre={draft.genre}
          initialQuery={draft.title}
          initialAuthor={draft.author}
          onApprove={handleApprove}
          onSwitchManual={()=>setFinderOpen(false)}
          switchLabel="닫기"
          autoSearch
          flash={flash}
          compact
        />
      </div>}

      {meta&&<div className={`original-summary ${summaryOpen?'open':''}`}>
        <button type="button" className="original-summary-line" aria-expanded={summaryOpen} onClick={()=>setSummaryOpen(v=>!v)}>
          {summaryOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}
          <strong>기준 원문 v{meta.version}</strong>
          <span>{meta.providerName}{meta.edition&&meta.edition!==meta.providerName?` · ${meta.edition}`:''}</span>
          <Tag tone={RIGHTS_STATUS_META[meta.rights.status].tone}>{RIGHTS_STATUS_META[meta.rights.status].shortLabel}</Tag>
          <span className="muted-text">확정 {formatDate(meta.approvedAt)}</span>
          <span className="summary-more">{summaryOpen?'접기':'자세히'}</span>
        </button>
        {summaryOpen&&<div className="original-summary-body">
          <p>{meta.rights.basis}</p>
          <div className="original-summary-tags">
            <Tag tone={RIGHTS_STATUS_META[meta.rights.status].tone}>{RIGHTS_STATUS_META[meta.rights.status].label}</Tag>
            <Tag tone="muted">{meta.title||'제목 미기재'} · {meta.author||'저자 미기재'}{meta.translator?` (역: ${meta.translator})`:''}</Tag>
            <Tag tone="muted">SHA-256 {meta.sha256.slice(0,10)}</Tag>
            {meta.verification&&<Tag tone={meta.verification.issues.length?'warning':'success'}>{meta.verification.issues.length?`검증 참고 ${meta.verification.issues.length}건`:'원문 검증 이상 없음'}</Tag>}
            {meta.sourceUrl&&<Button size="sm" kind="ghost" onClick={()=>void window.studio.sources.openExternal(meta.sourceUrl)}><ExternalLink size={13}/> 출처 열기</Button>}
          </div>
        </div>}
      </div>}

      <div className="original-head">
        <span className="field-label">낭독할 기준 원문 {autoBadge('originalText')}</span>
        <span className="muted-text">{draft.originalText.length.toLocaleString()}자</span>
        {locked&&<Button size="sm" kind="outline" onClick={unlock} title="이미 기획이 진행된 작품이라 실수로 바뀌지 않게 잠가 두었어요"><Lock size={13}/> 원문 고치기</Button>}
      </div>
      <textarea className={`original-text ${locked?'is-locked':''}`} value={draft.originalText} readOnly={locked} onChange={e=>set('originalText',e.target.value)} placeholder={isBible?'위에서 성경 범위를 고르고 「성경 본문 가져오기」를 누르면 여기에 채워져요. 직접 붙여넣어도 돼요.':'원문을 붙여넣거나 직접 입력하세요. 「원문 찾아 채우기」로 검색해 채울 수도 있어요.'} spellCheck={false}/>
    </div>
  </StepLayout>;
}
