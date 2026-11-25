import {useEffect,useRef,type ReactNode} from 'react';
import {ArrowRight,CheckCircle2,FolderOpen,Loader2,PanelRightClose,PanelRightOpen,ShieldAlert} from 'lucide-react';
import type {StepGuide} from '../../shared/step-guide';
import type {StudioProject} from '../../shared/types';
import {AUDIENCES,GENRES,UNTITLED} from '../../shared/workflow';
import {Button} from './UI';

export type SaveState='saved'|'saving'|'pending';
export const SAVE_LABEL:Record<SaveState,string>={saved:'자동 저장됨',saving:'저장 중…',pending:'입력 중…'};

/** 화면 맨 위 한 줄: 화면 이름 · 작품 이름 · 장르/대상 · 저장 상태 · 화면별 버튼 · 작업 폴더 · 속성 창 */
export function DocHeader({icon,title,description,project,saveState,actions,panelOpen,onTogglePanel}:{
  icon:ReactNode,title:string,description?:string,project?:StudioProject|null,saveState?:SaveState,actions?:ReactNode,
  panelOpen?:boolean,onTogglePanel?:()=>void
}){
  return <header className="doc-header">
    <div className="doc-title" title={description}>
      <span className="doc-icon">{icon}</span>
      <strong>{title}</strong>
      {project&&<>
        <span className="doc-sep">/</span>
        <span className="doc-project">{project.brief.title.trim()||UNTITLED}</span>
        <span className="chip chip-accent">{GENRES[project.brief.genre]}</span>
        <span className="chip">{AUDIENCES[project.brief.audience]}</span>
        {!project.brief.title.trim()||!project.brief.originalText.trim()?<span className="chip chip-warn">작성 중</span>:null}
      </>}
    </div>
    <div className="doc-actions">
      {actions}
      {project&&saveState&&<span className={`save-state save-${saveState}`} aria-live="polite">{saveState==='saving'?<Loader2 size={13} className="spin"/>:saveState==='saved'?<CheckCircle2 size={13}/>:<span className="dot"/>}{SAVE_LABEL[saveState]}</span>}
      {project&&<Button kind="outline" size="sm" title="이 작품의 파일이 저장된 폴더를 엽니다" onClick={()=>void window.studio.app.openFolder(project.id)}><FolderOpen size={14}/> 작업 폴더</Button>}
      {onTogglePanel&&<button type="button" className={`icon-btn panel-toggle ${panelOpen?'on':''}`} title={panelOpen?'오른쪽 작품 속성 창 닫기':'오른쪽 작품 속성 창 열기'} aria-label="작품 속성 창" aria-pressed={!!panelOpen} onClick={onTogglePanel}>{panelOpen?<PanelRightClose size={17}/>:<PanelRightOpen size={17}/>}</button>}
    </div>
  </header>;
}

/** 단계 화면 아래 고정 줄: 왼쪽 = 지금 할 일, 오른쪽 = 다음 단계 버튼 (준비가 안 되면 흐리게 + 이유 툴팁) */
export function ActionBar({guide,onNext,primaryLabel,secondary}:{guide:StepGuide,onNext:()=>void,primaryLabel?:string,secondary?:ReactNode}){
  const tip=guide.ready?'':`아직 필요한 것: ${guide.missing.join(', ')}`;
  const enabled=guide.ready||!guide.next;
  return <footer className={`action-bar ${guide.ready?'is-ready':''}`}>
    <div className="action-hint">{guide.ready?<CheckCircle2 size={16}/>:<ShieldAlert size={16}/>}<span>{guide.hint}</span>{!guide.ready&&guide.missing.length>0&&<small>필요: {guide.missing.join(' · ')}</small>}</div>
    <div className="action-buttons">
      {secondary}
      <span title={enabled?'':tip} className="action-primary-wrap">
        <Button onClick={onNext} disabled={!enabled} aria-describedby="action-hint">{primaryLabel||guide.nextLabel} {guide.next&&<ArrowRight size={16}/>}</Button>
      </span>
    </div>
  </footer>;
}

/** 단계 화면 틀: 머리 줄 / (본문 + 오른쪽 창) / 아래 고정 줄. 들어오면 첫 번째 빈 칸에 커서를 둔다. */
export function StepLayout({header,panel,actionBar,children,focusKey,fill=false}:{header:ReactNode,panel?:ReactNode,actionBar?:ReactNode,children:ReactNode,focusKey?:string,fill?:boolean}){
  const mainRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!focusKey)return;
    const t=setTimeout(()=>{
      const root=mainRef.current;if(!root||root.contains(document.activeElement))return;
      const fields=Array.from(root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input:not([type=checkbox]):not([type=radio]):not([type=number]):not([readonly]):not([disabled]):not([data-skip-focus]),textarea:not([readonly]):not([disabled]):not([data-skip-focus])'));
      const empty=fields.find(f=>!f.value.trim()&&f.offsetParent!==null);
      empty?.focus();
    },60);
    return()=>clearTimeout(t);
  },[focusKey]);
  return <div className="step-layout">
    {header}
    <div className="workspace">
      <div className={`workspace-main ${fill?'is-fill':''}`} ref={mainRef}>{children}</div>
      {panel}
    </div>
    {actionBar}
  </div>;
}

/** 오른쪽 창 공통 틀 */
export function SidePanel({title,onClose,children,className=''}:{title:string,onClose?:()=>void,children:ReactNode,className?:string}){
  return <aside className={`side-panel ${className}`} aria-label={title}>
    <div className="side-panel-head"><strong>{title}</strong>{onClose&&<button type="button" className="icon-btn" title="창 닫기" aria-label="창 닫기" onClick={onClose}><PanelRightClose size={16}/></button>}</div>
    <div className="side-panel-body">{children}</div>
  </aside>;
}
