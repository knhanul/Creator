import {contextBridge,ipcRenderer} from 'electron';
import type {StudioAPI} from '../shared/types';
const api:StudioAPI={
  app:{info:()=>ipcRenderer.invoke('app:info'),openFolder:(projectId)=>ipcRenderer.invoke('app:open-folder',projectId)},
  projects:{list:(includeArchived)=>ipcRenderer.invoke('projects:list',includeArchived),create:(brief)=>ipcRenderer.invoke('projects:create',brief),read:(id)=>ipcRenderer.invoke('projects:read',id),save:(p)=>ipcRenderer.invoke('projects:save',p),archive:(id,archive)=>ipcRenderer.invoke('projects:archive',id,archive),exportFolder:(id)=>ipcRenderer.invoke('projects:export',id)},
  assets:{import:(id)=>ipcRenderer.invoke('assets:import',id),reveal:(projectId,assetId)=>ipcRenderer.invoke('assets:reveal',projectId,assetId)},
  clipboard:{write:(text)=>ipcRenderer.invoke('clipboard:write',text)},
  gemini:{
    status:()=>ipcRenderer.invoke('gemini:status'),
    ping:()=>ipcRenderer.invoke('gemini:ping'),
    submit:(job)=>ipcRenderer.invoke('gemini:submit',job),
    jobs:{
      list:()=>ipcRenderer.invoke('gemini:jobs:list'),
      enqueue:(input)=>ipcRenderer.invoke('gemini:jobs:enqueue',input),
      retry:(jobId)=>ipcRenderer.invoke('gemini:jobs:retry',jobId),
      cancel:(jobId)=>ipcRenderer.invoke('gemini:jobs:cancel',jobId),
      confirm:(jobId)=>ipcRenderer.invoke('gemini:jobs:confirm',jobId),
      continue:(jobId)=>ipcRenderer.invoke('gemini:jobs:continue',jobId)
    }
  }
};
contextBridge.exposeInMainWorld('studio',api);
