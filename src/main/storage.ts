import { app, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { cp, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { AssetKind, Brief, StudioProject, ProjectSummary } from '../shared/types';
import { isEmptyDraft, makeProject, summarize, toHandoff, toComposerDraft } from '../shared/workflow';
import { migrateProjectDocument } from '../shared/original-versioning';
import { INTERNAL } from '../shared/brand';
import { bgmFileName, sceneAssetBase, splitExt, versionedFileName } from '../shared/asset-naming';

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
  return migrateProjectDocument(raw);
}
async function persist(p:StudioProject):Promise<void>{
  const target=documentPath(p.id);
  await mkdir(dirname(target),{recursive:true});
  const temp=target+'.writing-'+randomUUID();
  await writeFile(temp,JSON.stringify(p,null,2),'utf8');
  try { await rename(temp,target); }
  catch(err) { const { unlink }=await import('node:fs/promises'); await copyFile(temp,target);await unlink(temp); }
}
/** 「새 작품」: 입력 창 없이 바로 빈 작품(작성 중)을 만들고, 내용은 작품 정보 화면에서 채운다. */
export async function createProject(brief:Brief):Promise<StudioProject>{
  if(!brief||typeof brief!=='object') throw Error('작품 정보 형식이 올바르지 않습니다.');
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
/** 아무것도 입력하지 않은 작성 중 작품만 지운다. 하나라도 입력했으면 지우지 않는다. */
export async function discardDraftIfEmpty(id:string):Promise<boolean>{
  let p:StudioProject;
  try { p=await readProject(id); } catch { return false; }
  if(!isEmptyDraft(p)) return false;
  await rm(projectDir(id),{recursive:true,force:true});
  return true;
}
/** 앱을 닫는 사이 남은 빈 작품 정리 (시작할 때 한 번) */
export async function cleanupEmptyDrafts():Promise<number>{
  await ensureRoot();
  const { readdir }=await import('node:fs/promises');
  let removed=0;
  for(const dir of await readdir(projectsRoot(),{withFileTypes:true})){
    if(!dir.isDirectory()||!projectRegex.test(dir.name))continue;
    try{ if(await discardDraftIfEmpty(dir.name)) removed++; }catch(err){ console.error('Draft cleanup failed',dir.name,err); }
  }
  return removed;
}
export async function archiveProject(id:string,archive:boolean):Promise<StudioProject>{
  const p=await readProject(id);return saveProject({...p,archived:archive});
}
function kindFromExtension(ext:string):AssetKind|null{
  const e=ext.toLowerCase();if(['.png','.jpg','.jpeg','.webp','.gif','.bmp'].includes(e))return 'image';
  if(['.mp4','.mov','.m4v','.webm','.mkv'].includes(e))return 'video';
  if(['.mp3','.wav','.m4a','.flac','.ogg','.aac'].includes(e))return 'audio';return null;
}
/** assets/<kind>/ 안에서 이미 쓰고 있는 파일 이름(디스크 + project.json 참조) */
async function takenNames(p:StudioProject,kind:AssetKind):Promise<Set<string>>{
  const names=new Set<string>();
  for(const a of p.assets){const parts=a.relativePath.split(/[\\/]/);if(parts[1]===kind)names.add(parts.slice(2).join('/'));}
  try{const { readdir }=await import('node:fs/promises');for(const f of await readdir(join(projectDir(p.id),'assets',kind)))names.add(f);}catch{/* 폴더 없음 */}
  return names;
}
/** 겹치지 않는 이름을 골라 새 파일로 쓴다(덮어쓰기 없음: 'wx'). 동시에 같은 이름을 고르면 다음 번호로 다시 시도 */
async function writeNewAssetFile(p:StudioProject,kind:AssetKind,pick:(taken:Set<string>)=>string,write:(destination:string)=>Promise<void>):Promise<{name:string;relative:string}>{
  const taken=await takenNames(p,kind);
  for(let attempt=0;attempt<50;attempt++){
    const name=pick(taken);const relative=`assets/${kind}/${name}`;
    const destination=resolveAssetPath(p.id,relative);await mkdir(dirname(destination),{recursive:true});
    try{await write(destination);return {name,relative};}
    catch(err){if((err as NodeJS.ErrnoException).code==='EEXIST'){taken.add(name);continue;}throw err;}
  }
  throw Error('저장할 파일 이름을 정하지 못했습니다.');
}
export async function importAssets(id:string,targetSceneId?:string):Promise<StudioProject|null>{
  const chosen=await dialog.showOpenDialog({title:'이미지·영상·음악 가져오기',properties:['openFile','multiSelections'],filters:[{name:'미디어 파일',extensions:['png','jpg','jpeg','webp','gif','bmp','mp4','mov','m4v','webm','mkv','mp3','wav','m4a','flac','ogg','aac']}]});
  if(chosen.canceled || !chosen.filePaths.length)return null;
  const p=await readProject(id);
  const sceneIdx=targetSceneId?p.scenes.findIndex(sc=>sc.id===targetSceneId):-1;
  // 장면에 연결할 파일(선택한 것 중 마지막 이미지·영상)만 S04_image.png 처럼 장면 이름을 붙이고, 나머지는 원래 이름 유지
  const forScene=sceneIdx>=0?[...chosen.filePaths].reverse().find(f=>{const k=kindFromExtension(extname(f));return k==='image'||k==='video';}):undefined;
  let lastImportedForScene:string|null=null;
  for(const source of chosen.filePaths){const kind=kindFromExtension(extname(source));if(!kind)continue;
    const unique=randomUUID();const original=basename(source);
    const ext=extname(source).replace(/^\./,'').toLowerCase();
    const pick=source===forScene
      ?(taken:Set<string>)=>versionedFileName(sceneAssetBase(p.scenes[sceneIdx].id,sceneIdx,kind),ext,taken)
      :(taken:Set<string>)=>{const {base,ext:e}=splitExt(safeName(original));return versionedFileName(base,e,taken);};
    const {name,relative}=await writeNewAssetFile(p,kind,pick,async dest=>{await copyFile(source,dest,fsConstants.COPYFILE_EXCL);});
    const s=await stat(resolveAssetPath(id,relative));p.assets.push({id:unique,kind,name,relativePath:relative,bytes:s.size,importedAt:new Date().toISOString()});
    if(source===forScene)lastImportedForScene=unique;
  }
  if(targetSceneId&&lastImportedForScene){
    p.scenes=p.scenes.map(sc=>sc.id===targetSceneId?{...sc,assetId:lastImportedForScene,status:'complete' as const}:sc);
  }
  const next={...p,revision:p.revision+1,updatedAt:new Date().toISOString()};
  await persist(next);return next;
}

function extFromMediaMime(kind: AssetKind, mime?: string): string {
  const m = (mime || '').toLowerCase();
  if (kind === 'video') {
    if (m.includes('webm')) return 'webm';
    if (m.includes('quicktime') || m.includes('mov')) return 'mov';
    if (m.includes('mkv') || m.includes('matroska')) return 'mkv';
    return 'mp4';
  }
  if (kind === 'audio') {
    if (m.includes('wav')) return 'wav';
    if (m.includes('ogg')) return 'ogg';
    if (m.includes('flac')) return 'flac';
    if (m.includes('aac')) return 'aac';
    if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
    return 'mp3';
  }
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

const ALLOWED_EXTS_BY_KIND: Record<AssetKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv'],
  audio: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac']
};

export function decodeMediaDataUrl(kind: AssetKind, dataUrl: string): { buffer: Buffer; mimeType: string; ext: string } {
  const match = dataUrl.match(/^data:((?:image|video|audio)\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) {
    throw new Error('유효한 base64 미디어 데이터(data:...) 형식이 아닙니다.');
  }
  const mimeType = match[1].toLowerCase();
  const buffer = Buffer.from(match[2].trim(), 'base64');
  if (!buffer.byteLength) {
    throw new Error('디코딩된 미디어 데이터가 비어 있습니다.');
  }
  return { buffer, mimeType, ext: extFromMediaMime(kind, mimeType) };
}

export function decodeImageDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string; ext: string } {
  return decodeMediaDataUrl('image', dataUrl);
}

/**
 * Phase 5 공용: Gemini에서 생성된 이미지·동영상·배경음악 파일을 프로젝트 내부 `assets/<kind>/` 하위에 저장한다.
 * - image / video: sceneId 필수, 저장 후 해당 scene.assetId에 자동 연결
 * - audio (배경음악): 장면에는 연결하지 않고 project.assets에만 추가 (최종 편집안 BGM 선택 목록에 표시)
 */
export async function saveGeneratedMediaAsset(
  projectId: string,
  kind: AssetKind,
  input: { sceneId?: string; imageDataUrl?: string; mediaDataUrl?: string; downloadPath?: string; mimeType?: string }
): Promise<{ project: StudioProject; asset: import('../shared/types').MediaAsset }> {
  const p = await readProject(projectId);
  let sceneIdx = -1;
  if (kind === 'image' || kind === 'video') {
    if (!input.sceneId) throw new Error('장면 ID(sceneId)가 필요합니다.');
    sceneIdx = p.scenes.findIndex(s => s.id === input.sceneId);
    if (sceneIdx < 0) throw new Error(`장면(${input.sceneId})을 찾을 수 없습니다.`);
  }

  let buffer: Buffer;
  let ext = extFromMediaMime(kind, input.mimeType);
  const dataUrl = input.mediaDataUrl || input.imageDataUrl;

  if (dataUrl && /^data:(?:image|video|audio)\//i.test(dataUrl)) {
    const decoded = decodeMediaDataUrl(kind, dataUrl);
    buffer = decoded.buffer;
    ext = decoded.ext;
  } else if (input.downloadPath) {
    // Chrome 다운로드 완료 직후 Windows 파일 잠금(.crdownload 이름 변경 등)이 잠깐 남을 수 있어 짧게 재시도
    let readBuf: Buffer | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        readBuf = await readFile(input.downloadPath);
        if (readBuf.byteLength > 0) break;
      } catch (e) {
        lastErr = e;
      }
      await new Promise(r => setTimeout(r, 120));
    }
    if (!readBuf || !readBuf.byteLength) {
      throw new Error(
        `다운로드된 파일을 읽지 못했습니다: ${lastErr instanceof Error ? lastErr.message : '파일이 비어 있거나 접근할 수 없습니다.'}`
      );
    }
    buffer = readBuf;
    const pathExt = extname(input.downloadPath).replace(/^\./, '').toLowerCase();
    if (ALLOWED_EXTS_BY_KIND[kind].includes(pathExt)) {
      ext = pathExt === 'jpeg' ? 'jpg' : pathExt;
    }
  } else {
    throw new Error('생성된 미디어 데이터가 없습니다.');
  }

  const unique = randomUUID();
  // 다른 프로그램에서도 알아보도록: S04_image.png · S04_video.mp4 · BGM_01.mp3 (겹치면 _v2 — 기존 파일은 덮어쓰지 않음)
  const { name, relative } = await writeNewAssetFile(
    p,
    kind,
    (taken) => kind === 'audio' ? bgmFileName(ext, taken) : versionedFileName(sceneAssetBase(p.scenes[sceneIdx]?.id, sceneIdx, kind), ext, taken),
    (destination) => writeFile(destination, buffer, { flag: 'wx' })
  );

  const importedAt = new Date().toISOString();
  const asset: import('../shared/types').MediaAsset = {
    id: unique,
    kind,
    name,
    relativePath: relative,
    bytes: buffer.byteLength,
    importedAt
  };

  const nextScenes =
    sceneIdx >= 0
      ? p.scenes.map((s, idx) => (idx === sceneIdx ? { ...s, assetId: asset.id, status: 'complete' as const } : s))
      : p.scenes;

  const next: StudioProject = {
    ...p,
    assets: [...p.assets, asset],
    scenes: nextScenes,
    revision: p.revision + 1,
    updatedAt: importedAt
  };
  await persist(next);
  return { project: next, asset };
}

/** Phase 5 MVP 호환 래퍼: 이미지 생성 저장 */
export async function saveGeneratedImageAsset(
  projectId: string,
  sceneId: string,
  input: { imageDataUrl?: string; downloadPath?: string; mimeType?: string }
): Promise<{ project: StudioProject; asset: import('../shared/types').MediaAsset }> {
  return saveGeneratedMediaAsset(projectId, 'image', { ...input, sceneId });
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
