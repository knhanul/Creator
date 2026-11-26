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
const {DEFAULT_BRIEF,makeProject,extractJSON,applyAIResponse,validateEditPlan,readyForHandoff,toHandoff,stageComplete}=loadTS(join(root,'src/shared/workflow.ts'));
const {makeAIPrompt}=loadTS(join(root,'src/shared/prompts.ts'));
const fixture=name=>JSON.parse(readFileSync(join(root,'fixtures',name),'utf8'));
let checks=0;const test=(label,fn)=>{try{fn();checks++;console.log('PASS',label);}catch(e){console.error('FAIL',label,e);process.exitCode=1;}};
const sample={...DEFAULT_BRIEF,title:'새벽의 작은 정원',originalText:'새벽의 작은 정원에 빛이 내려앉았다.\n풀잎 사이로 부드러운 바람이 지나갔다.\n오늘도 좋은 이야기가 시작된다.',genre:'poetry',rightsStatus:'reviewed'};
const p=makeProject('11111111-1111-1111-1111-111111111111',sample);
test('프로젝트 기본 생성',()=>assert.equal(p.schema,'creator.project.v1'));
test('분석 프롬프트 원문 포함',()=>assert.ok(makeAIPrompt(p,'analysis').includes('새벽의 작은 정원에 빛이')));
test('JSON 코드블록 추출',()=>assert.deepEqual(extractJSON('설명\n```json\n{"schema":"ok","v":1}\n```'),{schema:'ok',v:1}));
test('JSON 주변 설명 추출',()=>assert.deepEqual(extractJSON('설명 {"a":2} 입니다'),{a:2}));
const p1=applyAIResponse(p,'analysis',JSON.stringify(fixture('ai-analysis.example.json')));
test('분석 JSON 검사 및 반영',()=>assert.equal(p1.analysis.styles.length,3));
test('화풍 미승인시 스토리보드 차단',()=>assert.throws(()=>applyAIResponse(p1,'storyboard',JSON.stringify(fixture('ai-storyboard.example.json')))));
p1.selection={styleId:'warm-watercolor',directionId:'gentle'};
const p2=applyAIResponse(p1,'storyboard',JSON.stringify(fixture('ai-storyboard.example.json')));
test('스토리보드 장면 적용',()=>assert.equal(p2.scenes.length,3));
test('장면 생성 시 확정 원문',()=>assert.ok(p2.scenes[0].narration.includes('새벽의 작은 정원')));
const p3=applyAIResponse(p2,'prompt',JSON.stringify(fixture('ai-prompts.example.json')));
test('장면 프롬프트 1:1 매핑',()=>assert.ok(p3.scenes.every(s=>s.imagePrompt.length>10)));
test('프롬프트 장면 ID 누락시 실패',()=>assert.throws(()=>applyAIResponse(p2,'prompt','{"schema":"creator.prompts.v1","items":[]}')));
const p4=applyAIResponse(p3,'editplan',JSON.stringify(fixture('ai-editplan.example.json')));
test('편집 구성 3개 적용',()=>assert.equal(p4.assembly.clips.length,3));
test('잘못된 장면 거부',()=>assert.throws(()=>validateEditPlan({schema:'creator.editplan.v1',clips:[{sceneId:'UNKNOWN',durationSec:10,transition:'fade'}]},p3.scenes)));
test('미디어 없으면 전달 점검 경고',()=>assert.equal(readyForHandoff(p4).ready,false));
test('교환 포맷 별도 표기',()=>assert.equal(toHandoff(p4).schema,'creator.handoff.v1'));
test('장면 없이 기획 진행 상태 계산',()=>assert.equal(stageComplete(p,'storyboard'),false));
const {toComposerDraft}=loadTS(join(root,'src/shared/workflow.ts'));
test('미디어 미연결 편집안은 더빙 초안 생략',()=>assert.equal(toComposerDraft(p4),null));
const pReady=structuredClone(p4);
pReady.assets=pReady.scenes.map((s,i)=>({id:`media-${i}`,kind:s.kind,name:`scene-${i}.${s.kind==='image'?'png':'mp4'}`,relativePath:`assets/${s.kind}/scene-${i}.${s.kind==='image'?'png':'mp4'}`,bytes:500,importedAt:new Date().toISOString()}));
pReady.scenes=pReady.scenes.map((s,i)=>({...s,assetId:`media-${i}`}));
test('더빙 v2 초안 프로젝트·SRT 생성',()=>{const draft=toComposerDraft(pReady);assert.ok(draft);assert.equal(draft.project.version,2);assert.ok(draft.project.clips.length>=3);assert.deepEqual([...new Set(draft.project.clips.map(c=>c.scene_id))],['S01','S02','S03']);assert.ok(draft.srt.includes('-->'));});

// ── 화면 효과: 샷(움직임)·분위기 효과·전환·자막 줄 ──
const fx=loadTS(join(root,'src/shared/effects.ts'));
const {buildTimeline,withSceneEffects}=loadTS(join(root,'src/shared/workflow.ts'));
test('v1 장면도 효과 자동 채움(샷·자막·전환)',()=>{assert.ok(p2.scenes.every(s=>s.effects&&s.effects.shots.length>=1&&s.effects.captions.length>=1&&s.effects.transitionIn));});
test('자동 샷 길이 합 = 장면 길이',()=>{for(const s of p2.scenes){const sum=s.effects.shots.reduce((n,x)=>n+x.durationSec,0);assert.ok(Math.abs(sum-s.durationSec)<0.05,`${s.id} ${sum}`);}});
test('이웃 샷은 같은 움직임이 아님',()=>{const all=p2.scenes.flatMap(s=>s.effects.shots.filter(x=>x.source!=='video').map(x=>x.motion));for(let i=1;i<all.length;i++)assert.notEqual(all[i],all[i-1]);});
test('자막 줄 나누기는 글자를 바꾸지 않음',()=>{const t='여호와는 나의 목자시니 내가 부족함이 없으리로다';const caps=fx.splitCaptions(t,12);assert.ok(caps.length>=2);assert.equal(caps.join(' ').replace(/\s/g,''),t.replace(/\s/g,''));});
const pv2=applyAIResponse(p1,'storyboard',JSON.stringify(fixture('ai-storyboard-v2.example.json')));
test('스토리보드 v2: AI 샷·효과 유지',()=>{const s=pv2.scenes[0];assert.equal(s.effects.shots.length,2);assert.equal(s.effects.shots[1].motion,'focus_in');assert.deepEqual(s.effects.shots[1].focus,{x:.7,y:.35});assert.equal(s.effects.overlay,'light_rays');assert.equal(s.effects.transitionIn.type,'fade_black');});
test('스토리보드 v2: 원문과 다른 자막 줄은 원문으로 다시 나눔',()=>{const s=pv2.scenes[2];assert.ok(fx.captionsMatch(s.effects.captions,s.narration));assert.ok(!s.effects.captions.join('').includes('다르게'));});
test('스토리보드 v2: 전환 별칭(crossfade→fade)',()=>assert.equal(pv2.scenes[2].effects.transitionIn.type,'fade'));
test('스토리보드 v2: 영상 장면 정지+영상 샷',()=>{const s=pv2.scenes[1];assert.deepEqual(s.effects.shots.map(x=>x.source),['image','video']);});
test('편집안: 확장 전환·별칭 허용',()=>{const plan=validateEditPlan({schema:'creator.editplan.v1',clips:[{sceneId:'S01',durationSec:10,transition:'fade_black',transitionSec:1.5},{sceneId:'S02',durationSec:8,transition:'crossfade'}]},p3.scenes);assert.equal(plan.clips[0].transition,'fade_black');assert.equal(plan.clips[0].transitionSec,1.5);assert.equal(plan.clips[1].transition,'fade');});
test('편집안: 모르는 전환 거부',()=>assert.throws(()=>validateEditPlan({schema:'creator.editplan.v1',clips:[{sceneId:'S01',durationSec:10,transition:'spin'}]},p3.scenes)));
const pfx=structuredClone(pv2);pfx.assembly.clips=pfx.scenes.map(s=>({sceneId:s.id,durationSec:s.durationSec*1.5,transition:s.effects.transitionIn.type}));
pfx.assets=[{id:'i1',kind:'image',name:'a.png',relativePath:'assets/image/a.png',bytes:1,importedAt:''},{id:'v2',kind:'video',name:'b.mp4',relativePath:'assets/video/b.mp4',bytes:1,importedAt:''},{id:'r2',kind:'image',name:'b.png',relativePath:'assets/image/b.png',bytes:1,importedAt:''},{id:'i3',kind:'image',name:'c.png',relativePath:'assets/image/c.png',bytes:1,importedAt:''}];
pfx.scenes[0].assetId='i1';pfx.scenes[1].assetId='v2';pfx.scenes[1].referenceImageAssetId='r2';pfx.scenes[2].assetId='i3';
test('타임라인: 클립 길이에 맞춰 샷·자막 재배분',()=>{const tl=buildTimeline(pfx);assert.equal(tl.length,3);for(const seg of tl){assert.ok(Math.abs(seg.shots.at(-1).end-seg.end)<0.11);for(const c of seg.captions){assert.ok(c.start>=seg.start&&c.end<=seg.end+0.01);}}});
test('composer: 샷마다 움직임·초점·효과·xfade 전환',()=>{const d=toComposerDraft(pfx);const c=d.project.clips;assert.equal(d.project.effects_spec,'gomo.effects.v1');assert.equal(c[0].motion,'zoom_in');assert.equal(c[0].transition.type,'fadeblack');assert.deepEqual(c[1].motion_focus,{x:.7,y:.35});assert.equal(c[0].overlay,'light_rays');assert.equal(c[0].tone,'warm');});
test('composer: 영상 장면은 기준 이미지 정지 → 영상(fit_duration, 음소거)',()=>{const c=toComposerDraft(pfx).project.clips.filter(x=>x.scene_id==='S02');assert.deepEqual(c.map(x=>x.type),['image','video']);assert.equal(c[0].file,'assets/image/b.png');assert.equal(c[1].mute,true);assert.ok(c[1].fit_duration>0);});
test('composer: 기준 이미지 없으면 영상 하나로 합침',()=>{const q=structuredClone(pfx);q.scenes[1].referenceImageAssetId=null;const c=toComposerDraft(q).project.clips.filter(x=>x.scene_id==='S02');assert.equal(c.length,1);assert.equal(c[0].type,'video');assert.equal(c[0].fit_duration,15);});
test('composer: 자막이 줄 단위로 나뉘고 시간 순서',()=>{const items=toComposerDraft(pfx).project.subtitle.items;assert.ok(items.length>=4);for(let i=1;i<items.length;i++)assert.ok(items[i].start>=items[i-1].end);});
test('효과 다시 채우기(자막 줄 유지)',()=>{const r=withSceneEffects(pv2,{regenerate:true});assert.deepEqual(r.scenes[0].effects.captions,pv2.scenes[0].effects.captions);assert.ok(r.scenes[0].effects.shots.length>=1);});
test('스토리보드 프롬프트에 효과 설계 요청',()=>{const t=makeAIPrompt(p1,'storyboard');assert.ok(t.includes('creator.storyboard.v2')&&t.includes('focus_in')&&t.includes('captions'));});


// ── 리모델링: 새 작품(빈 작품) · 자동 저장 버전 묶기 · 단계 안내 ──
const {isEmptyDraft,NEW_DRAFT_BRIEF,summarize}=loadTS(join(root,'src/shared/workflow.ts'));
const {applyBriefAutosave,userFieldsToOverwrite,clearAutoFilled}=loadTS(join(root,'src/shared/brief-edit.ts'));
const {stepGuide,withRo}=loadTS(join(root,'src/shared/step-guide.ts'));
test('받침에 맞춘 조사',()=>{assert.equal(withRo('기획 분석'),'기획 분석으로');assert.equal(withRo('스토리보드'),'스토리보드로');assert.equal(withRo('최종 편집안'),'최종 편집안으로');});
const draft0=makeProject('22222222-2222-2222-2222-222222222222',NEW_DRAFT_BRIEF);
test('빈 새 작품은 빈 작품으로 판정',()=>assert.equal(isEmptyDraft(draft0),true));
test('빈 새 작품은 목록에서 작성 중·제목 없는 작품',()=>{const s=summarize(draft0);assert.equal(s.draft,true);assert.equal(s.title,'제목 없는 작품');});
test('제목만 써도 빈 작품 아님(지우지 않음)',()=>assert.equal(isEmptyDraft({...draft0,brief:{...draft0.brief,title:'서시'}}),false));
test('보관한 작품은 지우지 않음',()=>assert.equal(isEmptyDraft({...draft0,archived:true}),false));
let s1=applyBriefAutosave(draft0,{...draft0.brief,title:'서시'},{continueSession:false});
test('원문 없이 제목만 저장하면 버전 없음',()=>{assert.equal(s1.startedSession,false);assert.equal(s1.project.brief.originalMeta,undefined);assert.equal(s1.project.brief.title,'서시');});
let s2=applyBriefAutosave(s1.project,{...s1.project.brief,originalText:'죽는 날까지'},{continueSession:false});
test('원문을 처음 입력하면 v1 확정',()=>{assert.equal(s2.startedSession,true);assert.equal(s2.project.brief.originalMeta.version,1);assert.equal((s2.project.originalHistory||[]).length,0);});
let s3=applyBriefAutosave(s2.project,{...s2.project.brief,originalText:'죽는 날까지 하늘을'},{continueSession:true});
test('같은 편집 중 이어 쓴 원문은 버전이 늘지 않음',()=>{assert.equal(s3.project.brief.originalMeta.version,1);assert.equal(s3.project.brief.originalText,'죽는 날까지 하늘을');assert.equal((s3.project.originalHistory||[]).length,0);});
let s4=applyBriefAutosave(s3.project,{...s3.project.brief,originalText:'죽는 날까지 하늘을 우러러'},{continueSession:false});
test('새 편집에서 고치면 v2 + 이전 원문 이력 보존',()=>{assert.equal(s4.project.brief.originalMeta.version,2);assert.equal(s4.project.originalHistory.length,1);assert.equal(s4.project.originalHistory[0].originalText,'죽는 날까지 하늘을');});
test('원문 외 칸만 바꾸면 확정 정보 유지',()=>{const r=applyBriefAutosave(s4.project,{...s4.project.brief,audience:'adult'},{continueSession:false});assert.equal(r.project.brief.originalMeta.version,2);assert.equal(r.project.brief.audience,'adult');});
test('직접 쓴 칸은 덮어쓰기 확인 대상',()=>assert.deepEqual(userFieldsToOverwrite({...NEW_DRAFT_BRIEF,title:'내 제목',author:''},{title:'진달래꽃',author:'김소월'}),['title']));
test('자동 입력한 칸은 확인 없이 바꿈',()=>assert.deepEqual(userFieldsToOverwrite({...NEW_DRAFT_BRIEF,title:'진달래꽃',autoFilled:{title:'위키문헌'}},{title:'진달래꽃 (원문)'}),[]));
test('고친 칸은 자동 입력 표시 제거',()=>assert.equal(clearAutoFilled({...NEW_DRAFT_BRIEF,autoFilled:{title:'위키문헌'}},'title').autoFilled,undefined));
test('작품 정보 단계: 비면 다음 버튼 잠금 + 빠진 항목 안내',()=>{const g=stepGuide(draft0,'brief');assert.equal(g.ready,false);assert.deepEqual(g.missing,['작품 제목','낭독할 원문']);assert.equal(g.next,'analysis');});
test('작품 정보 단계: 채우면 준비 완료',()=>{const g=stepGuide(s4.project,'brief');assert.equal(g.ready,true);assert.ok(g.hint.startsWith('준비 완료'));});
test('기획 분석 단계: 화풍·연출 고르면 준비 완료',()=>{const g=stepGuide(p1,'analysis');assert.equal(g.ready,true);});
test('더빙 전달 단계: 다음 단계 없음',()=>assert.equal(stepGuide(p4,'handoff').next,null));

console.log(`${checks} tests completed`);

// ── 미디어 파일 이름 규칙 (다른 프로그램에서도 알아보게: 순서 + 종류, 무작위 문자 없음) ──
{
  const {sceneFileLabel,sceneAssetBase,versionedFileName,bgmFileName,splitExt}=loadTS(join(root,'src/shared/asset-naming.ts'));
  test('장면 이미지·동영상 이름은 S04_image / S04_video',()=>{assert.equal(sceneAssetBase('S04',3,'image'),'S04_image');assert.equal(sceneAssetBase('S04',3,'video'),'S04_video');});
  test('장면 ID가 파일 이름에 안전하지 않으면 순서로 S01…',()=>{assert.equal(sceneFileLabel('장면 1',0),'S01');assert.equal(sceneFileLabel('a/b',11),'S12');assert.equal(sceneFileLabel('',4),'S05');assert.equal(sceneFileLabel('S07',0),'S07');});
  test('처음엔 그대로, 다시 만들면 _v2·_v3 (덮어쓰지 않음)',()=>{assert.equal(versionedFileName('S04_image','png',[]),'S04_image.png');assert.equal(versionedFileName('S04_image','png',['S04_image.png']),'S04_image_v2.png');assert.equal(versionedFileName('S04_image','png',['s04_IMAGE.PNG','S04_image_v2.png']),'S04_image_v3.png');});
  test('확장자가 달라도 같은 장면 이름이면 _v2',()=>assert.equal(versionedFileName('S04_image','jpg',['S04_image.png']),'S04_image_v2.jpg'));
  test('배경음악은 BGM_01, BGM_02 …',()=>{assert.equal(bgmFileName('mp3',[]),'BGM_01.mp3');assert.equal(bgmFileName('mp3',['BGM_01.mp3']),'BGM_02.mp3');assert.equal(bgmFileName('wav',['BGM_01.mp3']),'BGM_02.wav');});
  test('이름에 무작위 문자가 없음',()=>assert.match(versionedFileName(sceneAssetBase('S02',1,'image'),'png',[]),/^S02_image\.png$/));
  test('가져온 파일 이름 분리',()=>{assert.deepEqual(splitExt('내 사진.final.PNG'),{base:'내 사진.final',ext:'PNG'});assert.deepEqual(splitExt('noext'),{base:'noext',ext:''});});
  console.log(`asset naming OK`);
}
