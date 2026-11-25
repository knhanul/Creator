import {History,ShieldAlert} from 'lucide-react';
import type {Brief,StudioProject} from '../../shared/types';
import {Field} from './UI';
import {SidePanel} from './Shell';

const formatDate=(d:string)=>new Date(d).toLocaleDateString('ko-KR',{month:'short',day:'numeric'});

/** 오른쪽 '작품 속성' 창: 작품 전체에 걸친 설정(영상 길이·화면 비율·권한)과 원문 변경 이력 */
export function ProjectPropsPanel({project,brief,onChange,onClose}:{project:StudioProject,brief:Brief,onChange:(patch:Partial<Brief>)=>void,onClose:()=>void}){
  const history=project.originalHistory||[];
  return <SidePanel title="작품 속성" onClose={onClose}>
    <section className="prop-section">
      <h4>제작 설정</h4>
      <Field label="목표 영상 길이"><div className="unit-input"><input type="number" min="10" max="3600" value={brief.targetDuration} onChange={e=>onChange({targetDuration:Math.max(10,Number(e.target.value)||10)})}/><span>초</span></div></Field>
      <Field label="화면 비율"><select value={brief.aspectRatio} onChange={e=>onChange({aspectRatio:e.target.value as Brief['aspectRatio']})}><option value="16:9">16:9 가로형</option><option value="9:16">9:16 세로형</option><option value="1:1">1:1 정사각형</option></select></Field>
      <Field label="원문 이용 권한 확인"><select value={brief.rightsStatus} onChange={e=>onChange({rightsStatus:e.target.value as Brief['rightsStatus']})}><option value="unreviewed">확인 전</option><option value="reviewed">확인함 (사용자 직접 신고)</option><option value="public-domain">퍼블릭 도메인 확인</option><option value="licensed">이용 허락 확보</option></select></Field>
      <p className="prop-note"><ShieldAlert size={13}/> 원문·성경 역본의 저작권은 직접 확인해 주세요. AI 기획을 시작하면 원문이 외부 Gemini로 전송됩니다.</p>
    </section>
    <section className="prop-section">
      <h4><History size={13}/> 원문 변경 이력 {history.length>0&&<span className="muted-text">{history.length}건</span>}</h4>
      {history.length===0?<p className="prop-empty">아직 바뀐 적이 없어요. 원문을 고치면 이전 원문이 여기에 보존돼요.</p>:
        <div className="original-history-list">
          {history.slice().reverse().map(h=><details key={`${h.version}-${h.archivedAt}`} className="original-history-item">
            <summary><strong>v{h.version}</strong> · {h.title||'제목 없음'} <span className="muted-text">{formatDate(h.archivedAt)}</span></summary>
            {h.reason&&<small className="muted-text">사유: {h.reason}</small>}
            <pre>{h.originalText.slice(0,400)}{h.originalText.length>400?'…':''}</pre>
          </details>)}
        </div>}
    </section>
  </SidePanel>;
}
