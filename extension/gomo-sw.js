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
let port = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 3;

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
  const base = { requestId: msg.requestId, jobId: msg.payload?.jobId || msg.jobId, projectId: msg.payload?.projectId || msg.projectId };
  const reply = (payload) => sendToHost(envelope('PROMPT_SUBMIT_RESULT', base, { jobId: base.jobId, ...payload }));
  if (!base.jobId || !base.requestId || !base.projectId) {
    return reply({ success: false, sendState: 'not_sent', errorCode: 'BAD_REQUEST', needsUser: true, message: '앱이 보낸 요청에 jobId/requestId/projectId가 없습니다(앱이 이전 버전일 수 있음). 전송하지 않았습니다.' });
  }
  const tab = await pickGeminiTab();
  if (!tab?.id) return reply({ success: false, sendState: 'not_sent', errorCode: 'NO_TAB', needsUser: true, message: 'Gemini 탭을 찾을 수 없습니다.' });
  // 사용자가 전송 내용을 바로 볼 수 있도록 Gemini 탭을 앞으로 가져옵니다(백그라운드 탭 타이머 제한도 피함).
  try { await chrome.tabs.update(tab.id, { active: true }); } catch { /* ignore */ }
  const r = await deliver(tab.id, {
    type: 'SUBMIT_PROMPT', protocol: AUTOMATION_PROTOCOL, prompt: msg.payload?.prompt, marker: msg.payload?.marker,
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
  const base = { requestId: q.requestId, jobId: q.jobId, projectId: q.projectId };
  const cur = (await chrome.storage.local.get(RESULT_STORE_KEY))[RESULT_STORE_KEY] || [];
  const hit = cur.find(e => e.jobId === q.jobId && e.requestId === q.requestId && e.projectId === q.projectId);
  if (!hit) {
    sendToHost(envelope('ERROR', { ...base, requestId: msg.requestId }, { code: 'RESULT_NOT_FOUND', message: '확장 프로그램에 보관된 응답이 없습니다.', recoverable: true, jobId: q.jobId, queryRequestId: msg.requestId }));
    return;
  }
  sendToHost(envelope('RESPONSE_RECEIVED', base, { jobId: hit.jobId, text: hit.text, codeBlocks: hit.codeBlocks, complete: true, replayed: true, isolation: hit.isolation }));
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

/** content script → 앱: 진행/완료/오류 이벤트 */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'GEMINI_EVENT') return;
  const base = { requestId: msg.requestId, jobId: msg.jobId, projectId: msg.projectId };
  if (msg.kind === 'progress') {
    sendToHost(envelope('JOB_PROGRESS', base, { jobId: msg.jobId, stage: msg.phase, message: '', info: msg.info || {} }));
  } else if (msg.kind === 'complete') {
    const entry = { ...base, text: msg.text, codeBlocks: msg.codeBlocks || [], isolation: msg.isolation, at: Date.now(), tabId: sender?.tab?.id };
    void rememberResult(entry);
    sendToHost(envelope('RESPONSE_RECEIVED', base, { jobId: msg.jobId, text: msg.text, codeBlocks: msg.codeBlocks || [], complete: true, isolation: msg.isolation, completion: msg.completion }));
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

// Downloads monitoring (limited)
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
    sendToHost({
      protocolVersion: 1,
      requestId: `dl-${delta.id}`,
      type: 'DOWNLOAD_EVENT',
      timestamp: new Date().toISOString(),
      payload: { downloadId: delta.id, state: delta.state.current }
    });
  }
});

// 서비스 워커가 시작될 때마다 이 줄이 한 번 실행됨(설치·브라우저 시작 포함). connectNative는 여기 한 곳뿐.
// (0.1.0은 onStartup + 최상위에서 두 번 연결해 브라우저 시작 때 Host가 2개씩 떴음)
connect();
