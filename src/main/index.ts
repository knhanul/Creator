import { app, BrowserWindow, clipboard, ipcMain, net, protocol, shell, dialog, nativeTheme } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { INTERNAL, BRAND } from '../shared/brand';
import { archiveProject, createProject, exportFolder, importAssets, listProjects, projectDir, readProject, resolveAssetPath, revealAsset, saveProject } from './storage';
import { geminiAdapter } from './gemini/adapter';

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
}
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
