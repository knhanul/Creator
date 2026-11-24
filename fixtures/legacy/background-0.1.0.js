// 회귀 테스트용 사본: 커밋 b365733의 extension/background.js (확장 0.1.0). 실행 코드 아님.
/**
 * GOMO Gemini Connector — Background Service Worker
 * Handles Native Messaging and routes commands to content scripts.
 */
const HOST_NAME = 'com.gomo.create';
let port = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 3;

function connect() {
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
    // Announce ready
    sendToHost({ type: 'HELLO', payload: { client: 'extension', version: '0.1.0' } });
  } catch (e) {
    console.error('connectNative failed:', e);
  }
}

function sendToHost(msg) {
  if (port) {
    try { port.postMessage(msg); } catch (e) { console.error(e); }
  }
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
  if (msg.type === 'PROMPT_SUBMIT_REQUEST') {
    // Forward to content script of selected tab
    chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
      const tab = tabs.find(t => t.active) || tabs[0];
      if (!tab?.id) {
        sendToHost({
          protocolVersion: 1,
          requestId: msg.requestId,
          type: 'PROMPT_SUBMIT_RESULT',
          timestamp: new Date().toISOString(),
          payload: { success: false, jobId: msg.payload?.jobId, errorCode: 'NO_TAB', message: 'Gemini 탭을 찾을 수 없습니다.' }
        });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'SUBMIT_PROMPT', prompt: msg.payload?.prompt, jobId: msg.payload?.jobId }, (response) => {
        sendToHost({
          protocolVersion: 1,
          requestId: msg.requestId,
          type: 'PROMPT_SUBMIT_RESULT',
          timestamp: new Date().toISOString(),
          payload: response || { success: false, jobId: msg.payload?.jobId, errorCode: 'NO_RESPONSE', message: 'Content script 응답 없음' }
        });
      });
    });
    return;
  }
}

async function queryGeminiTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
      const list = (tabs || []).map(t => ({ id: t.id, title: t.title || '', url: t.url || '', active: !!t.active }));
      resolve({
        tabs: list,
        selectedTabId: list.find(t => t.active)?.id || list[0]?.id || null,
        loginState: list.length ? 'unknown' : 'needed',
        adapterReady: false,
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
