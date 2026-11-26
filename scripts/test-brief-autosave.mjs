import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import assert from 'node:assert/strict';

const require=createRequire(import.meta.url);
let ts;
try{ts=require('typescript');}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js');}
const cache=new Map();
function loadTS(filename){filename=resolve(filename);if(cache.has(filename))return cache.get(filename).exports;const module={exports:{}};cache.set(filename,module);const js=ts.transpileModule(readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;function localRequire(spec){if(spec.startsWith('.'))return loadTS(resolve(dirname(filename),spec+'.ts'));return require(spec);}new Function('require','module','exports',js)(localRequire,module,module.exports);return module.exports;}

const root=resolve(import.meta.dirname,'..');
const {NEW_DRAFT_BRIEF,makeProject,stageComplete}=loadTS(join(root,'src/shared/workflow.ts'));
const {applyBriefAutosave}=loadTS(join(root,'src/shared/brief-edit.ts'));
const {STEP_TITLES}=loadTS(join(root,'src/shared/step-guide.ts'));
const {
  createBriefAutosaveSession,editableBriefEqual,SAVE_TIMEOUT_MESSAGE,SAVE_FAILED_MESSAGE,notifiedError
}=loadTS(join(root,'src/shared/brief-autosave.ts'));
const {STAGE_META}=loadTS(join(root,'src/shared/gemini-analysis.ts'));

let checks=0;const test=(label,fn)=>{try{fn();checks++;console.log('PASS',label);}catch(e){console.error('FAIL',label,e);process.exitCode=1;}};
const testAsync=async(label,fn)=>{try{await fn();checks++;console.log('PASS',label);}catch(e){console.error('FAIL',label,e);process.exitCode=1;}};

function makeClock(){
  const timers=new Map();
  let nextId=1;
  let now=0;
  return {
    now:()=>now,
    setTimeout(fn,ms){
      const id=nextId++;
      timers.set(id,{at:now+ms,fn});
      return id;
    },
    clearTimeout(id){timers.delete(id);},
    async advance(ms){
      now+=ms;
      const due=[...timers.entries()].filter(([,t])=>t.at<=now).sort((a,b)=>a[1].at-b[1].at);
      for(const [id,t] of due){
        if(!timers.has(id))continue;
        timers.delete(id);
        await t.fn();
      }
    }
  };
}

function setup(opts={}){
  const clock=makeClock();
  const project={current:makeProject('c74cf913-0000-4000-8000-000000000001',NEW_DRAFT_BRIEF)};
  const draft={current:{...project.current.brief}};
  const pending={current:false};
  const saves=[];
  let saveImpl=opts.save;
  const session=createBriefAutosaveSession({
    getDraft:()=>draft.current,
    getSaved:()=>project.current.brief,
    save:async(brief,continueSession)=>{
      if(saveImpl)return saveImpl(brief,continueSession);
      const result=applyBriefAutosave(project.current,brief,{continueSession,timestamp:'2026-11-26T14:55:00.000Z'});
      project.current=result.project;
      saves.push({brief:{...brief},continueSession,started:result.startedSession,title:brief.title,originalText:brief.originalText,genre:brief.genre});
      return result.startedSession;
    },
    onPendingChange:v=>{pending.current=v;},
    delayMs:opts.delayMs??700,
    timeoutMs:opts.timeoutMs??20_000,
    setTimeoutFn:(fn,ms)=>clock.setTimeout(fn,ms),
    clearTimeoutFn:id=>clock.clearTimeout(id)
  });
  const type=(patch)=>{draft.current={...draft.current,...patch};session.markPending();};
  return {clock,project,draft,pending,saves,session,type,setSave:fn=>{saveImpl=fn;}};
}

const psalm='여호와는 나의 목자시니 내게 부족함이 없으리로다';

await testAsync('키 입력은 디바운스 후에 저장되고 현재 작품·원문 v1이 바로 반영된다',async()=>{
  const {clock,project,pending,saves,type}=setup();
  type({genre:'bible',title:'시편23편1절~6절',bibleTranslation:'NKRV',originalText:psalm,autoFilled:{originalText:'Gemini'}});
  assert.equal(pending.current,true);
  assert.equal(saves.length,0);
  await clock.advance(699);
  assert.equal(saves.length,0);
  await clock.advance(1);
  assert.equal(saves.length,1);
  assert.equal(pending.current,false);
  assert.equal(project.current.brief.title,'시편23편1절~6절');
  assert.equal(project.current.brief.genre,'bible');
  assert.equal(project.current.brief.bibleTranslation,'NKRV');
  assert.equal(project.current.brief.originalText,psalm);
  assert.equal(project.current.brief.originalMeta.version,1);
  assert.equal(stageComplete(project.current,'brief'),true);
});

await testAsync('제미나이로 본문을 채우면 디바운스를 기다리지 않고 flush로 바로 저장된다',async()=>{
  const {project,pending,saves,session,type}=setup();
  type({genre:'bible',title:'시편23편1절~6절',bibleTranslation:'NKRV'});
  const first=await session.flush();
  assert.equal(first.ok,true);
  assert.equal(project.current.brief.title,'시편23편1절~6절');
  assert.equal(project.current.brief.originalMeta,undefined);
  type({originalText:psalm,autoFilled:{originalText:'Gemini'}});
  const second=await session.flush();
  assert.equal(second.ok,true);
  assert.equal(second.startedSession,true);
  assert.equal(pending.current,false);
  assert.equal(saves.length,2);
  assert.equal(project.current.brief.originalText,psalm);
  assert.equal(project.current.brief.originalMeta.version,1);
});

await testAsync('pending 플래그가 꺼져 있어도 초안이 다르면 다음 단계 이동 전에 저장한다',async()=>{
  const {project,pending,saves,session,draft}=setup();
  draft.current={...draft.current,genre:'bible',title:'시편23편1절~6절',bibleTranslation:'NKRV',originalText:psalm,autoFilled:{originalText:'Gemini'}};
  pending.current=false;
  assert.equal(saves.length,0);
  const flushed=await session.flush();
  assert.equal(flushed.ok,true);
  assert.equal(saves.length,1);
  assert.equal(project.current.brief.title,'시편23편1절~6절');
  assert.equal(project.current.brief.originalMeta.version,1);
  assert.equal(pending.current,false);
});

await testAsync('저장 중에 다음을 눌러도 최신 초안이 저장된 뒤에만 이동한다',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let started=0;
  const ctx=setup({timeoutMs:20_000});
  ctx.setSave(async(brief,continueSession)=>{
    started+=1;
    if(started===1)await gate;
    const result=applyBriefAutosave(ctx.project.current,brief,{continueSession,timestamp:'2026-11-26T14:55:00.000Z'});
    ctx.project.current=result.project;
    ctx.saves.push({title:brief.title,originalText:brief.originalText});
    return result.startedSession;
  });
  ctx.type({title:'시편'});
  const auto=ctx.session.flush();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started,1);
  ctx.type({title:'시편23편1절~6절',originalText:psalm,genre:'bible',bibleTranslation:'NKRV'});
  let navigated=false;
  const move=ctx.session.flush().then(r=>{if(r.ok)navigated=true;return r;});
  assert.equal(navigated,false);
  assert.equal(ctx.project.current.brief.title,'');
  release();
  const result=await move;
  await auto;
  assert.equal(result.ok,true);
  assert.equal(navigated,true);
  assert.equal(ctx.project.current.brief.title,'시편23편1절~6절');
  assert.equal(ctx.project.current.brief.originalText,psalm);
  assert.equal(ctx.project.current.brief.originalMeta.version,1);
});

await testAsync('저장 실패 시 입력 중 상태를 유지하고 이동을 막으며 오류를 반환한다',async()=>{
  const ctx=setup();
  ctx.setSave(async()=>{throw notifiedError('다른 작업에서 프로젝트가 변경되었습니다. 다시 불러오세요.',true);});
  ctx.type({title:'시편23편1절~6절',originalText:psalm});
  const flushed=await ctx.session.flush();
  assert.equal(flushed.ok,false);
  assert.equal(flushed.notified,true);
  assert.match(flushed.error,/변경되었습니다/);
  assert.equal(ctx.pending.current,true);
  assert.equal(ctx.project.current.brief.title,'');
});

await testAsync('저장이 너무 오래 걸리면 시간 제한 오류로 이동을 막고 pending을 유지한다',async()=>{
  const ctx=setup({timeoutMs:50});
  ctx.setSave(()=>new Promise(()=>{}));
  ctx.type({title:'시편23편1절~6절',originalText:psalm});
  const flushed=ctx.session.flush();
  await Promise.resolve();
  await Promise.resolve();
  await ctx.clock.advance(50);
  const result=await flushed;
  assert.equal(result.ok,false);
  assert.equal(result.error,SAVE_TIMEOUT_MESSAGE);
  assert.equal(ctx.pending.current,true);
});

await testAsync('성경 장르·번역본·자동입력 표시가 있는 초안도 원문 v1로 저장된다',async()=>{
  const project=makeProject('c74cf913-0000-4000-8000-000000000002',NEW_DRAFT_BRIEF);
  const brief={...project.brief,genre:'bible',audience:'kids',title:'시편23편1절~6절',bibleTranslation:'NKRV',originalText:psalm,autoFilled:{originalText:'Gemini'}};
  const saved=applyBriefAutosave(project,brief,{continueSession:false,timestamp:'2026-11-26T14:55:00.000Z'});
  assert.equal(saved.startedSession,true);
  assert.equal(saved.project.brief.genre,'bible');
  assert.equal(saved.project.brief.bibleTranslation,'NKRV');
  assert.equal(saved.project.brief.autoFilled.originalText,'Gemini');
  assert.equal(saved.project.brief.originalMeta.version,1);
  assert.equal(editableBriefEqual(brief,saved.project.brief),true);
  assert.equal(stageComplete(saved.project,'brief'),true);
});

test('기획 분석은 제목·원문이 없으면 시작할 수 없다',()=>{
  const empty=makeProject('c74cf913-0000-4000-8000-000000000003',NEW_DRAFT_BRIEF);
  assert.equal(stageComplete(empty,'brief'),false);
  assert.equal(STAGE_META.analysis.prerequisite(empty),'작품 제목과 낭독 원문을 먼저 입력해 주세요.');
  const ready=applyBriefAutosave(empty,{...empty.brief,title:'시편23편1절~6절',originalText:psalm},{continueSession:false,timestamp:'2026-11-26T14:55:00.000Z'}).project;
  assert.equal(stageComplete(ready,'brief'),true);
  assert.equal(STAGE_META.analysis.prerequisite(ready),null);
  assert.equal(STEP_TITLES.brief,'작품 정보');
  assert.equal(SAVE_FAILED_MESSAGE.length>0,true);
});

console.log(`${checks} brief autosave tests completed`);
if(process.exitCode)process.exit(process.exitCode);
