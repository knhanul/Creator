import {useCallback,useEffect,useRef,useState} from 'react';
import type {Brief,ProjectSummary,StudioProject} from '../../shared/types';

export type Toast={text:string;type:'info'|'success'|'error'};
export function useStudio(){
  const [projects,setProjects]=useState<ProjectSummary[]>([]);
  const [project,setProject]=useState<StudioProject|null>(null);
  const projectRef=useRef<StudioProject|null>(null);
  const queue=useRef<Promise<unknown>>(Promise.resolve());
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [toast,setToast]=useState<Toast|null>(null);
  const flash=useCallback((text:string,type:Toast['type']='info')=>setToast({text,type}),[]);
  const refresh=useCallback(async()=>setProjects(await window.studio.projects.list()),[]);
  useEffect(()=>{void refresh().catch(e=>flash(String(e),'error')).finally(()=>setLoading(false));},[refresh,flash]);
  const load=useCallback(async(id:string)=>{try{setBusy(true);const result=await window.studio.projects.read(id);projectRef.current=result;setProject(result);return result;}catch(e){flash(String(e),'error');return null;}finally{setBusy(false);}},[flash]);
  const close=useCallback(()=>{projectRef.current=null;setProject(null);},[]);
  const create=useCallback(async(brief:Brief)=>{try{setBusy(true);const result=await window.studio.projects.create(brief);projectRef.current=result;setProject(result);await refresh();flash('새 작품을 만들었습니다.','success');return result;}catch(e){flash(String(e),'error');return null;}finally{setBusy(false);}},[refresh,flash]);
  const mutate=useCallback((change:(p:StudioProject)=>StudioProject):Promise<StudioProject|null>=>{
    const task=queue.current.then(async()=>{
      const current=projectRef.current;if(!current)return null;
      const next=change(structuredClone(current));
      setBusy(true);
      const saved=await window.studio.projects.save(next);
      projectRef.current=saved;setProject(saved);await refresh();return saved;
    });
    queue.current=task.catch(err=>{flash(err instanceof Error?err.message:String(err),'error');}).finally(()=>setBusy(false));
    return task.catch(()=>null);
  },[flash,refresh]);
  const importAssets=useCallback(async(targetSceneId?:string)=>{
    const task=queue.current.then(async()=>{const p=projectRef.current;if(!p)return null;setBusy(true);const result=await window.studio.assets.import(p.id,targetSceneId);if(result){projectRef.current=result;setProject(result);await refresh();flash(targetSceneId?`미디어를 가져와 ${targetSceneId} 장면에 연결했습니다.`:'미디어를 가져왔습니다.','success');}return result;});
    queue.current=task.catch(err=>flash(String(err),'error')).finally(()=>setBusy(false));
    return task.catch(()=>null);
  },[flash,refresh]);
  const archive=useCallback(async(id:string,value:boolean)=>{try{setBusy(true);await window.studio.projects.archive(id,value);if(projectRef.current?.id===id)close();await refresh();flash(value?'작품을 보관했습니다.':'작품을 복원했습니다.','success');}catch(e){flash(String(e),'error');}finally{setBusy(false);}},[close,refresh,flash]);
  const exportFolder=useCallback(async()=>{const p=projectRef.current;if(!p)return;try{setBusy(true);const out=await window.studio.projects.exportFolder(p.id);if(out)flash(`제작 패키지를 저장했습니다: ${out}`,'success');}catch(e){flash(String(e),'error');}finally{setBusy(false);}},[flash]);
  const copy=useCallback(async(text:string)=>{try{await window.studio.clipboard.write(text);flash('클립보드에 복사했습니다.','success');}catch(e){flash(String(e),'error');}},[flash]);
  return {projects,project,loading,busy,toast,setToast,flash,refresh,load,close,create,mutate,importAssets,archive,exportFolder,copy};
}
