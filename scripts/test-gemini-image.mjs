/**
 * Phase 5 MVP: 장면별 Gemini 이미지 생성 자동 테스트 (서비스·큐·파일 저장·DOM watchImage).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { GeminiJobQueue } from '../src/main/gemini/job-queue.mjs';
import { installGeminiSimulator } from '../fixtures/gemini-dom/gemini-simulator.mjs';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const { createAnalysisService } = loadTS(join(root, 'src/main/gemini/analysis-service.ts'));
const { mediaEpoch } = loadTS(join(root, 'src/shared/workflow.ts'));
const { DEFAULT_BRIEF, makeProject } = loadTS(join(root, 'src/shared/workflow.ts'));
const { makeRequestMarker } = loadTS(join(root, 'src/shared/gemini-protocol.ts'));
const { sceneAssetBase, versionedFileName } = loadTS(join(root, 'src/shared/asset-naming.ts'));
const { makeImageGenerationPrompt } = loadTS(join(root, 'src/shared/gemini-analysis.ts'));

// 1x1 유효 PNG base64
const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const tempRoot = mkdtempSync(join(tmpdir(), 'gomo-phase5-img-'));
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

function makeTestEnv(tag) {
  const dir = join(tempRoot, tag);
  mkdirSync(dir, { recursive: true });
  const projects = new Map();

  const p1 = makeProject('11111111-1111-1111-1111-111111111111', {
    ...DEFAULT_BRIEF,
    title: '새벽의 정원',
    originalText: '새벽의 작은 정원에 빛이 내려앉았다.\n풀잎 사이로 바람이 지나갔다.',
    aspectRatio: '16:9'
  });
  p1.scenes = [
    {
      id: 'S01',
      title: '새벽 정원',
      narration: '새벽의 작은 정원에 빛이 내려앉았다.',
      visual: '수채화 정원',
      durationSec: 10,
      kind: 'image',
      imagePrompt: 'Warm watercolor garden at dawn, soft golden sunlight on dew drops',
      videoPrompt: '',
      negativePrompt: 'text, watermark, blurry',
      assetId: null,
      status: 'ready'
    },
    {
      id: 'S02',
      title: '바람 불던 풀잎',
      narration: '풀잎 사이로 바람이 지나갔다.',
      visual: '초록 풀잎',
      durationSec: 8,
      kind: 'image',
      imagePrompt: 'Gentle breeze through green grass blades in morning light, watercolor',
      videoPrompt: '',
      negativePrompt: '',
      assetId: null,
      status: 'ready'
    },
    {
      id: 'S03',
      title: '프롬프트 없는 장면',
      narration: '빈 장면',
      visual: '빈 화면',
      durationSec: 6,
      kind: 'image',
      imagePrompt: '   ',
      videoPrompt: '',
      negativePrompt: '',
      assetId: null,
      status: 'draft'
    }
  ];
  projects.set(p1.id, p1);

  const submitted = [];
  let submitBehavior = () => ({ success: true, sendState: 'sent', evidence: 'user-query', insertMethod: 'execCommand' });

  const adapter = {
    submitted,
    setSubmitBehavior(fn) {
      submitBehavior = fn;
    },
    async getStatus() {
      return {
        connected: true,
        hostRegistered: true,
        extensionConnected: true,
        geminiTabFound: true,
        loginState: 'ready',
        message: 'ok'
      };
    },
    async submitPrompt(job) {
      submitted.push(job);
      const r = await submitBehavior(job);
      return { jobId: job.jobId, ...r };
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

  // 실제 storage.ts의 saveGeneratedImageAsset과 동일하게 dataUrl 또는 로컬 downloadPath에서 프로젝트 폴더 아래 assets/image/로 파일 복사 및 연결
  async function saveGeneratedImageAsset(projectId, sceneId, input) {
    const p = await readProject(projectId);
    const sceneIdx = p.scenes.findIndex(s => s.id === sceneId);
    if (sceneIdx < 0) throw new Error(`장면(${sceneId})을 찾을 수 없습니다.`);
    let buffer;
    if (input.imageDataUrl && input.imageDataUrl.startsWith('data:image/')) {
      const match = input.imageDataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
      if (!match) throw new Error('유효한 base64 이미지 데이터가 아닙니다.');
      buffer = Buffer.from(match[2].trim(), 'base64');
    } else if (input.downloadPath) {
      buffer = readFileSync(input.downloadPath);
      if (!buffer.byteLength) throw new Error('다운로드된 파일이 비어 있습니다.');
    } else {
      throw new Error('생성된 이미지 데이터가 없습니다.');
    }
    const unique = randomUUID();
    const taken = p.assets.filter(a => a.kind === 'image').map(a => a.relativePath.split('/').pop());
    const name = versionedFileName(sceneAssetBase(sceneId, sceneIdx, 'image'), 'png', taken);
    const relative = `assets/image/${name}`;
    const projRoot = resolve(join(dir, projectId));
    const full = resolve(projRoot, relative);
    if (!full.startsWith(projRoot + sep)) throw new Error('프로젝트 외부 경로 차단');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buffer);

    const asset = {
      id: unique,
      kind: 'image',
      name,
      relativePath: relative,
      bytes: buffer.byteLength,
      importedAt: new Date().toISOString()
    };
    p.assets.push(asset);
    // storage.ts와 같은 규칙: 요청 뒤 기획(스토리보드·생성 프롬프트)이 다시 만들어졌으면 장면에 연결하지 않음
    const stale = !!input.requestedAt && input.requestedAt < mediaEpoch(p);
    if (!stale) p.scenes[sceneIdx] = { ...p.scenes[sceneIdx], assetId: asset.id, status: 'complete' };
    const saved = await saveProject(p);
    return { project: saved, asset, fullPath: full, linked: !stale };
  }

  return { dir, projects, p1, adapter, readProject, saveProject, saveGeneratedImageAsset };
}

await test('1. 이미지 프롬프트 생성: 장면 imagePrompt·negativePrompt·화면비 포함 + 텍스트/워터마크 금지 지시', async () => {
  const { p1 } = makeTestEnv('t1');
  const prompt = makeImageGenerationPrompt(p1, 'S01');
  assert.ok(prompt.includes('Warm watercolor garden at dawn'));
  assert.ok(prompt.includes('text, watermark, blurry'));
  assert.ok(prompt.includes('16:9'));
  assert.ok(prompt.includes('Do not render any text'));
});

await test('2. 장면 이미지 생성 시작 → 전송 → 이미지 응답 수신 → assets/image/ 파일 저장 → scene.assetId 자동 연결', async () => {
  const env = makeTestEnv('t2');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  let updatedProject = null;
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedImageAsset: env.saveGeneratedImageAsset,
    onProjectUpdated(p) {
      updatedProject = p;
    }
  });

  const started = await service.startImage(env.p1.id, 'S01');
  assert.equal(started.ok, true);
  assert.equal(started.job.kind, 'image');
  assert.equal(started.job.sceneId, 'S01');
  await service.kick();

  assert.equal(env.adapter.submitted.length, 1);
  const sent = env.adapter.submitted[0];
  assert.equal(sent.stage, 'image');
  assert.equal(sent.sceneId, 'S01');

  const jobInQueue = queue.get(started.job.jobId);
  assert.equal(jobInQueue.state, 'waiting');

  const applied = await service.handleMessage({
    protocolVersion: 1,
    requestId: jobInQueue.requestId,
    jobId: jobInQueue.jobId,
    projectId: env.p1.id,
    sceneId: 'S01',
    type: 'RESPONSE_RECEIVED',
    timestamp: new Date().toISOString(),
    payload: {
      jobId: jobInQueue.jobId,
      sceneId: 'S01',
      text: '생성된 이미지입니다.',
      complete: true,
      imageDataUrl: SAMPLE_PNG_DATA_URL,
      mimeType: 'image/png',
      isolation: 'marker'
    }
  });

  assert.equal(applied, 'applied');
  const doneJob = queue.get(jobInQueue.jobId);
  assert.equal(doneJob.state, 'completed');
  assert.equal(doneJob.outcome, 'applied');
  assert.equal(doneJob.phase, 'done');
  assert.ok(doneJob.assetId);
  assert.ok(doneJob.resultRef.startsWith('assets/image/'));

  const savedProj = await env.readProject(env.p1.id);
  assert.equal(savedProj.assets.length, 1);
  const asset = savedProj.assets[0];
  assert.equal(asset.kind, 'image');
  assert.equal(asset.relativePath, 'assets/image/S01_image.png');
  assert.equal(asset.name, 'S01_image.png');
  assert.equal(savedProj.scenes[0].assetId, asset.id);
  assert.equal(savedProj.scenes[0].status, 'complete');
  assert.ok(existsSync(join(env.dir, env.p1.id, asset.relativePath)));
  assert.ok(updatedProject);
});

await test('3. 중복 요청 방지: 같은 장면(S01) 진행 중에는 재전송 안 함, 다른 장면(S02)은 큐 대기 등록 가능', async () => {
  const env = makeTestEnv('t3');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedImageAsset: env.saveGeneratedImageAsset
  });

  const first = await service.startImage(env.p1.id, 'S01');
  await service.kick();
  const dup = await service.startImage(env.p1.id, 'S01');
  assert.equal(dup.ok, true);
  assert.equal(dup.reused, true);
  assert.equal(dup.job.jobId, first.job.jobId);
  assert.equal(env.adapter.submitted.length, 1);

  const otherScene = await service.startImage(env.p1.id, 'S02');
  assert.equal(otherScene.ok, true);
  assert.equal(otherScene.reused, undefined);
  assert.notEqual(otherScene.job.jobId, first.job.jobId);
  // S01이 waiting 상태이므로 S02는 queued 상태로 대기
  assert.equal(queue.get(otherScene.job.jobId).state, 'queued');
});

await test('4. 선행 조건 검사: 존재하지 않는 장면 또는 빈 imagePrompt는 전송 전에 차단', async () => {
  const env = makeTestEnv('t4');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedImageAsset: env.saveGeneratedImageAsset
  });

  const noScene = await service.startImage(env.p1.id, 'S99');
  assert.equal(noScene.ok, false);
  assert.ok(noScene.message.includes('S99'));

  const emptyPrompt = await service.startImage(env.p1.id, 'S03');
  assert.equal(emptyPrompt.ok, false);
  assert.ok(emptyPrompt.message.includes('비어 있습니다'));
  assert.equal(env.adapter.submitted.length, 0);
});

await test('5. ID 대조: sceneId·requestId·projectId가 하나라도 다르면 이미지 응답 무시', async () => {
  const env = makeTestEnv('t5');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedImageAsset: env.saveGeneratedImageAsset
  });

  const started = await service.startImage(env.p1.id, 'S01');
  await service.kick();
  const job = queue.get(started.job.jobId);

  // 다른 sceneId('S02')로 온 응답 → 무시
  const wrongScene = await service.handleMessage({
    protocolVersion: 1,
    requestId: job.requestId,
    jobId: job.jobId,
    projectId: env.p1.id,
    sceneId: 'S02',
    type: 'RESPONSE_RECEIVED',
    timestamp: new Date().toISOString(),
    payload: { jobId: job.jobId, sceneId: 'S02', text: '', complete: true, imageDataUrl: SAMPLE_PNG_DATA_URL }
  });
  assert.equal(wrongScene, 'ignored');

  // sceneId 누락된 응답 → 무시
  const missingScene = await service.handleMessage({
    protocolVersion: 1,
    requestId: job.requestId,
    jobId: job.jobId,
    projectId: env.p1.id,
    type: 'RESPONSE_RECEIVED',
    timestamp: new Date().toISOString(),
    payload: { jobId: job.jobId, text: '', complete: true, imageDataUrl: SAMPLE_PNG_DATA_URL }
  });
  assert.equal(missingScene, 'ignored');

  const projAfter = await env.readProject(env.p1.id);
  assert.equal(projAfter.assets.length, 0);
  assert.equal(projAfter.scenes[0].assetId, null);
});

await test('6. 전송 불명(uncertain) 및 NO_IMAGE_GENERATED 오류 시 자동 재전송 금지 + needs_user 표시', async () => {
  const env = makeTestEnv('t6');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  env.adapter.setSubmitBehavior(() => ({
    success: false,
    uncertain: true,
    sendState: 'uncertain',
    errorCode: 'SEND_UNCERTAIN',
    message: '전송 증거 미확인'
  }));
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedImageAsset: env.saveGeneratedImageAsset
  });

  const started = await service.startImage(env.p1.id, 'S01');
  await service.kick();
  await service.kick();
  assert.equal(env.adapter.submitted.length, 1);
  assert.equal(queue.get(started.job.jobId).state, 'needs_confirmation');

  // 사용자가 기다리기 전환 후 Gemini에서 텍스트만 오고 이미지가 안 만들어진 경우(NO_IMAGE_GENERATED)
  await queue.continueWaiting(started.job.jobId);
  const job = queue.get(started.job.jobId);
  await service.handleMessage({
    protocolVersion: 1,
    requestId: job.requestId,
    jobId: job.jobId,
    projectId: env.p1.id,
    sceneId: 'S01',
    type: 'ERROR',
    timestamp: new Date().toISOString(),
    payload: {
      code: 'NO_IMAGE_GENERATED',
      message: '이미지를 생성할 수 없습니다.',
      recoverable: true,
      needsUser: true,
      partialText: '죄송합니다. 해당 이미지는 생성할 수 없습니다.'
    }
  });
  const afterErr = queue.get(job.jobId);
  assert.equal(afterErr.state, 'needs_confirmation');
  assert.equal(afterErr.errorCode, 'NO_IMAGE_GENERATED');
  assert.ok(afterErr.resultText.includes('죄송합니다'));
  assert.equal(env.adapter.submitted.length, 1);
});

await test('7. Extension DOM watchImage: 신규 응답 블록 안의 생성 이미지만 추출하고 작은 아이콘·텍스트 전용 응답 구분', async () => {
  const html = readFileSync(join(root, 'fixtures/gemini-dom/gemini-like.html'), 'utf8');
  const selectorsSrc = readFileSync(join(root, 'extension/gemini-selectors.js'), 'utf8');
  const domSrc = readFileSync(join(root, 'extension/gemini-dom.js'), 'utf8');
  const FAST = { pollMs: 15, sendEnableWaitMs: 300, sendConfirmTimeoutMs: 400, firstResponseTimeoutMs: 1500, stableMs: 80, maxWaitMs: 2500, progressThrottleMs: 30 };

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const win = dom.window;
  win.eval(selectorsSrc);
  win.eval(domSrc);
  installGeminiSimulator(win, { intro: '이미지를 생성했습니다.', chunkMs: 10, firstDelayMs: 20 });
  const g = win.GomoGeminiDom.createGeminiDom({ doc: win.document, win, timing: FAST });

  const marker = makeRequestMarker('12345678-1234-1234-1234-1234567890ab');
  const sub = await g.submit({ prompt: 'Generate a watercolor garden', marker });
  assert.equal(sub.sendState, 'sent');

  // 응답 블록이 나타나면 작은 아이콘(24x24)과 실제 생성 이미지(512x512)를 삽입
  win.setTimeout(() => {
    const responses = win.document.querySelectorAll('model-response');
    const latest = responses[responses.length - 1];
    const icon = win.document.createElement('img');
    icon.setAttribute('src', SAMPLE_PNG_DATA_URL);
    icon.setAttribute('width', '24');
    icon.setAttribute('height', '24');
    latest.appendChild(icon);

    const wrap = win.document.createElement('generated-image');
    const realImg = win.document.createElement('img');
    realImg.setAttribute('src', SAMPLE_PNG_DATA_URL);
    realImg.setAttribute('width', '512');
    realImg.setAttribute('height', '512');
    wrap.appendChild(realImg);
    latest.appendChild(wrap);
  }, 45);

  const out = await g.watchImage(sub.ctx);
  assert.equal(out.ok, true);
  assert.equal(out.imageDataUrl, SAMPLE_PNG_DATA_URL);
  assert.equal(out.mimeType, 'image/png');
  assert.equal(out.imageSelector, 'generated-image img');

  // 이미지가 없는 텍스트 응답일 때 NO_IMAGE_GENERATED 반환 확인
  const dom2 = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const win2 = dom2.window;
  win2.eval(selectorsSrc);
  win2.eval(domSrc);
  installGeminiSimulator(win2, { intro: '죄송합니다. 텍스트로만 답변합니다.', chunkMs: 10, firstDelayMs: 20 });
  const g2 = win2.GomoGeminiDom.createGeminiDom({ doc: win2.document, win: win2, timing: FAST });
  const sub2 = await g2.submit({ prompt: 'Generate image', marker });
  const out2 = await g2.watchImage(sub2.ctx);
  assert.equal(out2.ok, false);
  assert.equal(out2.errorCode, 'NO_IMAGE_GENERATED');
  assert.equal(out2.needsUser, true);
});

await test('8. 반자동 다운로드 클릭: CORS 이미지(https://lh3.googleusercontent.com/...)일 때 다운로드 버튼을 찾아 자동 클릭', async () => {
  const html = readFileSync(join(root, 'fixtures/gemini-dom/gemini-like.html'), 'utf8');
  const selectorsSrc = readFileSync(join(root, 'extension/gemini-selectors.js'), 'utf8');
  const domSrc = readFileSync(join(root, 'extension/gemini-dom.js'), 'utf8');
  const FAST = { pollMs: 15, sendEnableWaitMs: 300, sendConfirmTimeoutMs: 400, firstResponseTimeoutMs: 1500, stableMs: 60, noImageIdleMs: 180, maxWaitMs: 2500, progressThrottleMs: 30 };

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const win = dom.window;
  win.eval(selectorsSrc);
  win.eval(domSrc);
  // 텍스트 없이 이미지만 렌더링되는 실제 Gemini 응답 시뮬레이션
  installGeminiSimulator(win, { intro: '', chunkMs: 10, firstDelayMs: 20 });
  const g = win.GomoGeminiDom.createGeminiDom({ doc: win.document, win, timing: FAST });

  let dlClicked = 0;
  const marker = makeRequestMarker('abcdef12-1234-1234-1234-1234567890ab');
  const sub = await g.submit({ prompt: 'Generate a watercolor garden', marker });

  win.setTimeout(() => {
    const responses = win.document.querySelectorAll('model-response');
    const latest = responses[responses.length - 1];
    const singleImg = win.document.createElement('single-image');
    singleImg.className = 'generated-image';
    const realImg = win.document.createElement('img');
    realImg.setAttribute('src', 'https://lh3.googleusercontent.com/rd-gg/fake-generated-image');
    realImg.setAttribute('width', '1024');
    realImg.setAttribute('height', '1024');
    singleImg.appendChild(realImg);

    const dlWrap = win.document.createElement('download-generated-image-button');
    const dlBtn = win.document.createElement('button');
    dlBtn.setAttribute('data-test-id', 'image-download-button');
    dlBtn.setAttribute('aria-label', 'Download full size');
    dlBtn.addEventListener('click', () => { dlClicked++; });
    dlWrap.appendChild(dlBtn);
    singleImg.appendChild(dlWrap);
    latest.appendChild(singleImg);
  }, 30);

  const out = await g.watchImage(sub.ctx);
  assert.equal(out.ok, true);
  assert.equal(out.downloadClicked, true);
  assert.equal(dlClicked, 1);
  assert.equal(out.imageMethod, 'download-button');
});

await test('9. chrome.downloads 로컬 파일 경로(downloadPath) 수신 시 프로젝트 assets/image/로 복사 및 장면 자동 연결', async () => {
  const env = makeTestEnv('t9');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  const service = createAnalysisService({
    queue,
    adapter: env.adapter,
    readProject: env.readProject,
    saveProject: env.saveProject,
    saveGeneratedImageAsset: env.saveGeneratedImageAsset
  });

  // 모의 다운로드 폴더에 Chrome이 내려받은 PNG 파일 생성
  const downloadedFile = join(env.dir, 'Gemini_Generated_Image_S01.png');
  const rawPng = Buffer.from(SAMPLE_PNG_DATA_URL.split(',')[1], 'base64');
  writeFileSync(downloadedFile, rawPng);

  const started = await service.startImage(env.p1.id, 'S01');
  await service.kick();
  const job = queue.get(started.job.jobId);

  const r = await service.handleMessage({
    protocolVersion: 1,
    requestId: job.requestId,
    jobId: job.jobId,
    projectId: env.p1.id,
    sceneId: 'S01',
    type: 'DOWNLOAD_EVENT',
    timestamp: new Date().toISOString(),
    payload: {
      downloadId: 77,
      state: 'complete',
      downloadPath: downloadedFile,
      mimeType: 'image/png',
      jobId: job.jobId,
      sceneId: 'S01'
    }
  });
  assert.equal(r, 'applied');
  const doneJob = queue.get(job.jobId);
  assert.equal(doneJob.state, 'completed');
  assert.equal(doneJob.outcome, 'applied');
  assert.equal(doneJob.phase, 'done');

  const proj = await env.readProject(env.p1.id);
  assert.equal(proj.assets.length, 1);
  assert.equal(proj.scenes[0].assetId, proj.assets[0].id);
  assert.ok(existsSync(join(env.dir, env.p1.id, proj.assets[0].relativePath)));
});

await test('10. 다운로드 버튼 미발견 및 셀렉터 불일치(빈 응답) 시 무한 대기하지 않고 needs_user + 수동 안내로 즉시 전환', async () => {
  const html = readFileSync(join(root, 'fixtures/gemini-dom/gemini-like.html'), 'utf8');
  const selectorsSrc = readFileSync(join(root, 'extension/gemini-selectors.js'), 'utf8');
  const domSrc = readFileSync(join(root, 'extension/gemini-dom.js'), 'utf8');
  const FAST = { pollMs: 15, sendEnableWaitMs: 300, sendConfirmTimeoutMs: 400, firstResponseTimeoutMs: 1500, stableMs: 50, noImageIdleMs: 150, maxWaitMs: 2000, progressThrottleMs: 30 };

  // 10-A) 이미지는 있으나 CORS이고 다운로드 버튼이 없는 경우 -> downloadButtonMissing: true
  const domA = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const winA = domA.window;
  winA.eval(selectorsSrc);
  winA.eval(domSrc);
  installGeminiSimulator(winA, { intro: '', chunkMs: 10, firstDelayMs: 20 });
  const gA = winA.GomoGeminiDom.createGeminiDom({ doc: winA.document, win: winA, timing: FAST });
  const markerA = makeRequestMarker('11112222-3333-4444-5555-666677778888');
  const subA = await gA.submit({ prompt: 'Generate image', marker: markerA });
  winA.setTimeout(() => {
    const responses = winA.document.querySelectorAll('model-response');
    const latest = responses[responses.length - 1];
    const wrap = winA.document.createElement('generated-image');
    const img = winA.document.createElement('img');
    img.setAttribute('src', 'https://lh3.googleusercontent.com/rd-gg/no-dl-btn');
    img.setAttribute('width', '512');
    img.setAttribute('height', '512');
    wrap.appendChild(img);
    latest.appendChild(wrap);
  }, 25);
  const outA = await gA.watchImage(subA.ctx);
  assert.equal(outA.ok, true);
  assert.equal(outA.downloadClicked, false);
  assert.equal(outA.downloadButtonMissing, true);

  // 10-B) 텍스트도 없고 이미지 셀렉터도 전혀 매칭되지 않는 빈 응답 블록 -> noImageIdleMs 경과 후 즉시 IMAGE_DETECT_FAILED 반환 (무한 대기 안 함)
  const domB = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://gemini.google.com/app' });
  const winB = domB.window;
  winB.eval(selectorsSrc);
  winB.eval(domSrc);
  installGeminiSimulator(winB, { intro: '', chunkMs: 10, firstDelayMs: 20 });
  const gB = winB.GomoGeminiDom.createGeminiDom({ doc: winB.document, win: winB, timing: FAST });
  const markerB = makeRequestMarker('99998888-7777-6666-5555-444433332222');
  const subB = await gB.submit({ prompt: 'Generate image', marker: markerB });
  const outB = await gB.watchImage(subB.ctx);
  assert.equal(outB.ok, false);
  assert.equal(outB.errorCode, 'IMAGE_DETECT_FAILED');
  assert.equal(outB.needsUser, true);
  assert.ok(outB.message.includes('미디어 가져오기'));
});

await test('회귀: 이미지 생성 중에 생성 프롬프트를 다시 만들면, 늦게 온 결과는 보관함에만 저장하고 장면에 연결하지 않음', async () => {
  const env = makeTestEnv('t-stale');
  const queue = new GeminiJobQueue(join(env.dir, 'jobs.json'));
  await queue.load();
  const service = createAnalysisService({ queue, adapter: env.adapter, readProject: env.readProject, saveProject: env.saveProject, saveGeneratedImageAsset: env.saveGeneratedImageAsset });
  const started = await service.startImage(env.p1.id, 'S01');
  await service.kick();
  const job = queue.get(started.job.jobId);
  // 요청 이후 생성 프롬프트를 다시 만듦 (ai.prompt.updatedAt이 요청보다 늦음)
  const cur = await env.readProject(env.p1.id);
  cur.ai.prompt = { ...cur.ai.prompt, updatedAt: new Date(Date.parse(job.createdAt) + 1000).toISOString() };
  await env.saveProject(cur);
  const r = await service.handleMessage({ protocolVersion: 1, requestId: job.requestId, jobId: job.jobId, projectId: env.p1.id, sceneId: 'S01', type: 'RESPONSE_RECEIVED', timestamp: new Date().toISOString(),
    payload: { jobId: job.jobId, sceneId: 'S01', text: '생성된 이미지입니다.', complete: true, imageDataUrl: SAMPLE_PNG_DATA_URL, mimeType: 'image/png', isolation: 'marker' } });
  const done = queue.get(job.jobId);
  assert.equal(done.outcome, 'stale', String(r));
  assert.equal(done.errorCode, 'PLAN_CHANGED');
  assert.ok(done.assetId, '보관함에는 저장');
  const saved = await env.readProject(env.p1.id);
  assert.equal(saved.assets.length, 1);
  assert.equal(saved.scenes[0].assetId ?? null, null, '장면에는 연결하지 않음');
});

console.log(`\n${passed} phase5-gemini-image checks passed`);
rmSync(tempRoot, { recursive: true, force: true });
if (process.exitCode) process.exit(process.exitCode);
