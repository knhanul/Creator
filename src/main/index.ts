import { app, BrowserWindow, clipboard, ipcMain, net, protocol, shell, dialog, nativeTheme } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { INTERNAL, BRAND } from '../shared/brand';
import { archiveProject, cleanupEmptyDrafts, createProject, discardDraftIfEmpty, exportFolder, importAssets, importProject, listProjects, projectDir, readProject, resolveAssetPath, revealAsset, saveGeneratedImageAsset, saveGeneratedMediaAsset, saveProject } from './storage';
import { geminiAdapter } from './gemini/adapter';
import { pipeClient } from './gemini/pipe-client';
import { GeminiJobQueue } from './gemini/job-queue.mjs';
import { createAnalysisService, type AnalysisService } from './gemini/analysis-service';
import { encodeReferenceImageForNativeMessaging, mimeFromFileName, resizeWithElectronNativeImage } from './gemini/encode-reference-image';
import { createDefaultSourceService } from './sources/source-service';
import { isAIStage } from '../shared/gemini-analysis';
import type { AIStage } from '../shared/types';
import type { GeminiJobRecord } from '../shared/types';

protocol.registerSchemesAsPrivileged([{scheme:'gomo-asset', privileges:{secure:true,standard:true,stream:true,supportFetchAPI:true}}]);
let win:BrowserWindow|null=null;
const sourceService = createDefaultSourceService({
  openExternalUrl: async (url: string) => {
    await shell.openExternal(url);
  }
});
function registerHandlers(){
  ipcMain.handle('app:info',async()=>({version:app.getVersion(),dataRoot:app.getPath('userData'),platform:process.platform}));
  ipcMain.handle('app:open-folder',async(_event,id:string)=>({success:!await shell.openPath(projectDir(id))}));
  ipcMain.handle('projects:list',async(_event,archived?:boolean)=>listProjects(!!archived));
  ipcMain.handle('projects:create',async(_event,brief)=>createProject(brief));
  ipcMain.handle('projects:read',async(_event,id:string)=>readProject(id));
  ipcMain.handle('projects:save',async(_event,p)=>saveProject(p));
  ipcMain.handle('projects:archive',async(_event,id:string,archive:boolean)=>archiveProject(id,archive));
  ipcMain.handle('projects:discard-draft',async(_event,id:string)=>discardDraftIfEmpty(id));
  ipcMain.handle('projects:export',async(_event,id:string)=>exportFolder(id));
  ipcMain.handle('projects:import',async()=>importProject());
  ipcMain.handle('assets:import',async(_event,id:string,targetSceneId?:string)=>importAssets(id,targetSceneId?String(targetSceneId):undefined));
  ipcMain.handle('assets:reveal',async(_event,id:string,assetId:string)=>revealAsset(id,assetId));
  ipcMain.handle('clipboard:write',async(_event,text:string)=>clipboard.writeText(String(text)));
  ipcMain.handle('sources:providers',async()=>sourceService.listProviders());
  ipcMain.handle('sources:search',async(_event,query)=>sourceService.search(query));
  ipcMain.handle('sources:fetch-original',async(_event,candidate)=>sourceService.fetchOriginal(candidate));
  ipcMain.handle('sources:compare',async(_event,primary,secondary)=>sourceService.compare(primary,secondary));
  ipcMain.handle('sources:import-url',async(_event,url:string)=>sourceService.importUrl(String(url)));
  ipcMain.handle('sources:import-file',async()=>{
    const picked=await dialog.showOpenDialog({
      title:'원문 텍스트 파일 가져오기',
      properties:['openFile'],
      filters:[
        {name:'지원 원문 파일 (TXT · MD · SRT · HTML · DOCX)',extensions:['txt','md','srt','html','htm','docx']},
        {name:'텍스트 파일',extensions:['txt','md','srt']},
        {name:'HTML',extensions:['html','htm']},
        {name:'Word 문서 (DOCX)',extensions:['docx']},
        {name:'PDF (지원 안 함 · 안내)',extensions:['pdf']}
      ]
    });
    if(picked.canceled || !picked.filePaths.length) return null;
    return sourceService.importFilePath(picked.filePaths[0]);
  });
  ipcMain.handle('sources:import-file-path',async(_event,filePath:string)=>{
    const raw=String(filePath||'').trim();
    if(!raw) throw new Error('파일 경로가 비어 있습니다.');
    return sourceService.importFilePath(raw);
  });
  ipcMain.handle('sources:fetch-bible',async(_event,req)=>sourceService.fetchBible(req));
  ipcMain.handle('sources:open-external',async(_event,url:string)=>sourceService.openExternal(String(url)));
  ipcMain.handle('gemini:status',async()=>geminiAdapter.getStatus());
  ipcMain.handle('gemini:ping',async()=>geminiAdapter.ping());
  ipcMain.handle('gemini:submit',async(_event,job)=>geminiAdapter.submitPrompt(job));
  ipcMain.handle('gemini:jobs:list',async()=>jobQueue.list().map((j:GeminiJobRecord)=>jobForRenderer(j)));
  ipcMain.handle('gemini:jobs:enqueue',async(_event,input)=>jobQueue.enqueue(input));
  // 재시도·재전송은 사용자가 버튼으로 명시적으로 고른 경우에만 호출되며, 호출 후 대기열을 실행합니다.
  ipcMain.handle('gemini:jobs:retry',async(_event,jobId)=>{const j=await jobQueue.retry(jobId);if(j)void analysis.kick();return j?jobForRenderer(j):j;});
  ipcMain.handle('gemini:jobs:cancel',async(_event,jobId)=>{const j=await jobQueue.cancel(jobId);return j?jobForRenderer(j):j;});
  ipcMain.handle('gemini:jobs:confirm',async(_event,jobId)=>{const j=await jobQueue.confirmResend(jobId);if(j)void analysis.kick();return j?jobForRenderer(j):j;});
  ipcMain.handle('gemini:jobs:continue',async(_event,jobId)=>{const j=await jobQueue.continueWaiting(jobId);return j?jobForRenderer(j):j;});
  // stage 생략 = 기획 분석 (기존 호출 호환). 스토리보드·생성 프롬프트·최종 편집 구성도 같은 경로
  const stageArg=(stage:unknown):AIStage=>isAIStage(stage)?stage:'analysis';
  ipcMain.handle('gemini:analysis:start',async(_event,projectId:string,stage?:string)=>analysis.start(String(projectId),stageArg(stage)));
  ipcMain.handle('gemini:analysis:latest',async(_event,projectId:string,stage?:string)=>jobQueue.latest(String(projectId),stageArg(stage))||null);
  ipcMain.handle('gemini:analysis:fetch',async(_event,jobId:string)=>analysis.fetchResult(String(jobId)));
  ipcMain.handle('gemini:analysis:apply',async(_event,jobId:string,stage?:string)=>analysis.applyResult(String(jobId),stage===undefined?undefined:stageArg(stage)));
  ipcMain.handle('gemini:image:start',async(_event,projectId:string,sceneId:string)=>analysis.startImage(String(projectId),String(sceneId)));
  ipcMain.handle('gemini:image:latest',async(_event,projectId:string,sceneId?:string)=>jobQueue.latest(String(projectId),'image',sceneId?String(sceneId):undefined)||null);
  ipcMain.handle('gemini:image:list',async(_event,projectId:string)=>jobQueue.list().filter((j:GeminiJobRecord)=>j.projectId===String(projectId)&&j.kind==='image'));
  ipcMain.handle('gemini:video:start',async(_event,projectId:string,sceneId:string,options?:{useReferenceImage?:boolean})=>{const r=await analysis.startVideo(String(projectId),String(sceneId),options&&typeof options==='object'?{useReferenceImage:!!options.useReferenceImage}:undefined);return r.job?{...r,job:jobForRenderer(r.job)}:r;});
  ipcMain.handle('gemini:video:latest',async(_event,projectId:string,sceneId?:string)=>{const j=jobQueue.latest(String(projectId),'video',sceneId?String(sceneId):undefined);return j?jobForRenderer(j):null;});
  ipcMain.handle('gemini:video:list',async(_event,projectId:string)=>jobQueue.list().filter((j:GeminiJobRecord)=>j.projectId===String(projectId)&&j.kind==='video').map(jobForRenderer));
  ipcMain.handle('gemini:music:start',async(_event,projectId:string)=>analysis.startMusic(String(projectId)));
  ipcMain.handle('gemini:music:latest',async(_event,projectId:string)=>jobQueue.latest(String(projectId),'music')||null);
  ipcMain.handle('gemini:music:list',async(_event,projectId:string)=>jobQueue.list().filter((j:GeminiJobRecord)=>j.projectId===String(projectId)&&j.kind==='music'));
  ipcMain.handle('gemini:source:start',async(_event,projectId:string,query)=>analysis.startSource(String(projectId),query||{title:''}));
  ipcMain.handle('gemini:source:latest',async(_event,projectId:string)=>jobQueue.latest(String(projectId),'source')||null);
  ipcMain.handle('gemini:probe',async()=>geminiAdapter.probe());
}
let analysis: AnalysisService;
/** 바뀐 작업만 renderer에 알림 (모달을 닫아도 main의 큐가 상태를 계속 보관) */
const lastBroadcast=new Map<string,string>();
function jobForRenderer(job:GeminiJobRecord):GeminiJobRecord{
  if(!job.referenceImage?.dataUrl)return job;
  const {dataUrl:_omit,...meta}=job.referenceImage;
  return {...job,referenceImage:{...meta,dataUrl:''}};
}
function broadcastJobs(){
  if(!win||win.isDestroyed())return;
  for(const job of jobQueue.list() as GeminiJobRecord[]){
    if(lastBroadcast.get(job.jobId)===job.updatedAt+job.phase)continue;
    lastBroadcast.set(job.jobId,job.updatedAt+job.phase);
    win.webContents.send('gemini:job-update',jobForRenderer(job));
  }
}
function setupGeminiAutomation(){
  analysis=createAnalysisService({
    queue: jobQueue, adapter: geminiAdapter, readProject, saveProject, saveGeneratedImageAsset, saveGeneratedMediaAsset,
    async readAssetBuffer(projectId, relativePath){
      return readFile(resolveAssetPath(projectId, relativePath));
    },
    encodeReferenceImage(input){
      return encodeReferenceImageForNativeMessaging({
        ...input,
        mimeType: input.mimeType || mimeFromFileName(input.name)
      }, { resize: resizeWithElectronNativeImage });
    }
    // 저장 결과는 job-update(outcome='applied', appliedRevision)로 renderer에 전달됩니다.
  });
  jobQueue.subscribe(broadcastJobs);
  pipeClient.onMessage((msg)=>{void analysis.handleMessage(msg).catch(err=>console.error('gemini message',err));});
  pipeClient.onDisconnect(()=>{void jobQueue.markConnectionLost();});
  pipeClient.onConnect(()=>{void analysis.onReconnect();});
  // 응답 소식이 10분 넘게 없으면 '사용자 확인 필요'로 (자동 재전송 없음)
  setInterval(()=>{void jobQueue.expireStale(10*60*1000);},60*1000);
}
let jobQueue: InstanceType<typeof GeminiJobQueue>;
async function createWindow(){
  win=new BrowserWindow({width:1500,height:960,minWidth:1280,minHeight:720,show:false,title:BRAND.productKo,
    backgroundColor: '#F8FAFC', // Default light-blue; renderer applies stored theme before paint
    autoHideMenuBar:true,icon:app.isPackaged?join(process.resourcesPath,'app.png'):join(app.getAppPath(),'resources/app.png'),
    webPreferences:{preload:join(__dirname,'../preload/index.js'),sandbox:false,nodeIntegration:false,contextIsolation:true,webSecurity:true}});
  win.once('ready-to-show',()=>win?.show());
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event)=>event.preventDefault());
  if(process.env.ELECTRON_RENDERER_URL){await win.loadURL(process.env.ELECTRON_RENDERER_URL);}else{await win.loadFile(join(__dirname,'../renderer/index.html'));}
}
app.whenReady().then(async()=>{
  // Fixed data namespace survives future visible rebranding.
  app.setPath('userData',join(app.getPath('appData'),INTERNAL.storageNamespace));
  await mkdir(app.getPath('userData'),{recursive:true});
  jobQueue = new GeminiJobQueue(join(app.getPath('userData'), 'gemini-jobs.json'));
  await jobQueue.load();
  setupGeminiAutomation();
  void pipeClient.ensureConnected();
  protocol.handle('gomo-asset', async(req)=>{
    try {
      const url=new URL(req.url);if(url.hostname!=='media')return new Response('Not found',{status:404});
      const [projectId,assetId]=url.pathname.split('/').filter(Boolean);
      const p=await readProject(projectId);const a=p.assets.find(a=>a.id===assetId);
      if(!a)return new Response('Not found',{status:404});
      const file=resolveAssetPath(projectId,a.relativePath);return net.fetch(pathToFileURL(file).toString());
    }catch{return new Response('Not found',{status:404});}
  });
  await cleanupEmptyDrafts().catch(err=>console.error('Draft cleanup failed',err));
  registerHandlers();await createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)void createWindow();});
}).catch(err=>{console.error(err);void dialog.showErrorBox('실행 실패',String(err));app.quit();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
