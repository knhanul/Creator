import { app, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { cp, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { AssetKind, Brief, StudioProject, ProjectSummary } from '../shared/types';
import { makeProject, summarize, toHandoff, toComposerDraft } from '../shared/workflow';
import { INTERNAL } from '../shared/brand';

const projectRegex=/^[0-9a-f-]{36}$/i;
const ensureId=(id:string)=> {if (!projectRegex.test(id)) throw Error('유효하지 않은 작품 ID입니다.');return id;};
export const projectsRoot=()=>join(app.getPath('userData'),'projects');
export const projectDir=(id:string)=>join(projectsRoot(),ensureId(id));
const documentPath=(id:string)=>join(projectDir(id),'project.json');
async function ensureRoot(){await mkdir(projectsRoot(),{recursive:true});}
export function safeName(name:string):string {return name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,90)||'untitled';}
export function resolveAssetPath(projectId:string, relative:string):string {
  const root=resolve(projectDir(projectId));
  const full=resolve(root,relative);
  if (!full.startsWith(root+sep) || !relative.startsWith(`assets${sep}`) && !relative.startsWith('assets/')) throw Error('프로젝트 외부 미디어 경로는 허용하지 않습니다.');
  return full;
}
export async function listProjects(includeArchived=false):Promise<ProjectSummary[]>{
  await ensureRoot();
  const { readdir }=await import('node:fs/promises');
  const dirs=await readdir(projectsRoot(),{withFileTypes:true});
  const results:ProjectSummary[]=[];
  for(const dir of dirs){if(!dir.isDirectory()||!projectRegex.test(dir.name))continue;try{const p=await readProject(dir.name);if(includeArchived||!p.archived) results.push(summarize(p));}catch(err){console.error('Project parse failed',dir.name,err);}}
  return results.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export async function readProject(id:string):Promise<StudioProject>{
  const raw=JSON.parse(await readFile(documentPath(id),'utf8')) as StudioProject;
  if(raw.schema!==INTERNAL.projectSchema || raw.id!==id) throw Error('지원하지 않는 프로젝트 형식입니다.');
  return raw;
}
async function persist(p:StudioProject):Promise<void>{
  const target=documentPath(p.id);
  await mkdir(dirname(target),{recursive:true});
  const temp=target+'.writing-'+randomUUID();
  await writeFile(temp,JSON.stringify(p,null,2),'utf8');
  try { await rename(temp,target); }
  catch(err) { const { unlink }=await import('node:fs/promises'); await copyFile(temp,target);await unlink(temp); }
}
export async function createProject(brief:Brief):Promise<StudioProject>{
  if(!brief.title.trim()||!brief.originalText.trim()) throw Error('제목과 원문을 입력하세요.');
  await ensureRoot();const p=makeProject(randomUUID(),brief);
  await mkdir(projectDir(p.id),{recursive:true});await persist(p);return p;
}
export async function saveProject(p:StudioProject):Promise<StudioProject>{
  const current=await readProject(p.id);
  if(p.schema!==INTERNAL.projectSchema || p.revision!==current.revision) throw Error('다른 작업에서 프로젝트가 변경되었습니다. 다시 불러오세요.');
  if(p.id!==current.id || p.createdAt!==current.createdAt) throw Error('프로젝트 고유 정보가 변경되었습니다.');
  // Never let an untrusted renderer rename imported files or invent paths.
  for(const asset of p.assets){ if(!current.assets.some(x=>x.id===asset.id && x.relativePath===asset.relativePath)) throw Error('미디어 파일은 가져오기 기능으로만 등록할 수 있습니다.'); }
  const next:StudioProject={...p,revision:current.revision+1,updatedAt:new Date().toISOString()};
  await persist(next);return next;
}
export async function archiveProject(id:string,archive:boolean):Promise<StudioProject>{
  const p=await readProject(id);return saveProject({...p,archived:archive});
}
function kindFromExtension(ext:string):AssetKind|null{
  const e=ext.toLowerCase();if(['.png','.jpg','.jpeg','.webp','.gif','.bmp'].includes(e))return 'image';
  if(['.mp4','.mov','.m4v','.webm','.mkv'].includes(e))return 'video';
  if(['.mp3','.wav','.m4a','.flac','.ogg','.aac'].includes(e))return 'audio';return null;
}
export async function importAssets(id:string):Promise<StudioProject|null>{
  const chosen=await dialog.showOpenDialog({title:'이미지·영상·음악 가져오기',properties:['openFile','multiSelections'],filters:[{name:'미디어 파일',extensions:['png','jpg','jpeg','webp','gif','bmp','mp4','mov','m4v','webm','mkv','mp3','wav','m4a','flac','ogg','aac']}]});
  if(chosen.canceled || !chosen.filePaths.length)return null;
  const p=await readProject(id);
  for(const source of chosen.filePaths){const kind=kindFromExtension(extname(source));if(!kind)continue;
    const unique=randomUUID();const name=basename(source);const relative=`assets/${kind}/${unique}_${safeName(name)}`;
    const destination=resolveAssetPath(id,relative);await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);
    const s=await stat(destination);p.assets.push({id:unique,kind,name,relativePath:relative,bytes:s.size,importedAt:new Date().toISOString()});
  }
  const next={...p,revision:p.revision+1,updatedAt:new Date().toISOString()};
  await persist(next);return next;
}
export async function revealAsset(id:string,assetId:string):Promise<void>{
  const p=await readProject(id);const a=p.assets.find(x=>x.id===assetId);if(!a)throw Error('미디어 항목이 없습니다.');
  shell.showItemInFolder(resolveAssetPath(id,a.relativePath));
}
export async function exportFolder(id:string):Promise<string|null>{
  const p=await readProject(id);
  const picked=await dialog.showOpenDialog({title:'제작 패키지 저장할 폴더',properties:['openDirectory','createDirectory']});
  if(picked.canceled || !picked.filePaths.length)return null;
  const output=join(picked.filePaths[0],`${safeName(p.brief.title)}_${p.id.slice(0,8)}`);
  // New destination only. Never overwrite another project export.
  const {access}=await import('node:fs/promises');try{await access(output);throw Error('같은 이름의 내보내기 폴더가 이미 있습니다. 다른 위치를 선택해 주세요.');}catch(err){if ((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;}
  await cp(projectDir(id),output,{recursive:true,errorOnExist:true,force:false});
  await writeFile(join(output,'gomo-handoff.json'),JSON.stringify(toHandoff(p),null,2),'utf8');
  const composer=toComposerDraft(p);
  if(composer){
    await writeFile(join(output,'composer_project.json'),JSON.stringify(composer.project,null,2),'utf8');
    await writeFile(join(output,'captions.srt'),composer.srt,'utf8');
  }
  await writeFile(join(output,'README_더빙프로그램_연결.txt'),
    `고모 창작실 제작 패키지\r\n\r\n작품: ${p.brief.title}\r\n\r\n이 폴더의 gomo-handoff.json은 편집 설계를 위한 교환 데이터입니다.\r\ngomo-handoff.json은 별도 교환 포맷입니다.\r\n${composer?'composer_project.json과 captions.srt는 영상 합성기(version 2)용 호환 초안입니다. 설치된 더빙 프로그램에서 실제로 열리는지 확인 후 사용하세요.':'아직 미디어 또는 편집안이 완비되지 않아 composer_project.json은 생성하지 않았습니다. 준비 완료 후 다시 내보내 주세요.'}\r\n원문·제작 정보는 project.json에서 확인할 수 있습니다.\r\n`, 'utf8');
  return output;
}
