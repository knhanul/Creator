// 회귀 테스트용 사본: 커밋 2fda647의 extension/background.js (확장 0.2.0). 실행 코드 아님.
/**
 * GOMO Gemini Connector — Background Service Worker
 * Native Messaging ↔ content script 중계. 모든 요청/응답에 jobId·requestId·projectId를 그대로 실어 보냅니다.
 */
const HOST_NAME = 'com.gomo.create';
const PROTOCOL_VERSION = 1;
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
    sendToHost({ type: 'HELLO', payload: { client: 'extension', version: chrome.runtime.getManifest().version } });
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
  const tab = await pickGeminiTab();
  if (!tab?.id) return reply({ success: false, sendState: 'not_sent', errorCode: 'NO_TAB', needsUser: true, message: 'Gemini 탭을 찾을 수 없습니다.' });
  // 사용자가 전송 내용을 바로 볼 수 있도록 Gemini 탭을 앞으로 가져옵니다(백그라운드 탭 타이머 제한도 피함).
  try { await chrome.tabs.update(tab.id, { active: true }); } catch { /* ignore */ }
  const r = await deliver(tab.id, {
    type: 'SUBMIT_PROMPT', prompt: msg.payload?.prompt, marker: msg.payload?.marker,
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
    sendToHost({
      protocolVersion: 1,
      requestId: msg.requestId || 'pong',
      type: 'PONG',
      timestamp: new Date().toISOString(),
      payload: { nonce: msg.payload?.nonce || '', from: 'extension' }
    });
    return;
  }
  if (msg.type === 'GEMINI_STATUS_REQUEST') {
    queryGeminiTabs().then(result => sendToHost({
      protocolVersion: 1,
      requestId: msg.requestId,
      type: 'GEMINI_STATUS_RESULT',
      timestamp: new Date().toISOString(),
      payload: result
    }));
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

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
connect();
