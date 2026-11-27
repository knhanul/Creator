import {useCallback,useRef,useState} from 'react';
import type {GeminiAnalysisStartResult,GeminiJobRecord,StudioProject} from '../../shared/types';
import {planMediaBatch,type MediaBatchStep} from '../../shared/media-batch';
import {findSceneReferenceImage} from '../../shared/reference-image';

export type MediaBatchStatus='idle'|'running'|'stopping'|'paused'|'done';
export interface MediaBatchState{status:MediaBatchStatus;projectId:string|null;current:MediaBatchStep|null;done:number;total:number;message:string}
const IDLE:MediaBatchState={status:'idle',projectId:null,current:null,done:0,total:0,message:''};
const TERMINAL=new Set(['completed','failed','cancelled']);
const stepKey=(s:MediaBatchStep)=>`${s.kind}:${s.sceneId||''}`;

/** 작업 하나가 끝날 때까지 기다린다 (이벤트 + 4초마다 목록 확인). 사용자 확인이 필요하면 그 상태로 돌려준다 */
function waitJob(jobId:string):Promise<GeminiJobRecord>{
  return new Promise(resolve=>{
    let finished=false;
    const done=(j:GeminiJobRecord)=>{if(finished)return;finished=true;off();clearInterval(timer);resolve(j);};
    const check=(j:GeminiJobRecord)=>{if(j.jobId===jobId&&(TERMINAL.has(j.state)||j.state==='needs_confirmation'))done(j);};
    const off=window.studio.gemini.onJobUpdate(check);
    const timer=setInterval(()=>{void window.studio.gemini.jobs.list().then(list=>{const j=list.find(x=>x.jobId===jobId);if(j)check(j);}).catch(()=>{});},4000);
  });
}

/**
 * 「미디어 한 번에 만들기」: 이미지(기준 이미지 포함)를 모두 먼저 만들고, 그다음 동영상(기준 이미지 첨부), 마지막에 배경음악.
 * 한 번에 하나씩 끝날 때까지 기다리며, 끝날 때마다 작품을 다시 읽어 남은 계획을 새로 세운다.
 */
export function useMediaBatch(opts:{reload:(id:string)=>Promise<unknown>,flash:(t:string,type?:'info'|'success'|'error')=>void}){
  const [state,setState]=useState<MediaBatchState>(IDLE);
  const stopRef=useRef(false);const runningRef=useRef(false);
  const {reload,flash}=opts;

  const start=useCallback(async(projectId:string,o:{music?:boolean}={})=>{
    if(runningRef.current)return;
    runningRef.current=true;stopRef.current=false;
    let done=0;let lastKey='';
    const pause=(message:string,status:MediaBatchStatus='paused')=>{setState(s=>({...s,status,current:null,message}));};
    try{
      const first=planMediaBatch(await window.studio.projects.read(projectId),o);
      if(!first.length){setState({...IDLE,status:'done',projectId,message:'만들 미디어가 남아 있지 않아요.'});return;}
      setState({status:'running',projectId,current:null,done:0,total:first.length,message:''});
      for(;;){
        if(stopRef.current){pause('멈췄어요. 「이어서 만들기」를 누르면 남은 것부터 다시 시작해요.');return;}
        const p:StudioProject=await window.studio.projects.read(projectId);
        const plan=planMediaBatch(p,o);
        if(!plan.length){setState(s=>({...s,status:'done',current:null,done:s.total,message:'모든 미디어를 만들고 장면에 연결했어요.'}));flash('미디어를 모두 만들고 장면에 연결했어요.','success');return;}
        const step=plan[0];
        if(stepKey(step)===lastKey){pause(`${step.label}을(를) 만들었지만 장면에 연결되지 않았어요. 아래 장면 카드에서 확인한 뒤 「이어서 만들기」를 눌러 주세요.`);return;}
        lastKey=stepKey(step);
        setState(s=>({...s,status:stopRef.current?'stopping':'running',current:step,done,total:Math.max(s.total,done+plan.length),message:''}));
        let r:GeminiAnalysisStartResult;
        if(step.kind==='music')r=await window.studio.gemini.music.start(projectId);
        else if(step.kind==='video')r=await window.studio.gemini.video.start(projectId,step.sceneId!,findSceneReferenceImage(p,step.sceneId!)?{useReferenceImage:true}:undefined);
        else r=await window.studio.gemini.image.start(projectId,step.sceneId!);
        if(!r.ok||!r.job){pause(`${step.label}: ${r.message||'시작하지 못했어요.'}`);return;}
        const job=await waitJob(r.job.jobId);
        if(job.state==='needs_confirmation'){pause(`${step.label}: Gemini 화면에서 확인이 필요해요. ${job.errorMessage||''} 확인한 뒤 「이어서 만들기」를 눌러 주세요.`.trim());return;}
        if(job.state!=='completed'||job.outcome!=='applied'){pause(`${step.label}: ${job.errorMessage||'만들지 못했어요.'} 아래 장면 카드에서 확인한 뒤 「이어서 만들기」를 눌러 주세요.`);return;}
        done++;
        await reload(projectId);
      }
    }catch(e){pause(e instanceof Error?e.message:String(e));}
    finally{runningRef.current=false;stopRef.current=false;}
  },[flash,reload]);

  /** 지금 만드는 것까지 끝내고 멈춤 */
  const stop=useCallback(()=>{if(!runningRef.current)return;stopRef.current=true;setState(s=>({...s,status:'stopping'}));},[]);
  const reset=useCallback(()=>{if(!runningRef.current)setState(IDLE);},[]);
  return {state,start,stop,reset,running:()=>runningRef.current};
}
