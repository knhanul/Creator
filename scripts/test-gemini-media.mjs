/**
 * Phase 5 확장: 장면별 동영상 생성(video) 및 작품 단위 배경음악 생성(music) 반자동 테스트.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { GeminiJobQueue } from '../src/main/gemini/job-queue.mjs';
import { installGeminiSimulator } from '../fixtures/gemini-dom/gemini-simulator.mjs';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const { createAnalysisService } = loadTS(join(root, 'src/main/gemini/analysis-service.ts'));
const { DEFAULT_BRIEF, makeProject, applyAIResponse } = loadTS(join(root, 'src/shared/workflow.ts'));
const { makeRequestMarker } = loadTS(join(root, 'src/shared/gemini-protocol.ts'));
const { bgmFileName, sceneAssetBase, versionedFileName } = loadTS(join(root, 'src/shared/asset-naming.ts'));
const { getProjectBgmPrompt, makeVideoGenerationPrompt, makeMusicGenerationPrompt } = loadTS(join(root, 'src/shared/gemini-analysis.ts'));

const tempRoot = mkdtempSync(join(tmpdir(), 'gomo-phase5-media-'));
let passed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS', label);
  } catch (e) {
    console.error('FAIL', label, e);
    process.exitCode = 1;
  }
}

function makeEnv(tag) {
  const dir = join(tempRoot, tag);
  mkdirSync(dir, { recursive: true });
  const projects = new Map();

  const p1 = makeProject('33333333-3333-3333-3333-333333333333', {
    ...DEFAULT_BRIEF,
    title: '고요한 아침',
    originalText: '고요한 아침 햇살이 창가에 스며든다.',
    aspectRatio: '16:9'
  });
  p1.bgmPrompt = 'Warm acoustic piano and soft cello, calm peaceful instrumental, no vocals';
  p1.scenes = [
    {
      id: 'S01',
      title: '아침 햇살',
      narration: '고요한 아침 햇살이 창가에 스며든다.',
      visual: '따뜻한 창가',
      durationSec: 10,
      kind: 'video',
      imagePrompt: 'Warm morning sunlight through a window, watercolor',
      videoPrompt: 'Slow gentle pan across sunlit curtains swaying softly in morning breeze',
      negativePrompt: 'text, watermark',
      assetId: null,
      status: 'ready'
    },
    {
      id: 'S02',
      title: '영상 프롬프트 없는 장면',
      narration: '고요한 아침',
      visual: '정원',
      durationSec: 8,
      kind: 'image',
      imagePrompt: 'Quiet garden',
      videoPrompt: '',
      negativePrompt: '',
      assetId: null,
      status: 'ready'
    }
  ];
  projects.set(p1.id, p1);

  const submitted = [];
  const adapter = {
    submitted,
    async getStatus() {
      return { connected: true, hostRegistered: true, extensionConnected: true, geminiTabFound: true, loginState: 'ready', message: 'ok' };
    },
    async submitPrompt(job) {
      submitted.push(job);
      return { jobId: job.jobId, success: true, sendState: 'sent', evidence: 'user-query' };
    },
    async requestResult() {
      return { ok: true, message: 'requested' };
    }
  };

  async function readProject(id) {
    const p = projects.get(id);
    if (!p) throw new Error('작품 없음');
    return structuredClone(p);
  }

  async function saveProject(next) {
    const cur = projects.get(next.id);
    const saved = { ...structuredClone(next), revision: (cur?.revision || 0) + 1, updatedAt: new Date().toISOString() };
    projects.set(saved.id, saved);
    return structuredClone(saved);
  }

  async function saveGeneratedMediaAsset(projectId, kind, input) {
    const p = await readProject(projectId);
    let sceneIdx = -1;
    if (kind === 'image' || kind === 'video') {
      if (!input.sceneId) throw new Error('sceneId 필요');
      sceneIdx = p.scenes.findIndex(s => s.id === input.sceneId);
      if (sceneIdx < 0) throw new Error(`장면(${input.sceneId})을 찾을 수 없습니다.`);
    }
    let buffer;
    let ext = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png';
    if (input.mediaDataUrl && /^data:(?:image|video|audio)\//i.test(input.mediaDataUrl)) {
      buffer = Buffer.from(input.mediaDataUrl.split(',')[1], 'base64');
    } else if (input.downloadPath) {
      buffer = readFileSync(input.downloadPath);
      const pe = extname(input.downloadPath).replace(/^\./, '').toLowerCase();
      if (pe) ext = pe;
    } else {
      throw new Error('미디어 데이터 없음');
    }
    const unique = randomUUID();
    // storage.ts와 같은 이름 규칙(S01_video.mp4 · BGM_01.mp3, 겹치면 _v2)
    const taken = p.assets.filter(a => a.kind === kind).map(a => a.relativePath.split('/').pop());
    const name = kind === 'audio' ? bgmFileName(ext, taken) : versionedFileName(sceneAssetBase(p.scenes[sceneIdx].id, sceneIdx, kind), ext, taken);
    const relative = `assets/${kind}/${name}`;
    const projRoot = resolve(join(dir, projectId));
    const full = resolve(projRoot, relative);
    if (!full.startsWith(projRoot + sep)) throw new Error('프로젝트 외부 경로 차단');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buffer);

    const asset = { id: unique, kind, name, relativePath: relative, bytes: buffer.byteLength, importedAt: new Date().toISOString() };
    p.assets.push(asset);
    if (sceneIdx >= 0) {
      p.scenes[sceneIdx] = { ...p.scenes[sceneIdx], assetId: asset.id, status: 'complete' };
    }
    const saved = await saveProject(p);
    return { project: saved, asset };
  }

  return { dir, projects, p1, adapter, readProject, saveProject, saveGeneratedMediaAsset };
}

await test('1. 동영상·배경음악 프롬프트 생성 및 기존 ai.prompt.raw bgmPrompt 폴백 조회', () => {
  const { p1 } = makeEnv('t1');
  const vp = makeVideoGenerationPrompt(p1, 'S01');
  assert.ok(vp.includes('Slow gentle pan across sunlit curtains'));
  assert.ok(vp.includes('16:9'));
  assert.ok(vp.includes('text, watermark'));

  const mp = makeMusicGenerationPrompt(p1);
  assert.ok(mp.includes('Warm acoustic piano'));
  assert.ok(mp.includes('no vocals'));

  // 구버전 프로젝트처럼 project.bgmPrompt는 없고 ai.prompt.raw JSON에만 bgmPrompt가 있어도 조회 가능
  const legacy = structuredClone(p1);
  delete legacy.bgmPrompt;
  legacy.ai.prompt.raw = JSON.stringify({ schema: 'creator.prompts.v1', items: [], bgmPrompt: 'Legacy calm harp melody' });
  assert.equal(getProjectBgmPrompt(legacy), 'Legacy calm harp melody');

  // applyAIResponse('prompt') 호출 시 project.bgmPrompt에 자동 저장 확인
  const pWithPrompt = applyAIResponse(
    legacy,
    'prompt',
    JSON.stringify({
      schema: 'creator.prompts.v1',
      items: [
        { sceneId: 'S01', imagePrompt: 'img1', videoPrompt: 'vid1' },
        { sceneId: 'S02', imagePrompt: 'img2', videoPrompt: '' }
      ],
      bgmPrompt: 'Saved BGM prompt'
    })
  );
  assert.equal(pWithPrompt.bgmPrompt, 'Saved BGM prompt');
});

await test('1-b. 확정 화풍·키워드·장르가 Visual style consistency 줄로 동영상 프롬프트에 포함됨', () => {
  const { p1 } = makeEnv('t1b');
  p1.analysis = {
    schema: 'creator.analysis.v1',
    summary: '잔잔한 아침',
    emotion: '평온',
    keywords: ['sunlight', 'quiet morning'],
    styles: [{ id: 'st1', label: 'Soft watercolor', description: 'gentle pastel washes, paper texture' }],
    directions: [{ id: 'd1', label: 'Slow pans', description: '' }],
    cautions: []
  };
  p1.selection = { styleId: 'st1', directionId: 'd1' };
  const vp = makeVideoGenerationPrompt(p1, 'S01');
  assert.ok(vp.includes('Video prompt: Slow gentle pan across sunlit curtains swaying softly in morning breeze'));
  assert.match(vp, /Visual style consistency:/);
  assert.ok(vp.includes('Soft watercolor'));
  assert.ok(vp.includes('gentle pastel washes, paper texture'));
  assert.ok(vp.includes('sunlight'));
  assert.ok(vp.includes('direction: Slow pans'));
  assert.ok(vp.includes('genre:'));
  assert.ok(vp.includes('16:9'));
});

await test('2. 장면 동영상 생성(video): 다운로드 경로 수신 → assets/video/ 저장 → scene.assetId 자동 연결', async () => {
  const env = makeEnv('t2');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedMediaAsset: env.saveGeneratedMediaAsset
  });

  const started = await service.startVideo(env.p1.id, 'S01');
  assert.equal(started.ok, true);
  assert.equal(started.job.kind, 'video');
  assert.equal(started.job.sceneId, 'S01');
  await service.kick();

  // 중복 시작 차단 확인
  const dup = await service.startVideo(env.p1.id, 'S01');
  assert.equal(dup.ok, true);
  assert.equal(dup.reused, true);
  assert.equal(env.adapter.submitted.length, 1);

  // 빈 videoPrompt 장면(S02)은 사전 차단
  const emptyVid = await service.startVideo(env.p1.id, 'S02');
  assert.equal(emptyVid.ok, false);
  assert.ok(emptyVid.message.includes('videoPrompt'));

  const job = queue.get(started.job.jobId);
  const downloadedMp4 = join(env.dir, 'gemini_veo_s01.mp4');
  writeFileSync(downloadedMp4, Buffer.from('FAKE_MP4_BYTES_FOR_TEST'));

  // 잘못된 sceneId 응답은 무시
  const ignored = await service.handleMessage({
    protocolVersion: 1,
    requestId: job.requestId,
    jobId: job.jobId,
    projectId: env.p1.id,
    sceneId: 'S02',
    type: 'DOWNLOAD_EVENT',
    timestamp: new Date().toISOString(),
    payload: { downloadId: 1, state: 'complete', downloadPath: downloadedMp4, jobId: job.jobId, sceneId: 'S02' }
  });
  assert.equal(ignored, 'ignored');

  // 정상 sceneId('S01') 다운로드 완료 이벤트 수락
  const applied = await service.handleMessage({
    protocolVersion: 1,
    requestId: job.requestId,
    jobId: job.jobId,
    projectId: env.p1.id,
    sceneId: 'S01',
    type: 'DOWNLOAD_EVENT',
    timestamp: new Date().toISOString(),
    payload: { downloadId: 2, state: 'complete', downloadPath: downloadedMp4, mimeType: 'video/mp4', jobId: job.jobId, sceneId: 'S01' }
  });
  assert.equal(applied, 'applied');

  const proj = await env.readProject(env.p1.id);
  assert.equal(proj.assets.length, 1);
  assert.equal(proj.assets[0].kind, 'video');
  assert.ok(proj.assets[0].relativePath.startsWith('assets/video/'));
  assert.match(proj.assets[0].relativePath, /^assets\/video\/S01_video\.(mp4|webm|mov)$/);
  assert.equal(proj.scenes[0].assetId, proj.assets[0].id);
  assert.ok(existsSync(join(env.dir, env.p1.id, proj.assets[0].relativePath)));
});

await test('3. 작품 배경음악 생성(music): assets/audio/ 저장, 장면에 연결하지 않고 BGM 선택 목록에 추가', async () => {
  const env = makeEnv('t3');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedMediaAsset: env.saveGeneratedMediaAsset
  });

  const started = await service.startMusic(env.p1.id);
  assert.equal(started.ok, true);
  assert.equal(started.job.kind, 'music');
  assert.equal(started.job.sceneId, undefined);
  await service.kick();

  // 중복 music 시작 차단
  const dup = await service.startMusic(env.p1.id);
  assert.equal(dup.ok, true);
  assert.equal(dup.reused, true);
  assert.equal(env.adapter.submitted.length, 1);

  const job = queue.get(started.job.jobId);
  const downloadedMp3 = join(env.dir, 'gemini_lyria_bgm.mp3');
  writeFileSync(downloadedMp3, Buffer.from('FAKE_MP3_AUDIO_BYTES'));

  const applied = await service.handleMessage({
    protocolVersion: 1,
    requestId: job.requestId,
    jobId: job.jobId,
    projectId: env.p1.id,
    type: 'RESPONSE_RECEIVED',
    timestamp: new Date().toISOString(),
    payload: {
      jobId: job.jobId,
      text: '배경음악이 생성되었습니다.',
      complete: true,
      downloadPath: downloadedMp3,
      mimeType: 'audio/mpeg'
    }
  });
  assert.equal(applied, 'applied');

  const proj = await env.readProject(env.p1.id);
  assert.equal(proj.assets.length, 1);
  assert.equal(proj.assets[0].kind, 'audio');
  assert.ok(proj.assets[0].relativePath.startsWith('assets/audio/'));
  assert.match(proj.assets[0].name, /^BGM_01\.(mp3|wav|m4a|ogg|flac|aac)$/);
  // 장면 assetId에는 절대 연결하지 않음!
  assert.equal(proj.scenes[0].assetId, null);
  assert.equal(proj.scenes[1].assetId, null);
  assert.ok(existsSync(join(env.dir, env.p1.id, proj.assets[0].relativePath)));
});

await test('4. 동영상·음악 다운로드 실패/중단 시 자동 재전송 없이 needs_user + 수동 안내로 전환', async () => {
  const env = makeEnv('t4');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedMediaAsset: env.saveGeneratedMediaAsset
  });

  const started = await service.startMusic(env.p1.id);
  await service.kick();
  const job = queue.get(started.job.jobId);

  await service.handleMessage({
    protocolVersion: 1,
    requestId: job.requestId,
    jobId: job.jobId,
    projectId: env.p1.id,
    type: 'DOWNLOAD_EVENT',
    timestamp: new Date().toISOString(),
    payload: { downloadId: 9, state: 'interrupted', jobId: job.jobId }
  });
  const after = queue.get(job.jobId);
  assert.equal(after.state, 'needs_confirmation');
  assert.equal(after.errorCode, 'DOWNLOAD_FAILED');
  assert.ok(after.errorMessage.includes('직접 다운로드한 뒤 미디어 가져오기로 추가'));
  await service.kick();
  assert.equal(env.adapter.submitted.length, 1);
});

await test('5. Extension DOM watchVideo & watchMusic: 다운로드 버튼 클릭 및 미생성 시 needs_user 즉시 전환', async () => {
  const html = readFileSync(join(root, 'fixtures/gemini-dom/gemini-like.html'), 'utf8');
  const selectorsSrc = readFileSync(join(root, 'extension/gemini-selectors.js'), 'utf8');
  const domSrc = readFileSync(join(root, 'extension/gemini-dom.js'), 'utf8');
  const FAST = { pollMs: 15, sendEnableWaitMs: 300, sendConfirmTimeoutMs: 400, firstResponseTimeoutMs: 1500, stableMs: 50, noImageIdleMs: 150, maxWaitMs: 2000, progressThrottleMs: 30 };

  // 5-A) 동영상 생성 + 다운로드 버튼 클릭
  const domV = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const winV = domV.window;
  winV.eval(selectorsSrc);
  winV.eval(domSrc);
  installGeminiSimulator(winV, { intro: '', chunkMs: 10, firstDelayMs: 20 });
  const gV = winV.GomoGeminiDom.createGeminiDom({ doc: winV.document, win: winV, timing: FAST });
  let vidDlClicks = 0;
  const subV = await gV.submit({ prompt: 'Generate video', marker: makeRequestMarker('aaaaaaaa-1111-2222-3333-444444444444') });
  winV.setTimeout(() => {
    const responses = winV.document.querySelectorAll('model-response');
    const latest = responses[responses.length - 1];
    const gv = winV.document.createElement('generated-video');
    const video = winV.document.createElement('video');
    video.setAttribute('src', 'https://lh3.googleusercontent.com/fake-veo-video.mp4');
    const btn = winV.document.createElement('button');
    btn.setAttribute('aria-label', '동영상 다운로드');
    btn.addEventListener('click', () => { vidDlClicks++; });
    gv.appendChild(video);
    gv.appendChild(btn);
    latest.appendChild(gv);
  }, 25);
  const outV = await gV.watchVideo(subV.ctx);
  assert.equal(outV.ok, true);
  assert.equal(outV.downloadClicked, true);
  assert.equal(vidDlClicks, 1);

  // 5-B) 배경음악 미생성(텍스트만 응답) → NO_MUSIC_GENERATED
  const domM = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const winM = domM.window;
  winM.eval(selectorsSrc);
  winM.eval(domSrc);
  installGeminiSimulator(winM, { intro: '죄송합니다. 현재 음악 생성을 지원하지 않습니다.', chunkMs: 10, firstDelayMs: 20 });
  const gM = winM.GomoGeminiDom.createGeminiDom({ doc: winM.document, win: winM, timing: FAST });
  const subM = await gM.submit({ prompt: 'Generate music', marker: makeRequestMarker('bbbbbbbb-1111-2222-3333-444444444444') });
  const outM = await gM.watchMusic(subM.ctx);
  assert.equal(outM.ok, false);
  assert.equal(outM.errorCode, 'NO_MUSIC_GENERATED');
  assert.equal(outM.needsUser, true);
});

console.log(`\n${passed} phase5-gemini-media (video+music) checks passed`);
rmSync(tempRoot, { recursive: true, force: true });
if (process.exitCode) process.exit(process.exitCode);
