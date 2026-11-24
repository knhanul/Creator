import {useEffect,useMemo,useState} from 'react';
import {AlertCircle,CheckCircle2,ClipboardPaste,Copy,FileJson2,Sparkles,X} from 'lucide-react';
import type {AIStage,StudioProject} from '../../shared/types';
import {applyAIResponse} from '../../shared/workflow';
import {makeAIPrompt} from '../../shared/prompts';
import {Button,Tag} from './UI';
const names:Record<AIStage,string>={analysis:'기획 분석',storyboard:'스토리보드',prompt:'생성 프롬프트',editplan:'최종 편집 구성'};
export function AIDialog({project,stage,onClose,onApply,onCopy}:{project:StudioProject,stage:AIStage,onClose:()=>void,onApply:(p:StudioProject)=>Promise<boolean>,onCopy:(text:string)=>void}){
  const [answer,setAnswer]=useState(project.ai[stage]?.raw||'');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const prompt=useMemo(()=>makeAIPrompt(project,stage),[project,stage]);
  useEffect(()=>{setAnswer(project.ai[stage]?.raw||'');setError('');},[project.id,stage]);
  const validate=()=>{try{const next=applyAIResponse(project,stage,answer);setError('');return next;}catch(e){setError(e instanceof Error?e.message:String(e));return null;}};
  const apply=async()=>{const next=validate();if(!next)return;setBusy(true);const ok=await onApply(next);setBusy(false);if(ok)onClose();};
  return <div className="modal-backdrop ai-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal ai-modal" role="dialog" aria-modal="true" aria-label="AI 연결 워크벤치">
    <div className="modal-head"><div className="modal-head-icon"><Sparkles size={21}/></div><div><div className="eyebrow">AI WORKBENCH</div><h2>{names[stage]} · AI 연결</h2><p>프롬프트 생성과 JSON 검증은 실제 동작합니다. Gemini 자동 접속은 아직 연결되지 않았습니다.</p></div><Tag tone="warning">수동 연결</Tag><button className="icon-btn" onClick={onClose}><X size={19}/></button></div>
    <div className="ai-columns"><div className="ai-pane"><div className="ai-pane-head"><div><strong>01. AI에게 보낼 요청</strong><p>기존 설계 규칙을 기반으로 자동 구성됩니다.</p></div><Button size="sm" kind="secondary" onClick={()=>onCopy(prompt)}><Copy size={15}/> 요청 복사</Button></div><textarea className="ai-prompt" value={prompt} readOnly spellCheck={false}/></div>
    <div className="ai-pane"><div className="ai-pane-head"><div><strong>02. JSON 결과 확인</strong><p>AI 응답을 그대로 붙여넣고 적용하세요.</p></div><Tag tone="muted"><FileJson2 size={12}/> Schema v1</Tag></div><textarea className="ai-response" spellCheck={false} value={answer} onChange={e=>{setAnswer(e.target.value);setError('');}} placeholder={'{\n  "schema": "creator.'+(stage==='editplan'?'editplan':stage==='prompt'?'prompts':stage)+'.v1",\n  ...\n}'}/>
      {error&&<div className="error-message"><AlertCircle size={15}/>{error}</div>}<div className="ai-actions"><Button size="sm" kind="outline" onClick={validate} disabled={!answer.trim()}>JSON 검사</Button><Button size="sm" onClick={()=>void apply()} disabled={!answer.trim()||busy}><CheckCircle2 size={16}/> 검사 후 적용</Button></div>
    </div></div>
    <div className="ai-footnote"><ClipboardPaste size={15}/> 후속 버전에서는 AI Provider 어댑터를 이 화면에 연결해 복사·붙여넣기를 제거하도록 설계했습니다.</div>
  </section></div>;
}
