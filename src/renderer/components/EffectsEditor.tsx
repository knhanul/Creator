import {Plus,Trash2,Wand2} from 'lucide-react';
import type {Scene} from '../../shared/types';
import {
  FOCUS_PRESETS,MOTION_LABEL,MOTION_TYPES,OVERLAY_LABEL,OVERLAY_TYPES,TONE_LABEL,TONE_TYPES,TRANSITION_LABEL,TRANSITION_TYPES,
  autoShots,captionsMatch,describeShots,fitShots,nearestFocusPreset,
  type MotionType,type OverlayType,type SceneEffects,type Shot,type ToneType,type TransitionType
} from '../../shared/effects';
import {Button,Field,IconButton} from './UI';

const FOCUS_MOTIONS:MotionType[]=['focus_in','focus_out'];

/** 장면 효과 편집: 샷(움직임)·분위기 효과·색감·들어오는 전환·자막 줄 */
export function EffectsEditor({scene,index,onChange}:{scene:Scene,index:number,onChange:(fx:SceneEffects)=>void}){
  const fx=scene.effects||{};
  const shots=fx.shots?.length?fx.shots:autoShots(scene.durationSec,index,fx.captions?.length||1,scene.kind);
  const set=(patch:Partial<SceneEffects>)=>onChange({...fx,...patch});
  const setShot=(i:number,patch:Partial<Shot>)=>set({shots:shots.map((s,j)=>j===i?{...s,...patch}:s)});
  const total=Math.round(shots.reduce((n,s)=>n+s.durationSec,0)*10)/10;
  const captionsText=(fx.captions||[]).join('\n');
  const captionsOk=!fx.captions?.length||captionsMatch(fx.captions,scene.narration);
  return <div className="effects-editor">
    <div className="effects-editor-head"><strong>화면 효과</strong><small>같은 이미지 안에서 샷마다 다른 움직임을 줘요</small></div>
    <div className="form-row">
      <Field label="들어오는 전환"><select value={fx.transitionIn?.type||'fade'} onChange={e=>{const type=e.target.value as TransitionType;set({transitionIn:{type,durationSec:type==='cut'?0:(fx.transitionIn?.durationSec||1)}});}}>{TRANSITION_TYPES.map(t=><option key={t} value={t}>{TRANSITION_LABEL[t]}</option>)}</select></Field>
      <Field label="전환 길이(초)"><input type="number" min={0} max={3} step={0.1} value={fx.transitionIn?.durationSec??1} disabled={fx.transitionIn?.type==='cut'} onChange={e=>set({transitionIn:{type:fx.transitionIn?.type||'fade',durationSec:Math.min(3,Math.max(0,Number(e.target.value)||0))}})}/></Field>
    </div>
    <div className="form-row">
      <Field label="분위기 효과"><select value={fx.overlay||'none'} onChange={e=>set({overlay:e.target.value as OverlayType})}>{OVERLAY_TYPES.map(t=><option key={t} value={t}>{OVERLAY_LABEL[t]}</option>)}</select></Field>
      <Field label="색감"><select value={fx.tone||'none'} onChange={e=>set({tone:e.target.value as ToneType})}>{TONE_TYPES.map(t=><option key={t} value={t}>{TONE_LABEL[t]}</option>)}</select></Field>
    </div>
    {fx.overlay&&fx.overlay!=='none'&&<Field label={`효과 세기 ${Math.round((fx.overlayStrength??.5)*100)}%`}><input type="range" min={0} max={1} step={0.05} value={fx.overlayStrength??.5} onChange={e=>set({overlayStrength:Number(e.target.value)})}/></Field>}
    <div className="shot-list">
      <div className="shot-list-head"><span>샷 {shots.length}개 · 합계 {total}초{Math.abs(total-scene.durationSec)>0.05&&<em> (저장할 때 장면 길이 {scene.durationSec}초에 맞춰요)</em>}</span>
        <span className="action-group">
          <Button size="sm" kind="ghost" type="button" onClick={()=>set({shots:autoShots(scene.durationSec,index+Math.floor(Math.random()*6),fx.captions?.length||1,scene.kind)})}><Wand2 size={13}/> 자동 구성</Button>
          <Button size="sm" kind="ghost" type="button" disabled={shots.length>=6} onClick={()=>set({shots:fitShots([...shots,{durationSec:scene.durationSec/(shots.length+1),motion:'zoom_out',strength:0.1,source:scene.kind==='video'?'video':'image'}],scene.durationSec)})}><Plus size={13}/> 샷 추가</Button>
        </span>
      </div>
      {shots.map((s,i)=><div className="shot-row" key={i}>
        <span className="shot-no">{i+1}</span>
        {scene.kind==='video'&&<select aria-label="샷 소스" value={s.source||'video'} onChange={e=>setShot(i,{source:e.target.value as 'image'|'video'})}><option value="image">기준 이미지 정지</option><option value="video">동영상</option></select>}
        <select aria-label="움직임" value={s.motion} disabled={s.source==='video'} onChange={e=>setShot(i,{motion:e.target.value as MotionType})}>{MOTION_TYPES.map(m=><option key={m} value={m}>{MOTION_LABEL[m]}</option>)}</select>
        {FOCUS_MOTIONS.includes(s.motion)&&s.source!=='video'&&<select aria-label="초점" value={nearestFocusPreset(s.focus)} onChange={e=>setShot(i,{focus:FOCUS_PRESETS.find(f=>f.id===e.target.value)?.point})}>{FOCUS_PRESETS.map(f=><option key={f.id} value={f.id}>초점: {f.label}</option>)}</select>}
        <label className="shot-num"><input aria-label="샷 길이" type="number" min={0.5} max={60} step={0.5} value={s.durationSec} onChange={e=>setShot(i,{durationSec:Math.max(0.5,Number(e.target.value)||0.5)})}/>초</label>
        {s.source!=='video'&&s.motion!=='static'&&<label className="shot-num" title="움직임 세기"><input aria-label="움직임 세기" type="number" min={0.02} max={0.3} step={0.01} value={s.strength} onChange={e=>setShot(i,{strength:Math.min(0.3,Math.max(0.02,Number(e.target.value)||0.1))})}/>세기</label>}
        <IconButton label="샷 삭제" disabled={shots.length<=1} onClick={()=>set({shots:shots.filter((_,j)=>j!==i)})}><Trash2 size={14}/></IconButton>
      </div>)}
    </div>
    <Field label="자막 줄 (한 줄 = 자막 하나, 원문 글자 그대로)" description={captionsOk?'비워 두면 원문을 자동으로 나눠요.':'원문과 글자가 달라서 저장할 때 원문으로 다시 나눠요.'}>
      <textarea rows={Math.max(2,(fx.captions?.length||1))} value={captionsText} onChange={e=>set({captions:e.target.value.split('\n')})} placeholder="비워 두면 자동으로 나눠요"/>
    </Field>
  </div>;
}

/** 스토리보드 카드에 보이는 효과 요약 */
export function EffectsSummary({scene}:{scene:Scene}){
  const fx=scene.effects;
  if(!fx)return null;
  return <div className="effects-summary">
    {fx.shots?.length?<div className="effects-chips">{fx.shots.map((s,i)=><span className="fx-step" key={i}>{i>0&&<span className="fx-arrow" aria-hidden="true">→</span>}<span className="fx-chip" title={s.note||''}>{s.source==='video'?'영상':MOTION_LABEL[s.motion]} <small>{s.durationSec}초</small></span></span>)}</div>:null}
    <div className="effects-meta">
      {fx.transitionIn&&<span>전환 · {TRANSITION_LABEL[fx.transitionIn.type]}</span>}
      {fx.overlay&&fx.overlay!=='none'&&<span>효과 · {OVERLAY_LABEL[fx.overlay]}</span>}
      {fx.tone&&fx.tone!=='none'&&<span>색감 · {TONE_LABEL[fx.tone]}</span>}
      {fx.captions?.length?<span>자막 {fx.captions.length}줄</span>:null}
    </div>
  </div>;
}
export {describeShots};
