import {useState} from 'react';
import {FilePlus2,X} from 'lucide-react';
import type {Brief,Genre,Audience} from '../../shared/types';
import {AUDIENCES,DEFAULT_BRIEF,GENRES} from '../../shared/workflow';
import {Button,Field} from './UI';
export function NewProjectModal({onClose,onCreate,busy}:{onClose:()=>void,onCreate:(b:Brief)=>void,busy:boolean}){
  const [draft,setDraft]=useState<Brief>({...DEFAULT_BRIEF});
  const set=<K extends keyof Brief>(key:K,value:Brief[K])=>setDraft(v=>({...v,[key]:value}));
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal new-modal" role="dialog" aria-modal="true" aria-label="새 작품 만들기">
    <div className="modal-head"><div className="modal-head-icon"><FilePlus2 size={20}/></div><div><div className="eyebrow">NEW PROJECT</div><h2>새 작품 만들기</h2><p>원문을 등록하면 AI 제작 워크플로가 시작됩니다.</p></div><button className="icon-btn" onClick={onClose}><X size={20}/></button></div>
    <form className="modal-form" onSubmit={e=>{e.preventDefault();if(draft.title.trim()&&draft.originalText.trim())onCreate(draft);}}>
      <div className="form-row"><Field label="작품 장르"><select value={draft.genre} onChange={e=>set('genre',e.target.value as Genre)}>{Object.entries(GENRES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></Field><Field label="시청 대상"><select value={draft.audience} onChange={e=>set('audience',e.target.value as Audience)}>{Object.entries(AUDIENCES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></Field></div>
      <Field label="작품 제목"><input required placeholder={draft.genre==='bible'?'예: 시편 23편 1~6절':'작품 제목'} value={draft.title} onChange={e=>set('title',e.target.value)}/></Field>
      <div className="form-row"><Field label="저자 · 기록자"><input placeholder="직접 입력" value={draft.author} onChange={e=>set('author',e.target.value)}/></Field><Field label="출처 · 역본"><input placeholder="예: 역본 / 출처 정보" value={draft.source} onChange={e=>set('source',e.target.value)}/></Field></div>
      <Field label="확정 원문" description="원문 텍스트는 AI가 임의로 변경하지 않도록 유지합니다. 실제 출처와 이용 조건을 확인해 주세요."><textarea required rows={7} placeholder="낭독할 원문을 붙여넣으세요. 작품 입력 예시가 아닌 실제 원문을 사용합니다." value={draft.originalText} onChange={e=>set('originalText',e.target.value)}/></Field>
      <div className="modal-actions"><Button kind="secondary" type="button" onClick={onClose}>취소</Button><Button disabled={busy||!draft.title.trim()||!draft.originalText.trim()} type="submit">작품 만들기</Button></div>
    </form>
  </section></div>;
}
