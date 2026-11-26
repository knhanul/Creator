import {useEffect,useRef,useState} from 'react';
import {BookOpen,ChevronDown,ChevronRight,ExternalLink,FileUp,Lock,Search,Sparkles,X} from 'lucide-react';
import type {AutoFillField,Audience,Brief,Genre,GeminiJobRecord,StudioProject} from '../../shared/types';
import {AUDIENCES,GENRES} from '../../shared/workflow';
import {assessOriginalChangeImpact} from '../../shared/original-versioning';
import {AUTO_FILL_FIELDS,AUTO_FILL_LABELS,clearAutoFilled,userFieldsToOverwrite} from '../../shared/brief-edit';
import {stepGuide} from '../../shared/step-guide';
import {ORIGINAL_FILE_HINT,ORIGINAL_FILE_LABEL,isSupportedOriginalFileName} from '../../shared/original-fetch';
import {sourceResultFromGemini} from '../../shared/gemini-source';
import {BIBLE_EDITION_CHOICES,normalizeBibleTranslationId,toCatalogBibleTranslationId} from '../../shared/bible-catalog';
import {guideFor,phaseView} from '../../shared/gemini-analysis';
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
  const [dragOver,setDragOver]=useState(false);
  const [fileBusy,setFileBusy]=useState(false);
  const [originalJob,setOriginalJob]=useState<GeminiJobRecord|null>(null);
  const appliedOriginalJobs=useRef(new Set<string>());

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
  useEffect(()=>{setDraft(project.brief);sessionRef.current=false;setUnlocked(false);setFinderOpen(false);setOriginalJob(null);appliedOriginalJobs.current=new Set();},[projectId]);
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
    const pickedTranslation=payload.meta.bibleRef?.translationId;
    const base:Brief={...draftRef.current,...incoming,genre:payload.genre??draftRef.current.genre,autoFilled:Object.keys(autoFilled).length?autoFilled:undefined,originalFileName:undefined,
      bibleTranslation:pickedTranslation&&BIBLE_EDITION_CHOICES.some(c=>c.id===pickedTranslation)?pickedTranslation:draftRef.current.bibleTranslation} as Brief;
    setDraft(base);sessionRef.current=false;setUnlocked(false);setFinderOpen(false);
    void onApproveOriginal(projectId,payload,base);
    return true;
  };

  const applyBodyText=(text:string,opts:{sourceLabel:string;fileName?:string;title?:string;author?:string;replaceConfirm:string})=>{
    const cur=draftRef.current;
    if(cur.originalText.trim()&&cur.originalText!==text){
      if(!confirm(opts.replaceConfirm))return false;
    }
    setDraft(d=>{
      const autoFilled:Partial<Record<AutoFillField,string>>={...(d.autoFilled||{})};
      autoFilled.originalText=opts.sourceLabel;
      const next:Brief={...d,originalText:text,originalFileName:opts.fileName,autoFilled};
      if(opts.title&&!d.title.trim()){next.title=opts.title;autoFilled.title=opts.sourceLabel;}
      if(opts.author&&!d.author.trim()){next.author=opts.author;autoFilled.author=opts.sourceLabel;}
      return next;
    });
    markPending();
    return true;
  };

  const applyFileResult=async(res:{ok:boolean;originalText?:string;errorMessage?:string;title?:string;author?:string;workId?:string;sourceName?:string})=>{
    if(!res.ok||!res.originalText?.trim()){
      flash(res.errorMessage||'파일에서 본문을 읽지 못했습니다.','error');
      return;
    }
    const fileName=res.workId||'첨부 파일';
    const ok=applyBodyText(res.originalText,{
      sourceLabel:res.sourceName||'로컬 파일',
      fileName,
      title:res.title,
      author:res.author,
      replaceConfirm:`지금 있는 본문을 「${fileName}」 내용으로 바꿀까요?`
    });
    if(ok)flash(`「${fileName}」에서 본문 ${res.originalText.length.toLocaleString()}자를 불러왔어요. 내용을 확인해 주세요.`,'success');
  };

  const pickFile=async()=>{
    if(locked){unlock();return;}
    setFileBusy(true);
    try{
      const res=await window.studio.sources.importFile();
      if(res)await applyFileResult(res);
    }catch(e){flash(e instanceof Error?e.message:String(e),'error');}
    finally{setFileBusy(false);}
  };

  const importDroppedFile=async(file:File)=>{
    if(locked){unlock();return;}
    if(!isSupportedOriginalFileName(file.name)&&!/\.pdf$/i.test(file.name)){
      flash(`지원하지 않는 파일입니다. ${ORIGINAL_FILE_LABEL} 파일을 선택해 주세요.`,'error');
      return;
    }
    setFileBusy(true);
    try{
      const filePath=window.studio.sources.pathForFile(file);
      if(!filePath){
        flash('이 파일의 경로를 읽지 못했습니다. 「파일 첨부」 버튼으로 선택해 주세요.','error');
        return;
      }
      const res=await window.studio.sources.importFilePath(filePath);
      await applyFileResult(res);
    }catch(e){flash(e instanceof Error?e.message:String(e),'error');}
    finally{setFileBusy(false);}
  };

  const clearBody=()=>{
    if(locked){unlock();return;}
    if(!draft.originalText.trim()&&!draft.originalFileName)return;
    if(!confirm('본문을 지울까요?'))return;
    setDraft(d=>{
      const autoFilled={...(d.autoFilled||{})};
      delete autoFilled.originalText;
      return {...d,originalText:'',originalFileName:undefined,autoFilled:Object.keys(autoFilled).length?autoFilled:undefined};
    });
    markPending();
  };

  const startGeminiOriginal=async()=>{
    if(locked){unlock();return;}
    if(!draft.title.trim()){flash('제목을 먼저 입력해 주세요.','error');return;}
    await saveNow();
    try{
      const status=await window.studio.gemini.status();
      if(status.versionIssue||!status.connected||!status.extensionConnected||!status.geminiTabFound){
        flash(status.versionIssue?.message||status.message||'제미나이가 연결되어 있지 않습니다. Chrome에서 확장 프로그램을 켜고 Gemini 탭을 연 뒤, 필요하면 SETUP_GEMINI.bat을 실행해 주세요.','error');
        return;
      }
      const r=await window.studio.gemini.source.start(projectId,draft.genre==='bible'
        ?{title:draft.title,genre:draft.genre,bibleTranslation:normalizeBibleTranslationId(draft.bibleTranslation)}
        :{title:draft.title,author:draft.author,genre:draft.genre});
      if(!r.ok){flash(r.message||'제미나이로 원문을 가져오지 못했습니다.','error');return;}
      if(r.job)setOriginalJob(r.job);
      flash(r.reused?(r.message||'이미 원문을 가져오는 중입니다.'):'제미나이에 원문 요청을 보냈어요. 응답이 오면 본문에 채워집니다.','info');
    }catch(e){flash(e instanceof Error?e.message:String(e),'error');}
  };

  useEffect(()=>{
    let latest:GeminiJobRecord|null=null;
    void window.studio.gemini.source.latest(projectId).then(j=>{if(j){latest=j;setOriginalJob(j);}}).catch(()=>{});
    return window.studio.gemini.onJobUpdate(j=>{
      if(j.kind!=='source'||j.projectId!==projectId)return;
      setOriginalJob(prev=>!prev||prev.jobId===j.jobId||j.createdAt>=prev.createdAt?j:prev);
      if(appliedOriginalJobs.current.has(j.jobId))return;
      if(j.state==='completed'&&(j.outcome==='received'||!j.outcome)){
        const cur=draftRef.current;
        const q=cur.genre==='bible'
          ?{title:cur.title,genre:cur.genre,bibleTranslation:normalizeBibleTranslationId(cur.bibleTranslation)}
          :{title:cur.title,author:cur.author,genre:cur.genre};
        const res=sourceResultFromGemini(j,q);
        appliedOriginalJobs.current.add(j.jobId);
        if(!res.ok||!res.originalText?.trim()){flash(res.errorMessage||'제미나이 응답에서 원문을 찾지 못했습니다.','error');return;}
        const ok=applyBodyText(res.originalText,{
          sourceLabel:'Gemini',
          title:res.title,
          author:res.author,
          replaceConfirm:'지금 있는 본문을 제미나이에서 가져온 원문으로 바꿀까요?'
        });
        if(ok)flash(`제미나이에서 원문 ${res.originalText.length.toLocaleString()}자를 가져왔어요. 내용을 검토하고 필요하면 고쳐 주세요.`,'success');
      }else if(j.state==='failed'||j.phase==='error'||j.outcome==='invalid'){
        appliedOriginalJobs.current.add(j.jobId);
        const g=guideFor(j);
        flash(g?`${g.cause} ${g.fix}`:(j.errorMessage||'제미나이에서 원문을 가져오지 못했습니다.'),'error');
      }
    });
  },[projectId]);

  const cancelOriginal=async()=>{
    if(!originalJob)return;
    const u=await window.studio.gemini.jobs.cancel(originalJob.jobId);
    if(u)setOriginalJob(u);
    flash('원문 가져오기 취소를 요청했습니다.','info');
  };

  const isBible=draft.genre==='bible';
  const meta=project.brief.originalMeta;
  const guide=stepGuide({...project,brief:draft},'brief');
  const bibleRef=meta?.bibleRef;
  const autoBadge=(f:AutoFillField)=>draft.autoFilled?.[f]?<span className="auto-badge" title="자동으로 채운 칸이에요. 고치면 표시가 사라져요.">자동 입력됨 · {draft.autoFilled[f]}</span>:null;
  const jobView=originalJob?phaseView(originalJob):null;
  const jobActive=!!jobView?.active;

  const header=<DocHeader icon={<BookOpen size={16}/>} title="작품 정보" description="장르·저자·제목으로 원문을 가져오거나, 파일을 첨부해 본문을 정합니다." project={{...project,brief:draft}} saveState={saveState} panelOpen={panelOpen} onTogglePanel={onTogglePanel}/>;
  const panel=panelOpen?<ProjectPropsPanel project={project} brief={draft} onChange={patch} onClose={onTogglePanel}/>:null;
  const actionBar=<ActionBar guide={guide} onNext={()=>{void saveNow().then(onNext);}}/>;

  return <StepLayout header={header} panel={panel} actionBar={actionBar} focusKey={`brief-${projectId}`} fill>
    <div className="brief-sheet">
      <div className="brief-grid">
        <Field label="장르"><select value={draft.genre} onChange={e=>{
          const genre=e.target.value as Genre;
          if(genre==='bible'){
            setDraft(d=>({...d,genre,bibleTranslation:normalizeBibleTranslationId(d.bibleTranslation)}));
            markPending();
          }else set('genre',genre);
        }}>{Object.entries(GENRES).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></Field>
        <Field label="시청 대상"><select value={draft.audience} onChange={e=>set('audience',e.target.value as Audience)}>{Object.entries(AUDIENCES).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></Field>
        <Field label="작품 제목" badge={autoBadge('title')} className="span-2">
          <input value={draft.title} onChange={e=>set('title',e.target.value)} placeholder={isBible?'예: 시편 23편 1~6절, 요한복음 3장 16절':'작품 제목 (예: 서시, 진달래꽃)'}/>
        </Field>
        {isBible
          ?<Field label="번역본" className="span-2"><select value={normalizeBibleTranslationId(draft.bibleTranslation)} onChange={e=>set('bibleTranslation',e.target.value)}>{BIBLE_EDITION_CHOICES.map(t=><option value={t.id} key={t.id}>{t.label}</option>)}</select></Field>
          :<Field label="저자" badge={autoBadge('author')} className="span-2"><input value={draft.author} onChange={e=>set('author',e.target.value)} placeholder="저자 (예: 윤동주, 김소월)"/></Field>}
      </div>

      <div className="brief-source-actions">
        <Button type="button" kind="primary" onClick={()=>void startGeminiOriginal()} disabled={jobActive||!draft.title.trim()} title={isBible?'입력한 제목과 선택한 번역본으로 제미나이에서 성경 본문을 가져와 본문에 채웁니다':'입력한 장르·저자·제목으로 제미나이에서 원문을 가져와 본문에 채웁니다'}>
          {jobActive?<><Sparkles size={14} className="spin"/> 원문 가져오는 중</>:<><Sparkles size={14}/> 제미나이로 원문 가져오기</>}
        </Button>
        <Button type="button" kind="outline" size="sm" aria-expanded={finderOpen} title={isBible?'성경 책·장·절 선택이나 URL에서 본문을 찾아 칸을 채웁니다':'위키문헌·구텐베르크·공유마당 검색이나 URL에서 원문을 찾아 칸을 채웁니다'} onClick={()=>{if(!finderOpen)setFinderKey(k=>k+1);setFinderOpen(v=>!v);}}>
          {finderOpen?<><X size={14}/> 찾기 닫기</>:<><Search size={14}/> 원문 찾아 채우기</>}
        </Button>
        {jobActive&&<Button type="button" kind="ghost" size="sm" onClick={()=>void cancelOriginal()}>취소</Button>}
        {jobView&&<span className={`muted-text brief-job-status tone-${jobView.tone}`}>{jobView.label}</span>}
      </div>

      {finderOpen&&<div className="finder-inline" role="region" aria-label="원문 찾아 채우기">
        <OriginalSourcePanel
          key={`finder-${projectId}-${finderKey}`}
          projectId={projectId}
          tabs={isBible?['bible','gemini','url']:['gemini','search','url']}
          defaultGenre={draft.genre}
          initialQuery={draft.title}
          initialAuthor={isBible?undefined:draft.author}
          initialBible={isBible?{
            translationId:bibleRef?.translationId||toCatalogBibleTranslationId(draft.bibleTranslation),
            testament:bibleRef?.testament||'old',
            bookId:bibleRef?.bookId||19,
            chapter:bibleRef?.chapter||23,
            startVerse:bibleRef?.startVerse||1,
            endVerse:bibleRef?.endVerse||6
          }:undefined}
          onApprove={handleApprove}
          onSwitchManual={()=>setFinderOpen(false)}
          switchLabel="닫기"
          autoSearch={!isBible}
          flash={flash}
          compact
        />
      </div>}

      {meta&&<div className={`original-summary ${summaryOpen?'open':''}`}>
        <button type="button" className="original-summary-line" aria-expanded={summaryOpen} onClick={()=>setSummaryOpen(v=>!v)}>
          {summaryOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}
          <strong>기준 원문 v{meta.version}</strong>
          <span>{meta.providerName}{meta.edition&&meta.edition!==meta.providerName?` · ${meta.edition}`:''}</span>
          <span className="muted-text">확정 {formatDate(meta.approvedAt)}</span>
          <span className="summary-more">{summaryOpen?'접기':'자세히'}</span>
        </button>
        {summaryOpen&&<div className="original-summary-body">
          <div className="original-summary-tags">
            <Tag tone="muted">{meta.title||'제목 미기재'} · {meta.author||'저자 미기재'}{meta.translator?` (역: ${meta.translator})`:''}</Tag>
            <Tag tone="muted">SHA-256 {meta.sha256.slice(0,10)}</Tag>
            {meta.sourceUrl&&<Button size="sm" kind="ghost" onClick={()=>void window.studio.sources.openExternal(meta.sourceUrl)}><ExternalLink size={13}/> 출처 열기</Button>}
          </div>
        </div>}
      </div>}

      <div className="original-head">
        <span className="field-label">본문 {autoBadge('originalText')}</span>
        <span className="muted-text">{draft.originalText.length.toLocaleString()}자</span>
        {locked&&<Button size="sm" kind="outline" onClick={unlock} title="이미 기획이 진행된 작품이라 실수로 바뀌지 않게 잠가 두었어요"><Lock size={13}/> 원문 고치기</Button>}
        {!locked&&<>
          <Button size="sm" kind="outline" onClick={()=>void pickFile()} disabled={fileBusy}><FileUp size={13}/> 파일 첨부</Button>
          {(draft.originalText.trim()||draft.originalFileName)&&<Button size="sm" kind="ghost" onClick={clearBody}>본문 지우기</Button>}
        </>}
      </div>
      {draft.originalFileName&&<div className="original-file-chip">
        <span>첨부됨: <strong>{draft.originalFileName}</strong></span>
        {!locked&&<>
          <Button size="sm" kind="ghost" onClick={()=>void pickFile()} disabled={fileBusy}>다른 파일로 바꾸기</Button>
          <Button size="sm" kind="ghost" onClick={clearBody}>첨부 해제</Button>
        </>}
      </div>}
      <div
        className={`original-drop ${dragOver?'is-over':''} ${locked?'is-locked':''}`}
        onDragEnter={e=>{e.preventDefault();if(!locked)setDragOver(true);}}
        onDragOver={e=>{e.preventDefault();if(!locked)setDragOver(true);}}
        onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragOver(false);}}
        onDrop={e=>{e.preventDefault();setDragOver(false);const file=e.dataTransfer.files?.[0];if(file)void importDroppedFile(file);}}
      >
        {dragOver&&!locked&&<div className="original-drop-hint">여기에 놓으면 본문으로 불러옵니다</div>}
        <textarea
          className={`original-text ${locked?'is-locked':''}`}
          value={draft.originalText}
          readOnly={locked}
          onChange={e=>set('originalText',e.target.value)}
          placeholder={`원문을 붙여넣거나 직접 입력하세요. 「제미나이로 원문 가져오기」나 파일 첨부·드래그앤드랍으로 채울 수도 있어요.\n${ORIGINAL_FILE_HINT}`}
          spellCheck={false}
        />
      </div>
      <p className="original-file-hint muted-text">{ORIGINAL_FILE_HINT}</p>
    </div>
  </StepLayout>;
}
