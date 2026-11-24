/**
 * Shared message protocol between Electron, Native Host, and Chrome Extension.
 * Brand-agnostic identifiers (survives GOMO → NUNI).
 */
export const PROTOCOL_VERSION = 1 as const;
export const NATIVE_HOST_NAME = 'com.gomo.create';

export type MessageType =
  | 'HELLO'
  | 'PING'
  | 'PONG'
  | 'CONNECTOR_STATUS'
  | 'GEMINI_STATUS_REQUEST'
  | 'GEMINI_STATUS_RESULT'
  | 'PROMPT_SUBMIT_REQUEST'
  | 'PROMPT_SUBMIT_RESULT'
  | 'RESPONSE_RECEIVED'
  | 'JOB_PROGRESS'
  | 'DOWNLOAD_EVENT'
  | 'CANCEL_REQUEST'
  | 'RESULT_QUERY_REQUEST'
  | 'SELECTOR_PROBE_REQUEST'
  | 'SELECTOR_PROBE_RESULT'
  | 'ERROR';

export interface BaseMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  type: MessageType;
  projectId?: string;
  jobId?: string;
  sceneId?: string;
  timestamp: string;
}

export interface HelloMessage extends BaseMessage {
  type: 'HELLO';
  payload: { client: 'electron' | 'extension' | 'host'; version: string };
}

export interface PingMessage extends BaseMessage {
  type: 'PING';
  payload: { nonce: string };
}

export interface PongMessage extends BaseMessage {
  type: 'PONG';
  payload: { nonce: string; from: string };
}

export interface ConnectorStatusMessage extends BaseMessage {
  type: 'CONNECTOR_STATUS';
  payload: {
    extensionInstalled: boolean;
    nativeHostConnected: boolean;
    electronConnected: boolean;
    geminiTabFound: boolean;
    geminiReady: boolean;
    loginState: 'unknown' | 'needed' | 'ready' | 'restricted';
    message?: string;
  };
}

export interface GeminiStatusRequest extends BaseMessage {
  type: 'GEMINI_STATUS_REQUEST';
  payload: Record<string, never>;
}

export interface GeminiStatusResult extends BaseMessage {
  type: 'GEMINI_STATUS_RESULT';
  payload: {
    tabs: Array<{ id: number; title: string; url: string; active: boolean }>;
    selectedTabId: number | null;
    loginState: 'unknown' | 'needed' | 'ready' | 'restricted';
    adapterReady: boolean;
    experimental: boolean;
  };
}

/**
 * 전송 상태
 * - sent: Gemini 화면에서 전송 증거(새 질문 블록/중지 버튼/새 응답 블록)를 확인함
 * - not_sent: 전송 버튼을 누르기 전에 멈춤(확실히 전송 안 됨)
 * - uncertain: 눌렀지만 증거가 없거나 중간에 연결이 끊김 → 자동 재전송 금지
 */
export type SendState = 'sent' | 'not_sent' | 'uncertain';

export interface PromptSubmitRequest extends BaseMessage {
  type: 'PROMPT_SUBMIT_REQUEST';
  /** marker: Gemini 대화에서 이번 요청의 질문 블록을 식별하는 표식(프롬프트 끝에 한 줄로 붙음) */
  payload: { prompt: string; stage: string; jobId: string; projectId: string; marker: string };
}

export interface PromptSubmitResult extends BaseMessage {
  type: 'PROMPT_SUBMIT_RESULT';
  payload: {
    success: boolean; jobId: string; sendState?: SendState; errorCode?: string; message?: string; needsUser?: boolean;
    evidence?: string; insertMethod?: string; sendSelector?: string; tab?: { id: number; title: string; url?: string };
  };
}

export interface ResponseReceived extends BaseMessage {
  type: 'RESPONSE_RECEIVED';
  payload: { jobId: string; text: string; complete: boolean; codeBlocks?: string[]; replayed?: boolean; isolation?: string };
}

export interface JobProgress extends BaseMessage {
  type: 'JOB_PROGRESS';
  payload: { jobId: string; stage: string; message: string; info?: Record<string, unknown> };
}

export interface ErrorMessage extends BaseMessage {
  type: 'ERROR';
  payload: { code: string; message: string; recoverable: boolean; jobId?: string; needsUser?: boolean; partialText?: string; queryRequestId?: string };
}

export interface ResultQueryRequest extends BaseMessage {
  type: 'RESULT_QUERY_REQUEST';
  payload: { jobId: string; requestId: string; projectId: string };
}

export interface SelectorProbeRequest extends BaseMessage {
  type: 'SELECTOR_PROBE_REQUEST';
  payload: Record<string, never>;
}

export interface SelectorProbeResult extends BaseMessage {
  type: 'SELECTOR_PROBE_RESULT';
  payload: { ok: boolean; message?: string; tab?: { id: number; title: string }; report?: unknown; active?: unknown };
}

export type ProtocolMessage =
  | HelloMessage
  | PingMessage
  | PongMessage
  | ConnectorStatusMessage
  | GeminiStatusRequest
  | GeminiStatusResult
  | PromptSubmitRequest
  | PromptSubmitResult
  | ResponseReceived
  | JobProgress
  | ErrorMessage
  | ResultQueryRequest
  | SelectorProbeRequest
  | SelectorProbeResult;

export function createMessage<T extends ProtocolMessage>(
  type: T['type'],
  payload: T['payload'],
  extras: Partial<BaseMessage> = {}
): T {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: extras.requestId || crypto.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    timestamp: new Date().toISOString(),
    ...extras,
    payload,
  } as T;
}

export function isValidMessage(obj: unknown): obj is ProtocolMessage {
  if (!obj || typeof obj !== 'object') return false;
  const m = obj as Record<string, unknown>;
  return m.protocolVersion === PROTOCOL_VERSION && typeof m.type === 'string' && typeof m.requestId === 'string';
}

/** Gemini 대화 안에서 이번 요청을 식별하는 표식. 같은 job의 재전송이라도 requestId가 바뀌므로 표식도 달라집니다. */
export function makeRequestMarker(requestId: string): string {
  return `[GOMO 요청 ${requestId.replace(/-/g, '').slice(0, 12)} · 이 줄은 답변에 쓰지 마세요]`;
}

/** 수신 메시지가 현재 작업(jobId·requestId·projectId)과 모두 일치하는지 */
export function matchesJob(
  msg: { requestId?: string; jobId?: string; projectId?: string; payload?: unknown },
  job: { jobId: string; requestId: string; projectId: string }
): boolean {
  const p = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as { jobId?: string };
  const jobId = msg.jobId || p.jobId;
  return jobId === job.jobId && msg.requestId === job.requestId && msg.projectId === job.projectId;
}
