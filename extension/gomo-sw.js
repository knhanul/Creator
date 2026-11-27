/**
 * GOMO Gemini Connector — Background Service Worker (manifest의 유일한 background 진입점)
 * 파일 이름을 background.js → gomo-sw.js로 바꾼 이유: Chrome이 0.1.0 background.js 서비스 워커를 계속 실행하는 사례가 있어,
 * 새 스크립트 URL로 등록되게 해 이전 코드가 남을 수 없게 함. 버전은 항상 chrome.runtime.getManifest()에서 읽음.
 * Native Messaging ↔ content script 중계. 모든 요청/응답에 jobId·requestId·projectId를 그대로 실어 보냅니다.
 */
const HOST_NAME = 'com.gomo.create';
const PROTOCOL_VERSION = 1;
/** 자동화 프로토콜 수준 — 이 파일 자체에 박혀 있으므로 서비스 워커가 실제로 새 코드로 돌고 있는지 앱이 확인할 수 있음 */
const AUTOMATION_PROTOCOL = 2;
/** 이 서비스 워커 코드 자체의 빌드 표식 (manifest 버전과 별개: Chrome이 서비스 워커를 이전 코드로 돌리는지 구분) */
const BG_BUILD = '0.2.9';
const SW_FILE = 'gomo-sw.js';
const SW_STARTED_AT = new Date().toISOString();
function selfInfo() {
  let version = '';
  try { version = chrome.runtime.getManifest().version; } catch { /* ignore */ }
  return { protocol: AUTOMATION_PROTOCOL, version, build: BG_BUILD, file: SW_FILE, id: chrome.runtime.id || '', swStartedAt: SW_STARTED_AT };
}
// 확장 카드 → 「서비스 워커」 콘솔에서 지금 실행 중인 코드를 바로 확인할 수 있게
console.info(`GOMO background protocol ${AUTOMATION_PROTOCOL} build ${BG_BUILD} file ${SW_FILE} manifest ${selfInfo().version}`);
const CONTENT_FILES = ['gemini-selectors.js', 'gemini-dom.js', 'content.js'];
const RESULT_STORE_KEY = 'gomoRecentResults';
const RESULT_KEEP = 5;
const DEFAULT_DOWNLOAD_WAIT_MS = 20000;
/** 다운로드 버튼을 눌렀는데 이 시간 안에 Chrome 다운로드 항목이 생기지 않으면 Gemini 페이지가 오래된 것으로 보고 새로고침 후 한 번 더 받음 */
const DEFAULT_DOWNLOAD_START_MS = 8000;
/** 새로고침 뒤 Gemini 탭과 content script가 준비될 때까지 기다리는 최대 시간 */
const DEFAULT_RELOAD_READY_MS = 30000;
/** 새로고침 뒤 대화에서 같은 생성 파일을 다시 찾는 최대 시간 */
const DEFAULT_RECOLLECT_MS = 20000;
const msSetting = (name, def) => (typeof globalThis[name] === 'number' ? globalThis[name] : def);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MANUAL_IMPORT_GUIDE = 'Gemini에서 이미지가 생성되었습니다. 다운로드 버튼을 눌러 파일을 받은 뒤, 창작실의 ‘미디어 가져오기’로 추가하고 해당 장면에 연결해 주세요.';
const MANUAL_MEDIA_GUIDE = 'Gemini에서 직접 다운로드한 뒤 미디어 가져오기로 추가해 주세요.';
const MEDIA_STAGES = new Set(['image', 'video', 'music']);
let port = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 3;
/** 현재 진행 중인 미디어(이미지·동영상·음악) 생성 작업 메타데이터 (chrome.downloads 매칭용) */
let activeImageJob = null;
/** 최근 완료/중단된 이미지 다운로드 캐시 (클릭 직후 이벤트가 complete 메시지보다 먼저 도착하는 경합 대비) */
const recentImageDownloads = [];
/** 다운로드 완료를 기다리는 대기자 */
let pendingDownloadWaiter = null;

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    reconnectAttempts = 0;
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      console.error('Native host disconnected:', err?.message);
      port = null;
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        setTimeout(connect, 2000);
      }
    });
    sendToHost({ protocolVersion: PROTOCOL_VERSION, requestId: 'hello-' + Date.now(), type: 'HELLO', timestamp: new Date().toISOString(), extensionProtocol: AUTOMATION_PROTOCOL, payload: { client: 'extension', ...selfInfo() } });
  } catch (e) {
    console.error('connectNative failed:', e);
  }
}

function sendToHost(msg) {
  if (!port) connect();
  if (port) {
    try { port.postMessage(msg); } catch (e) { console.error(e); }
  }
}

function envelope(type, base, payload) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: base.requestId,
    type,
    jobId: base.jobId,
    projectId: base.projectId,
    ...(base.sceneId ? { sceneId: base.sceneId } : {}),
    timestamp: new Date().toISOString(),
    // 모든 회신에 이 서비스 워커의 프로토콜·버전을 실어 보냄(앱 진단용)
    extensionProtocol: AUTOMATION_PROTOCOL,
    extensionVersion: selfInfo().version,
    payload
  };
}

/** Gemini 탭 선택: 마지막으로 포커스된 창의 활성 Gemini 탭 → 가장 최근에 본 Gemini 탭 */
async function pickGeminiTab() {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!tabs.length) return null;
  let focusedWindowId = null;
  try { focusedWindowId = (await chrome.windows.getLastFocused()).id; } catch { /* ignore */ }
  return tabs.find(t => t.active && t.windowId === focusedWindowId)
    || tabs.find(t => t.active)
    || tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

/** content script로 메시지 전송. 수신자가 없으면(확장 재설치 후 열려 있던 탭) 스크립트를 주입한 뒤 한 번만 다시 시도.
 *  "수신자 없음"은 메시지가 전달되지 않았다는 확정 신호이므로 재시도해도 중복 전송이 아닙니다. */
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (!err) return resolve({ delivered: true, response });
      resolve({ delivered: false, error: err.message || String(err) });
    });
  });
}
const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;
async function deliver(tabId, message) {
  let r = await sendToTab(tabId, message);
  if (!r.delivered && NO_RECEIVER.test(r.error)) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
      r = await sendToTab(tabId, message);
      if (r.delivered) r.injected = true;
    } catch (e) {
      r = { delivered: false, error: 'INJECT_FAILED: ' + (e?.message || e), certainNotDelivered: true };
    }
  }
  if (!r.delivered && NO_RECEIVER.test(r.error || '')) r.certainNotDelivered = true;
  return r;
}

async function handleSubmit(msg) {
  const base = {
    requestId: msg.requestId,
    jobId: msg.payload?.jobId || msg.jobId,
    projectId: msg.payload?.projectId || msg.projectId,
    sceneId: msg.payload?.sceneId || msg.sceneId
  };
  const reply = (payload) => sendToHost(envelope('PROMPT_SUBMIT_RESULT', base, { jobId: base.jobId, ...payload }));
  if (!base.jobId || !base.requestId || !base.projectId) {
    return reply({ success: false, sendState: 'not_sent', errorCode: 'BAD_REQUEST', needsUser: true, message: '앱이 보낸 요청에 jobId/requestId/projectId가 없습니다(앱이 이전 버전일 수 있음). 전송하지 않았습니다.' });
  }
  const tab = await pickGeminiTab();
  if (!tab?.id) return reply({ success: false, sendState: 'not_sent', errorCode: 'NO_TAB', needsUser: true, message: 'Gemini 탭을 찾을 수 없습니다.' });
  // 사용자가 전송 내용을 바로 볼 수 있도록 Gemini 탭을 앞으로 가져옵니다(백그라운드 탭 타이머 제한도 피함).
  try { await chrome.tabs.update(tab.id, { active: true }); } catch { /* ignore */ }
  if (MEDIA_STAGES.has(msg.payload?.stage)) {
    activeImageJob = { ...base, stage: msg.payload.stage, submittedAt: Date.now() };
  }
  const r = await deliver(tab.id, {
    type: 'SUBMIT_PROMPT', protocol: AUTOMATION_PROTOCOL, prompt: msg.payload?.prompt, marker: msg.payload?.marker,
    stage: msg.payload?.stage, sceneId: base.sceneId,
    jobId: base.jobId, requestId: base.requestId, projectId: base.projectId,
    ...(msg.payload?.referenceImage ? { referenceImage: msg.payload.referenceImage } : {})
  });
  const tabInfo = { id: tab.id, title: tab.title || '', url: tab.url || '' };
  if (!r.delivered) {
    return reply(r.certainNotDelivered
      ? { success: false, sendState: 'not_sent', errorCode: 'NO_CONTENT_SCRIPT', needsUser: true, message: 'Gemini 탭에 확장 스크립트가 없습니다. Gemini 탭을 새로고침해 주세요.', tab: tabInfo }
      : { success: false, sendState: 'uncertain', errorCode: 'NO_RESPONSE', needsUser: true, message: 'Gemini 탭 응답이 끊겼습니다(' + r.error + '). 전송 여부 불명.', tab: tabInfo });
  }
  reply({ ...(r.response || { success: false, sendState: 'uncertain', errorCode: 'NO_RESPONSE', message: 'Content script 응답 없음' }), tab: tabInfo, injected: !!r.injected });
}

async function rememberResult(entry) {
  try {
    const cur = (await chrome.storage.local.get(RESULT_STORE_KEY))[RESULT_STORE_KEY] || [];
    const next = [entry, ...cur.filter(e => e.jobId !== entry.jobId)].slice(0, RESULT_KEEP);
    await chrome.storage.local.set({ [RESULT_STORE_KEY]: next });
  } catch (e) { console.error('result store failed', e); }
}

async function handleResultQuery(msg) {
  const q = msg.payload || {};
  const base = { requestId: q.requestId, jobId: q.jobId, projectId: q.projectId, sceneId: q.sceneId };
  const cur = (await chrome.storage.local.get(RESULT_STORE_KEY))[RESULT_STORE_KEY] || [];
  const hit = cur.find(e => e.jobId === q.jobId && e.requestId === q.requestId && e.projectId === q.projectId);
  if (!hit) {
    if (MEDIA_STAGES.has(q.stage) && q.marker && base.jobId && base.requestId && base.projectId) {
      // 미디어: 보관된 파일이 없으면 Gemini 대화에서 같은 요청의 결과를 다시 받는다(재전송 없음)
      const tab = await pickGeminiTab();
      if (tab?.id) { void recollectMedia(base, q, tab.id); return; }
      sendToHost(envelope('ERROR', { ...base, requestId: msg.requestId }, { code: 'NO_TAB', message: 'Gemini 탭을 찾을 수 없습니다. 생성했던 Gemini 대화를 열어 주세요.', recoverable: true, jobId: q.jobId, queryRequestId: msg.requestId }));
      return;
    }
    sendToHost(envelope('ERROR', { ...base, requestId: msg.requestId }, { code: 'RESULT_NOT_FOUND', message: '확장 프로그램에 보관된 응답이 없습니다.', recoverable: true, jobId: q.jobId, queryRequestId: msg.requestId }));
    return;
  }
  sendToHost(envelope('RESPONSE_RECEIVED', { ...base, sceneId: hit.sceneId }, {
    jobId: hit.jobId,
    ...(hit.sceneId ? { sceneId: hit.sceneId } : {}),
    text: hit.text,
    codeBlocks: hit.codeBlocks,
    complete: true,
    replayed: true,
    isolation: hit.isolation,
    ...(hit.imageDataUrl ? { imageDataUrl: hit.imageDataUrl } : {}),
    ...(hit.imageUrl ? { imageUrl: hit.imageUrl } : {}),
    ...(hit.mediaDataUrl ? { mediaDataUrl: hit.mediaDataUrl } : {}),
    ...(hit.mediaUrl ? { mediaUrl: hit.mediaUrl } : {}),
    ...(hit.downloadPath ? { downloadPath: hit.downloadPath } : {}),
    ...(hit.mimeType ? { mimeType: hit.mimeType } : {})
  }));
}

/** 「다시 가져오기」(미디어): 표식 질문 뒤 응답에서 파일을 다시 받음 → 안 되면 탭 새로고침 후 한 번 더 */
async function recollectMedia(base, q, tabId) {
  sendToHost(envelope('JOB_PROGRESS', base, { jobId: base.jobId, stage: 'collecting', message: 'Gemini 대화에서 파일을 다시 받는 중', info: { recollect: true } }));
  const startedAt = Date.now();
  let r = await collectFromTab(tabId, { stage: q.stage, marker: q.marker, allowLatest: false });
  let reloaded = false;
  if (!r || !r.ok || r.downloadButtonMissing) {
    reloaded = true;
    r = await reloadAndCollect(tabId, { stage: q.stage, marker: q.marker, allowLatest: false });
  }
  if (!r || !r.ok) {
    sendToHost(envelope('ERROR', base, { code: (r && r.errorCode) || 'MEDIA_NOT_FOUND', message: (r && r.message) || MANUAL_MEDIA_GUIDE, recoverable: true, needsUser: true, jobId: base.jobId }));
    return;
  }
  await finishMediaResult(base, q.stage, { ...r, marker: q.marker }, tabId, { reloaded, recollected: true, minTime: startedAt });
}

async function handleProbe(msg) {
  const base = { requestId: msg.requestId };
  const tab = await pickGeminiTab();
  if (!tab?.id) return sendToHost(envelope('SELECTOR_PROBE_RESULT', base, { ok: false, message: 'Gemini 탭을 찾을 수 없습니다.' }));
  const r = await deliver(tab.id, { type: 'SELECTOR_PROBE' });
  sendToHost(envelope('SELECTOR_PROBE_RESULT', base, r.delivered ? { ok: true, tab: { id: tab.id, title: tab.title || '' }, ...(r.response || {}) } : { ok: false, message: r.error }));
}

function onNativeMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'PING') {
    sendToHost(envelope('PONG', { requestId: msg.requestId || 'pong' }, { nonce: msg.payload?.nonce || '', from: 'extension', extension: selfInfo() }));
    return;
  }
  if (msg.type === 'GEMINI_STATUS_REQUEST') {
    statusWithVersions().catch((e) => ({ tabs: [], selectedTabId: null, loginState: 'unknown', adapterReady: false, experimental: true, extension: selfInfo(), content: { state: 'unknown', error: String(e?.message || e) } }))
      .then(result => sendToHost(envelope('GEMINI_STATUS_RESULT', { requestId: msg.requestId }, result)));
    return;
  }
  if (msg.type === 'PROMPT_SUBMIT_REQUEST') { void handleSubmit(msg); return; }
  if (msg.type === 'RESULT_QUERY_REQUEST') { void handleResultQuery(msg); return; }
  if (msg.type === 'SELECTOR_PROBE_REQUEST') { void handleProbe(msg); return; }
}

/** content script에서 cross-origin으로 dataUrl을 못 읽었을 때 서비스 워커에서 보조 fetch 시도 */
async function tryFetchImageAsDataUrl(imageUrl) {
  if (!imageUrl || typeof fetch !== 'function' || !/^https?:\/\//i.test(imageUrl)) return null;
  try {
    const res = await fetch(imageUrl, { credentials: 'include' });
    if (!res || !res.ok) return null;
    const mime = res.headers.get('content-type') || 'image/png';
    const buf = await res.arrayBuffer();
    if (!buf || !buf.byteLength) return null;
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { dataUrl: `data:${mime};base64,${btoa(bin)}`, mimeType: mime };
  } catch {
    return null;
  }
}

/** 다운로드 항목이 요청된 Gemini 미디어(image/video/music) 다운로드인지 판별 */
function isLikelyImageDownload(item, minTimeMs, stage = 'image') {
  if (!item) return false;
  if (item.startTime) {
    const started = Date.parse(item.startTime);
    if (Number.isFinite(started) && started < minTimeMs - 3000) return false;
  }
  const mime = String(item.mime || '').toLowerCase();
  const filename = String(item.filename || '').toLowerCase();
  const url = String(item.url || item.finalUrl || '').toLowerCase();
  const fromGemini = url.includes('googleusercontent.com') || url.includes('ggpht.com') || url.includes('gemini.google.com') || url.startsWith('blob:');
  if (stage === 'video') {
    if (mime.startsWith('video/')) return true;
    if (/\.(mp4|webm|mov|m4v|mkv)$/i.test(filename)) return true;
    return fromGemini && !mime.startsWith('image/') && !mime.startsWith('audio/');
  }
  if (stage === 'music') {
    if (mime.startsWith('audio/')) return true;
    if (/\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(filename)) return true;
    return fromGemini && !mime.startsWith('image/') && !mime.startsWith('video/');
  }
  if (mime.startsWith('image/')) return true;
  if (/\.(png|jpe?g|webp|gif)$/i.test(filename)) return true;
  if (fromGemini || url.startsWith('data:image/')) return true;
  return false;
}

function queryDownloadItem(downloadId) {
  return new Promise((resolve) => {
    try {
      if (!chrome.downloads || typeof chrome.downloads.search !== 'function') return resolve(null);
      chrome.downloads.search({ id: downloadId }, (items) => {
        if (chrome.runtime.lastError || !Array.isArray(items) || !items.length) return resolve(null);
        resolve(items[0]);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * 미디어 다운로드 완료를 기다린다.
 * startTimeoutMs 안에 다운로드 항목이 생기지 않으면 DOWNLOAD_NOT_STARTED — Gemini가 '다운로드됨'만 띄우고
 * 실제로는 파일을 보내지 않은 경우(오래 열린 페이지). 이때는 탭을 새로고침하면 다시 받아진다.
 */
function waitForImageDownload(jobMeta, timeoutMs, startTimeoutMs = 0) {
  const minTime = typeof jobMeta.minTime === 'number'
    ? jobMeta.minTime
    : (activeImageJob && activeImageJob.jobId === jobMeta.jobId) ? activeImageJob.submittedAt : (Date.now() - 30000);
  // 이미 직전에 완료된 다운로드가 있는지 먼저 확인
  const hitIdx = recentImageDownloads.findIndex(d => d.at >= minTime - 2000 && (!d.consumed));
  if (hitIdx >= 0) {
    const hit = recentImageDownloads[hitIdx];
    hit.consumed = true;
    return Promise.resolve(hit);
  }
  return new Promise((resolve) => {
    let startTimer = null;
    const finish = (res) => {
      clearTimeout(timer);
      if (startTimer) clearTimeout(startTimer);
      if (pendingDownloadWaiter === waiter) pendingDownloadWaiter = null;
      resolve(res);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, errorCode: waiter.started ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_NOT_STARTED', message: MANUAL_IMPORT_GUIDE });
    }, timeoutMs);
    const waiter = { ...jobMeta, minTime, started: false, resolve: finish };
    if (startTimeoutMs > 0 && startTimeoutMs < timeoutMs) {
      startTimer = setTimeout(() => {
        if (!waiter.started) finish({ ok: false, errorCode: 'DOWNLOAD_NOT_STARTED', message: MANUAL_IMPORT_GUIDE });
      }, startTimeoutMs);
    }
    pendingDownloadWaiter = waiter;
  });
}

// 다운로드 항목이 "생겼는지"만 확인 (완료는 onChanged에서). 이것이 없으면 Gemini 페이지가 파일을 보내지 않은 것.
if (chrome.downloads && chrome.downloads.onCreated && typeof chrome.downloads.onCreated.addListener === 'function') {
  chrome.downloads.onCreated.addListener((item) => {
    const w = pendingDownloadWaiter;
    if (!w) return;
    if (isLikelyImageDownload(item, w.minTime, w.stage)) w.started = true;
  });
}

/** 탭 새로고침 뒤 페이지 로드가 끝나고 새 content script가 답할 때까지 기다림 */
async function waitContentReady(tabId, timeoutMs) {
  const start = Date.now();
  let sawLoading = false;
  while (Date.now() - start < timeoutMs) {
    let status = 'complete';
    try { const t = await chrome.tabs.get(tabId); status = (t && t.status) || 'complete'; } catch { return false; }
    if (status !== 'complete') sawLoading = true;
    // 새로고침이 시작되기 전의 이전 페이지가 답하지 않도록, 로딩을 봤거나 1.5초가 지난 뒤에만 확인
    if (status === 'complete' && (sawLoading || Date.now() - start > 1500)) {
      const p = await pingContent(tabId, 1500);
      if (p.state === 'ok') return true;
    }
    await sleep(300);
  }
  return false;
}

/** Gemini 탭을 새로고침(F5와 같음)하고, 대화에 이미 있는 같은 생성 파일을 다시 받는다. 프롬프트는 다시 보내지 않음 */
async function reloadAndCollect(tabId, meta) {
  try { await chrome.tabs.reload(tabId); }
  catch (e) { return { ok: false, errorCode: 'RELOAD_FAILED', message: 'Gemini 탭을 새로고침하지 못했습니다: ' + (e?.message || e) }; }
  if (!(await waitContentReady(tabId, msSetting('__GOMO_RELOAD_READY_MS', DEFAULT_RELOAD_READY_MS)))) {
    return { ok: false, errorCode: 'RELOAD_NOT_READY', message: '새로고침한 Gemini 탭이 제시간에 준비되지 않았습니다.' };
  }
  return collectFromTab(tabId, meta);
}

/** content script에 「이미 생성된 미디어 다시 받기」 요청 */
async function collectFromTab(tabId, meta) {
  const r = await deliver(tabId, {
    type: 'COLLECT_MEDIA', stage: meta.stage, marker: meta.marker, allowLatest: !!meta.allowLatest,
    timeoutMs: msSetting('__GOMO_RECOLLECT_MS', DEFAULT_RECOLLECT_MS)
  });
  if (!r.delivered) return { ok: false, errorCode: 'NO_CONTENT_SCRIPT', message: 'Gemini 탭에 확장 스크립트가 없습니다. Gemini 탭을 새로고침해 주세요.' };
  return r.response || { ok: false, errorCode: 'NO_RESPONSE', message: 'Gemini 탭 응답이 없습니다.' };
}

const hasMediaData = (o) => !!(o.imageDataUrl || o.mediaDataUrl || o.downloadPath);

/**
 * 미디어 작업 결과 마무리(최초 완료 · 「다시 가져오기」 공용):
 *  1) 다운로드 버튼을 눌렀으면 chrome.downloads 완료를 기다림
 *  2) 다운로드가 시작조차 안 되면(Gemini가 '다운로드됨'만 표시) 탭을 새로고침하고 같은 파일을 한 번만 다시 받음 — 재전송 없음
 *  3) 그래도 없으면 이미지 주소 직접 받기를 시도하고, 끝내 없으면 사용자에게 수동 추가 안내
 */
async function finishMediaResult(base, stage, msg, tabId, opts = {}) {
  const guideMsg = stage === 'image' ? MANUAL_IMPORT_GUIDE : MANUAL_MEDIA_GUIDE;
  const out = {
    imageDataUrl: msg.imageDataUrl, mediaDataUrl: msg.mediaDataUrl, mimeType: msg.mimeType, downloadPath: msg.downloadPath,
    imageUrl: msg.imageUrl, mediaUrl: msg.mediaUrl
  };
  let failCode = null;
  let reloaded = !!opts.reloaded;

  if (!hasMediaData(out) && msg.downloadClicked) {
    const waitMs = msSetting('__GOMO_DOWNLOAD_TIMEOUT_MS', DEFAULT_DOWNLOAD_WAIT_MS);
    const startMs = msSetting('__GOMO_DOWNLOAD_START_MS', DEFAULT_DOWNLOAD_START_MS);
    let dl = await waitForImageDownload({ ...base, stage, ...(opts.minTime ? { minTime: opts.minTime } : {}) }, waitMs, startMs);
    if (!(dl && dl.ok) && !reloaded && tabId && (dl?.errorCode === 'DOWNLOAD_NOT_STARTED' || dl?.errorCode === 'DOWNLOAD_FAILED')) {
      reloaded = true;
      sendToHost(envelope('JOB_PROGRESS', base, { jobId: base.jobId, stage: 'collecting', message: 'Gemini 탭을 새로고침하고 다시 받는 중', info: { reloadRetry: true } }));
      const retryStart = Date.now();
      const again = await reloadAndCollect(tabId, { stage, marker: msg.marker, allowLatest: true });
      if (again && again.ok) {
        if (again.imageUrl) out.imageUrl = again.imageUrl;
        if (again.mediaUrl) out.mediaUrl = again.mediaUrl;
        if (again.mimeType) out.mimeType = again.mimeType;
        if (again.imageDataUrl) out.imageDataUrl = again.imageDataUrl;
        if (again.mediaDataUrl) out.mediaDataUrl = again.mediaDataUrl;
        if (!hasMediaData(out) && again.downloadClicked) {
          dl = await waitForImageDownload({ ...base, stage, minTime: retryStart }, waitMs, 0);
        } else if (!hasMediaData(out)) {
          dl = { ok: false, errorCode: again.downloadButtonMissing ? 'DOWNLOAD_BUTTON_NOT_FOUND' : (dl?.errorCode || 'DOWNLOAD_NOT_STARTED') };
        }
      } else {
        dl = { ok: false, errorCode: (again && again.errorCode) || dl?.errorCode || 'DOWNLOAD_NOT_STARTED' };
      }
    }
    if (dl && dl.ok && dl.downloadPath) {
      out.downloadPath = dl.downloadPath;
      if (dl.mimeType) out.mimeType = dl.mimeType;
    } else if (!hasMediaData(out)) {
      failCode = (dl && dl.errorCode) || 'DOWNLOAD_TIMEOUT';
    }
  }

  // 이미지 주소 직접 받기(서비스 워커 fetch) — 권한상 되지 않을 수 있는 마지막 보조 수단
  if (stage === 'image' && !hasMediaData(out) && out.imageUrl) {
    const fetched = await tryFetchImageAsDataUrl(out.imageUrl);
    if (fetched) { out.imageDataUrl = fetched.dataUrl; out.mimeType = fetched.mimeType; failCode = null; }
  }

  if (!hasMediaData(out)) {
    const code = failCode || (msg.downloadButtonMissing ? 'DOWNLOAD_BUTTON_NOT_FOUND' : (stage === 'image' ? 'IMAGE_DATA_MISSING' : 'MEDIA_DATA_MISSING'));
    sendToHost(envelope('ERROR', base, {
      code,
      message: guideMsg,
      recoverable: true,
      needsUser: true,
      jobId: base.jobId,
      partialText: msg.text || '',
      ...(reloaded ? { reloadTried: true } : {})
    }));
    return false;
  }

  const entry = {
    ...base,
    text: msg.text,
    codeBlocks: msg.codeBlocks || [],
    isolation: msg.isolation,
    ...(out.imageDataUrl ? { imageDataUrl: out.imageDataUrl } : {}),
    ...(out.imageUrl ? { imageUrl: out.imageUrl } : {}),
    ...(out.mediaDataUrl ? { mediaDataUrl: out.mediaDataUrl } : {}),
    ...(out.mediaUrl ? { mediaUrl: out.mediaUrl } : {}),
    ...(out.downloadPath ? { downloadPath: out.downloadPath } : {}),
    ...(out.mimeType ? { mimeType: out.mimeType } : {}),
    at: Date.now(),
    tabId
  };
  void rememberResult(entry);
  sendToHost(envelope('RESPONSE_RECEIVED', base, {
    jobId: base.jobId,
    ...(base.sceneId ? { sceneId: base.sceneId } : {}),
    text: msg.text,
    codeBlocks: msg.codeBlocks || [],
    complete: true,
    isolation: msg.isolation,
    completion: msg.completion,
    ...(msg.recollected || opts.recollected ? { recollected: true } : {}),
    ...(reloaded ? { reloaded: true } : {}),
    ...(out.imageDataUrl ? { imageDataUrl: out.imageDataUrl } : {}),
    ...(out.imageUrl ? { imageUrl: out.imageUrl } : {}),
    ...(out.mediaDataUrl ? { mediaDataUrl: out.mediaDataUrl } : {}),
    ...(out.mediaUrl ? { mediaUrl: out.mediaUrl } : {}),
    ...(out.downloadPath ? { downloadPath: out.downloadPath } : {}),
    ...(out.mimeType ? { mimeType: out.mimeType } : {})
  }));
  return true;
}

/** content script → 앱: 진행/완료/오류 이벤트 */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'GEMINI_EVENT') return;
  const base = { requestId: msg.requestId, jobId: msg.jobId, projectId: msg.projectId, ...(msg.sceneId ? { sceneId: msg.sceneId } : {}) };
  if (msg.kind === 'progress') {
    sendToHost(envelope('JOB_PROGRESS', base, { jobId: msg.jobId, stage: msg.phase, message: '', info: msg.info || {} }));
  } else if (msg.kind === 'complete') {
    void (async () => {
      const stage = msg.stage || (msg.sceneId ? 'image' : '');
      if (MEDIA_STAGES.has(stage)) {
        await finishMediaResult(base, stage, msg, sender?.tab?.id);
        return;
      }
      const entry = { ...base, text: msg.text, codeBlocks: msg.codeBlocks || [], isolation: msg.isolation, at: Date.now(), tabId: sender?.tab?.id };
      void rememberResult(entry);
      sendToHost(envelope('RESPONSE_RECEIVED', base, {
        jobId: msg.jobId,
        ...(msg.sceneId ? { sceneId: msg.sceneId } : {}),
        text: msg.text,
        codeBlocks: msg.codeBlocks || [],
        complete: true,
        isolation: msg.isolation,
        completion: msg.completion
      }));
    })();
  } else if (msg.kind === 'error') {
    sendToHost(envelope('ERROR', base, { code: msg.errorCode || 'UNKNOWN', message: msg.message || '', recoverable: true, needsUser: !!msg.needsUser, jobId: msg.jobId, partialText: msg.partialText || '' }));
  }
});

/** 선택될 Gemini 탭의 content script 버전 확인. 주입하지 않음(읽기 전용). */
function pingContent(tabId, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ state: 'unknown', error: 'timeout' }); } }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' }, (response) => {
        if (done) return;
        done = true; clearTimeout(t);
        const err = chrome.runtime.lastError;
        if (err) return resolve(NO_RECEIVER.test(err.message || '') ? { state: 'none' } : { state: 'unknown', error: err.message || String(err) });
        if (!response) return resolve({ state: 'unknown', error: 'empty' });
        // 0.1.x content script는 protocol 없이 { ok, hasInput }만 답함
        if (!(Number(response.protocol) >= AUTOMATION_PROTOCOL)) return resolve({ state: 'outdated', protocol: response.protocol });
        resolve({ state: 'ok', protocol: response.protocol });
      });
    } catch (e) { done = true; clearTimeout(t); resolve({ state: 'unknown', error: String(e?.message || e) }); }
  });
}

async function statusWithVersions() {
  const result = await queryGeminiTabs();
  result.extension = selfInfo();
  try {
    const tab = await pickGeminiTab();
    result.content = tab?.id ? await pingContent(tab.id) : { state: 'none' };
  } catch (e) { result.content = { state: 'unknown', error: String(e?.message || e) }; }
  return result;
}

async function queryGeminiTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
      const list = (tabs || []).map(t => ({ id: t.id, title: t.title || '', url: t.url || '', active: !!t.active }));
      resolve({
        tabs: list,
        selectedTabId: list.find(t => t.active)?.id || list[0]?.id || null,
        loginState: list.length ? 'unknown' : 'needed',
        adapterReady: list.length > 0,
        experimental: true
      });
    });
  });
}

// Downloads monitoring (Phase 5 반자동 이미지 다운로드 수신)
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  void (async () => {
    const item = await queryDownloadItem(delta.id);
    const activeStage = pendingDownloadWaiter?.stage || activeImageJob?.stage || 'image';
    const minTime = pendingDownloadWaiter ? pendingDownloadWaiter.minTime : (activeImageJob ? activeImageJob.submittedAt : Date.now() - 30000);
    const isImg = isLikelyImageDownload(item, minTime, activeStage);
    const filename = item && typeof item.filename === 'string' ? item.filename.trim() : '';
    const mimeType = item && typeof item.mime === 'string' ? item.mime : undefined;

    if (state === 'complete') {
      const outcome = filename
        ? { ok: true, downloadId: delta.id, downloadPath: filename, mimeType, at: Date.now(), consumed: false }
        : { ok: false, downloadId: delta.id, errorCode: 'DOWNLOAD_PATH_MISSING', message: MANUAL_IMPORT_GUIDE, at: Date.now(), consumed: false };
      if (isImg) {
        recentImageDownloads.unshift(outcome);
        if (recentImageDownloads.length > 10) recentImageDownloads.length = 10;
        if (pendingDownloadWaiter) {
          outcome.consumed = true;
          pendingDownloadWaiter.resolve(outcome);
        }
      }
      const targetJob = pendingDownloadWaiter || activeImageJob;
      sendToHost(envelope('DOWNLOAD_EVENT', targetJob || { requestId: `dl-${delta.id}` }, {
        downloadId: delta.id,
        state: 'complete',
        ...(filename ? { downloadPath: filename } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(targetJob?.jobId ? { jobId: targetJob.jobId } : {}),
        ...(targetJob?.sceneId ? { sceneId: targetJob.sceneId } : {})
      }));
    } else if (state === 'interrupted') {
      const failOutcome = { ok: false, downloadId: delta.id, errorCode: 'DOWNLOAD_FAILED', message: MANUAL_IMPORT_GUIDE, at: Date.now(), consumed: false };
      if (isImg) {
        recentImageDownloads.unshift(failOutcome);
        if (recentImageDownloads.length > 10) recentImageDownloads.length = 10;
        if (pendingDownloadWaiter) {
          failOutcome.consumed = true;
          pendingDownloadWaiter.resolve(failOutcome);
        }
      }
      const targetJob = pendingDownloadWaiter || activeImageJob;
      sendToHost(envelope('DOWNLOAD_EVENT', targetJob || { requestId: `dl-${delta.id}` }, {
        downloadId: delta.id,
        state: 'interrupted',
        ...(targetJob?.jobId ? { jobId: targetJob.jobId } : {}),
        ...(targetJob?.sceneId ? { sceneId: targetJob.sceneId } : {})
      }));
    }
  })();
});

// 서비스 워커가 시작될 때마다 이 줄이 한 번 실행됨(설치·브라우저 시작 포함). connectNative는 여기 한 곳뿐.
// (0.1.0은 onStartup + 최상위에서 두 번 연결해 브라우저 시작 때 Host가 2개씩 떴음)
connect();
