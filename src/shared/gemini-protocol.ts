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

export interface PromptSubmitRequest extends BaseMessage {
  type: 'PROMPT_SUBMIT_REQUEST';
  payload: { prompt: string; stage: string; jobId: string };
}

export interface PromptSubmitResult extends BaseMessage {
  type: 'PROMPT_SUBMIT_RESULT';
  payload: { success: boolean; jobId: string; errorCode?: string; message?: string };
}

export interface ResponseReceived extends BaseMessage {
  type: 'RESPONSE_RECEIVED';
  payload: { jobId: string; text: string; complete: boolean };
}

export interface JobProgress extends BaseMessage {
  type: 'JOB_PROGRESS';
  payload: { jobId: string; stage: string; message: string };
}

export interface ErrorMessage extends BaseMessage {
  type: 'ERROR';
  payload: { code: string; message: string; recoverable: boolean };
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
  | ErrorMessage;

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
