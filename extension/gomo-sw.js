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
const BG_BUILD = '0.2.3';
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
    jobId: base.jobId, requestId: base.requestId, projectId: base.projectId
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

function waitForImageDownload(jobMeta, timeoutMs) {
  const minTime = (activeImageJob && activeImageJob.jobId === jobMeta.jobId) ? activeImageJob.submittedAt : (Date.now() - 30000);
  // 이미 직전에 완료된 다운로드가 있는지 먼저 확인
  const hitIdx = recentImageDownloads.findIndex(d => d.at >= minTime - 2000 && (!d.consumed));
  if (hitIdx >= 0) {
    const hit = recentImageDownloads[hitIdx];
    hit.consumed = true;
    return Promise.resolve(hit);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingDownloadWaiter && pendingDownloadWaiter.jobId === jobMeta.jobId) {
        pendingDownloadWaiter = null;
      }
      resolve({ ok: false, errorCode: 'DOWNLOAD_TIMEOUT', message: MANUAL_IMPORT_GUIDE });
    }, timeoutMs);
    pendingDownloadWaiter = {
      ...jobMeta,
      minTime,
      resolve: (res) => {
        clearTimeout(timer);
        pendingDownloadWaiter = null;
        resolve(res);
      }
    };
  });
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
      const isMediaJob = MEDIA_STAGES.has(stage);
      const guideMsg = stage === 'image' ? MANUAL_IMPORT_GUIDE : MANUAL_MEDIA_GUIDE;
      let imageDataUrl = msg.imageDataUrl;
      let mediaDataUrl = msg.mediaDataUrl;
      let mimeType = msg.mimeType;
      let downloadPath = msg.downloadPath;

      // 1) 미디어 작업이고 dataUrl이 아직 없으면: 다운로드 버튼이 클릭된 경우 chrome.downloads 완료를 대기
      if (isMediaJob && !imageDataUrl && !mediaDataUrl && !downloadPath && msg.downloadClicked) {
        const waitMs = typeof globalThis.__GOMO_DOWNLOAD_TIMEOUT_MS === 'number' ? globalThis.__GOMO_DOWNLOAD_TIMEOUT_MS : DEFAULT_DOWNLOAD_WAIT_MS;
        const dl = await waitForImageDownload({ ...base, stage }, waitMs);
        if (dl && dl.ok && dl.downloadPath) {
          downloadPath = dl.downloadPath;
          if (dl.mimeType) mimeType = dl.mimeType;
        } else {
          sendToHost(envelope('ERROR', base, {
            code: (dl && dl.errorCode) || 'DOWNLOAD_TIMEOUT',
            message: guideMsg,
            recoverable: true,
            needsUser: true,
            jobId: msg.jobId,
            partialText: msg.text || ''
          }));
          return;
        }
      }

      // 2) 이미지 작업이고 dataUrl도 downloadPath도 없으면 서비스 워커 fetch 보조 시도
      if (stage === 'image' && !imageDataUrl && !downloadPath && msg.imageUrl) {
        const fetched = await tryFetchImageAsDataUrl(msg.imageUrl);
        if (fetched) { imageDataUrl = fetched.dataUrl; mimeType = fetched.mimeType; }
      }

      // 3) 미디어 작업인데 다운로드 버튼도 못 찾고 파일도 확보하지 못했으면 즉시 needsUser 오류로 전환
      if (isMediaJob && !imageDataUrl && !mediaDataUrl && !downloadPath) {
        sendToHost(envelope('ERROR', base, {
          code: msg.downloadButtonMissing ? 'DOWNLOAD_BUTTON_NOT_FOUND' : (stage === 'image' ? 'IMAGE_DATA_MISSING' : 'MEDIA_DATA_MISSING'),
          message: guideMsg,
          recoverable: true,
          needsUser: true,
          jobId: msg.jobId,
          partialText: msg.text || ''
        }));
        return;
      }

      const entry = {
        ...base,
        text: msg.text,
        codeBlocks: msg.codeBlocks || [],
        isolation: msg.isolation,
        ...(imageDataUrl ? { imageDataUrl } : {}),
        ...(msg.imageUrl ? { imageUrl: msg.imageUrl } : {}),
        ...(mediaDataUrl ? { mediaDataUrl } : {}),
        ...(msg.mediaUrl ? { mediaUrl: msg.mediaUrl } : {}),
        ...(downloadPath ? { downloadPath } : {}),
        ...(mimeType ? { mimeType } : {}),
        at: Date.now(),
        tabId: sender?.tab?.id
      };
      void rememberResult(entry);
      sendToHost(envelope('RESPONSE_RECEIVED', base, {
        jobId: msg.jobId,
        ...(msg.sceneId ? { sceneId: msg.sceneId } : {}),
        text: msg.text,
        codeBlocks: msg.codeBlocks || [],
        complete: true,
        isolation: msg.isolation,
        completion: msg.completion,
        ...(imageDataUrl ? { imageDataUrl } : {}),
        ...(msg.imageUrl ? { imageUrl: msg.imageUrl } : {}),
        ...(mediaDataUrl ? { mediaDataUrl } : {}),
        ...(msg.mediaUrl ? { mediaUrl: msg.mediaUrl } : {}),
        ...(downloadPath ? { downloadPath } : {}),
        ...(mimeType ? { mimeType } : {})
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
