import { app, BrowserWindow, clipboard, ipcMain, net, protocol, shell, dialog, nativeTheme } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { INTERNAL, BRAND } from '../shared/brand';
import { archiveProject, createProject, exportFolder, importAssets, listProjects, projectDir, readProject, resolveAssetPath, revealAsset, saveProject } from './storage';
import { geminiAdapter } from './gemini/adapter';
import { pipeClient } from './gemini/pipe-client';
import { GeminiJobQueue } from './gemini/job-queue.mjs';
import { createAnalysisService, type AnalysisService } from './gemini/analysis-service';
import { isAIStage } from '../shared/gemini-analysis';
import type { AIStage } from '../shared/types';
import type { GeminiJobRecord } from '../shared/types';

protocol.registerSchemesAsPrivileged([{scheme:'gomo-asset', privileges:{secure:true,standard:true,stream:true,supportFetchAPI:true}}]);
let win:BrowserWindow|null=null;
function registerHandlers(){
  ipcMain.handle('app:info',async()=>({version:app.getVersion(),dataRoot:app.getPath('userData'),platform:process.platform}));
  ipcMain.handle('app:open-folder',async(_event,id:string)=>({success:!await shell.openPath(projectDir(id))}));
  ipcMain.handle('projects:list',async(_event,archived?:boolean)=>listProjects(!!archived));
  ipcMain.handle('projects:create',async(_event,brief)=>createProject(brief));
  ipcMain.handle('projects:read',async(_event,id:string)=>readProject(id));
  ipcMain.handle('projects:save',async(_event,p)=>saveProject(p));
  ipcMain.handle('projects:archive',async(_event,id:string,archive:boolean)=>archiveProject(id,archive));
  ipcMain.handle('projects:export',async(_event,id:string)=>exportFolder(id));
  ipcMain.handle('assets:import',async(_event,id:string)=>importAssets(id));
  ipcMain.handle('assets:reveal',async(_event,id:string,assetId:string)=>revealAsset(id,assetId));
  ipcMain.handle('clipboard:write',async(_event,text:string)=>clipboard.writeText(String(text)));
  ipcMain.handle('gemini:status',async()=>geminiAdapter.getStatus());
  ipcMain.handle('gemini:ping',async()=>geminiAdapter.ping());
  ipcMain.handle('gemini:submit',async(_event,job)=>geminiAdapter.submitPrompt(job));
  ipcMain.handle('gemini:jobs:list',async()=>jobQueue.list());
  ipcMain.handle('gemini:jobs:enqueue',async(_event,input)=>jobQueue.enqueue(input));
  // 재시도·재전송은 사용자가 버튼으로 명시적으로 고른 경우에만 호출되며, 호출 후 대기열을 실행합니다.
  ipcMain.handle('gemini:jobs:retry',async(_event,jobId)=>{const j=await jobQueue.retry(jobId);if(j)void analysis.kick();return j;});
  ipcMain.handle('gemini:jobs:cancel',async(_event,jobId)=>jobQueue.cancel(jobId));
  ipcMain.handle('gemini:jobs:confirm',async(_event,jobId)=>{const j=await jobQueue.confirmResend(jobId);if(j)void analysis.kick();return j;});
  ipcMain.handle('gemini:jobs:continue',async(_event,jobId)=>jobQueue.continueWaiting(jobId));
  // stage 생략 = 기획 분석 (기존 호출 호환). 스토리보드·생성 프롬프트·최종 편집 구성도 같은 경로
  const stageArg=(stage:unknown):AIStage=>isAIStage(stage)?stage:'analysis';
  ipcMain.handle('gemini:analysis:start',async(_event,projectId:string,stage?:string)=>analysis.start(String(projectId),stageArg(stage)));
  ipcMain.handle('gemini:analysis:latest',async(_event,projectId:string,stage?:string)=>jobQueue.latest(String(projectId),stageArg(stage))||null);
  ipcMain.handle('gemini:analysis:fetch',async(_event,jobId:string)=>analysis.fetchResult(String(jobId)));
  ipcMain.handle('gemini:analysis:apply',async(_event,jobId:string,stage?:string)=>analysis.applyResult(String(jobId),stage===undefined?undefined:stageArg(stage)));
  ipcMain.handle('gemini:probe',async()=>geminiAdapter.probe());
}
let analysis: AnalysisService;
/** 바뀐 작업만 renderer에 알림 (모달을 닫아도 main의 큐가 상태를 계속 보관) */
const lastBroadcast=new Map<string,string>();
function broadcastJobs(){
  if(!win||win.isDestroyed())return;
  for(const job of jobQueue.list() as GeminiJobRecord[]){
    if(lastBroadcast.get(job.jobId)===job.updatedAt+job.phase)continue;
    lastBroadcast.set(job.jobId,job.updatedAt+job.phase);
    win.webContents.send('gemini:job-update',job);
  }
}
function setupGeminiAutomation(){
  analysis=createAnalysisService({
    queue: jobQueue, adapter: geminiAdapter, readProject, saveProject
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
  win=new BrowserWindow({width:1500,height:960,minWidth:1080,minHeight:720,show:false,title:BRAND.productKo,
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
  registerHandlers();await createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)void createWindow();});
}).catch(err=>{console.error(err);void dialog.showErrorBox('실행 실패',String(err));app.quit();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
