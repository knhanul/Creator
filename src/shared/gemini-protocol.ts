/**
 * Shared message protocol between Electron, Native Host, and Chrome Extension.
 * Brand-agnostic identifiers (survives GOMO → NUNI).
 */
export const PROTOCOL_VERSION = 1 as const;
export const NATIVE_HOST_NAME = 'com.gomo.create';
/**
 * 자동화 기능 수준(봉투 형식 PROTOCOL_VERSION과 별개). 연결 확인 때 Host·확장(백그라운드)·Gemini 탭(content script)이
 * 각자 자기 값을 보고합니다. 이 값보다 낮거나 보고하지 않는 쪽은 "이전 버전"으로 보고 전송하지 않습니다.
 * 2 = jobId·requestId·projectId를 끝까지 전달·회신하는 첫 버전 (확장 0.2.x)
 */
export const AUTOMATION_PROTOCOL = 2 as const;

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
  | 'HOST_INFO_REQUEST'
  | 'HOST_INFO_RESULT'
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
    /** 0.2.1+ 백그라운드만 보고. 없으면 이전 버전 확장(서비스 워커) */
    extension?: { protocol: number; version: string };
    /** 선택된 Gemini 탭의 content script 상태 (0.2.1+). none = 아직 없음(전송 때 주입), outdated = 이전 버전이 남아 있음 */
    content?: { state: 'ok' | 'outdated' | 'none' | 'unknown'; protocol?: number; error?: string };
  };
}

/** Electron → Native Host: Host가 직접 답함(Chrome으로 넘기지 않음). 이전 Host는 답하지 않음 */
export interface HostInfoRequest extends BaseMessage {
  type: 'HOST_INFO_REQUEST';
  payload: Record<string, never>;
}
export interface HostInfoResult extends BaseMessage {
  type: 'HOST_INFO_RESULT';
  payload: { protocol: number; version: string; script?: string; node?: string; pid?: number; startedAt?: string };
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
  payload: { prompt: string; stage: string; jobId: string; projectId: string; sceneId?: string; marker: string };
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
  payload: {
    jobId: string;
    sceneId?: string;
    text: string;
    complete: boolean;
    codeBlocks?: string[];
    replayed?: boolean;
    isolation?: string;
    /** 이미지 생성 완료 시 확보된 데이터 URL(data:image/...) · 원본 URL · 또는 Chrome 다운로드 로컬 경로 */
    imageDataUrl?: string;
    imageUrl?: string;
    downloadPath?: string;
    mimeType?: string;
  };
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
  | SelectorProbeResult
  | HostInfoRequest
  | HostInfoResult;

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

/** 연결 확인 때 모은 각 구성 요소의 버전 정보. undefined = 보고하지 않음(이전 버전) */
export interface PeerVersions {
  host?: { protocol: number; version: string } | null;
  extension?: { protocol: number; version: string } | null;
  content?: { state: 'ok' | 'outdated' | 'none' | 'unknown'; protocol?: number } | null;
}
export interface VersionIssue { code: 'HOST_NOT_CONNECTED' | 'HOST_OUTDATED' | 'EXTENSION_NO_REPLY' | 'EXTENSION_OUTDATED' | 'CONTENT_OUTDATED'; message: string }

/** 구성 요소 중 이전 버전이 있으면 무엇을 갱신해야 하는지 알려 줌. 없으면 null */
export function checkPeerVersions(v: PeerVersions): VersionIssue | null {
  if (!v.host || !(v.host.protocol >= AUTOMATION_PROTOCOL)) {
    return { code: 'HOST_OUTDATED', message: `Native Host가 이전 버전입니다(보고된 프로토콜: ${v.host?.protocol ?? '없음'}, 필요: ${AUTOMATION_PROTOCOL}).` };
  }
  if (!v.extension || !(v.extension.protocol >= AUTOMATION_PROTOCOL)) {
    return { code: 'EXTENSION_OUTDATED', message: `Chrome 확장 프로그램이 이전 버전으로 실행 중입니다(보고된 프로토콜: ${v.extension?.protocol ?? '없음'}, 필요: ${AUTOMATION_PROTOCOL}).` };
  }
  if (v.content && (v.content.state === 'outdated' || (v.content.state === 'ok' && !(Number(v.content.protocol) >= AUTOMATION_PROTOCOL)))) {
    return { code: 'CONTENT_OUTDATED', message: 'Gemini 탭에 이전 버전의 확장 스크립트가 남아 있습니다.' };
  }
  return null;
}

/**
 * PROMPT_SUBMIT_RESULT 해석. 0.2.x 백그라운드는 봉투에 jobId·projectId를 항상 되돌려 줍니다.
 * 봉투에 둘 중 하나라도 없으면 이전 버전 확장이 중계한 결과 → 성공이라고 말해도 믿지 않고,
 * content script가 명시적으로 not_sent라고 한 경우가 아니면 '전송 여부 불명'(사용자 확인, 자동 재전송 금지).
 */
export function classifySubmitResult(
  res: { jobId?: string; projectId?: string; payload?: unknown },
  job: { jobId: string; projectId: string }
): { kind: 'ok' } | { kind: 'mismatch' } | { kind: 'outdated'; sendState: SendState } {
  const p = (res.payload && typeof res.payload === 'object' ? res.payload : {}) as { jobId?: string; sendState?: SendState };
  if ((res.jobId && res.jobId !== job.jobId) || (res.projectId && res.projectId !== job.projectId) || (p.jobId && p.jobId !== job.jobId)) return { kind: 'mismatch' };
  if (!res.jobId || !res.projectId) return { kind: 'outdated', sendState: p.sendState === 'not_sent' ? 'not_sent' : 'uncertain' };
  return { kind: 'ok' };
}
