/**
 * Gemini Provider Adapter — isolates all Gemini-specific logic.
 * Connection failures do not affect the rest of the app.
 */
import { createMessage, makeRequestMarker, type MessageType, type ProtocolMessage, type SendState } from '../../shared/gemini-protocol';
import { pipeClient } from './pipe-client';

export type ProviderStatus = {
  connected: boolean;
  hostRegistered: boolean;
  extensionConnected: boolean;
  geminiTabFound: boolean;
  loginState: 'unknown' | 'needed' | 'ready' | 'restricted';
  message: string;
};

export interface PromptJob {
  jobId: string;
  projectId: string;
  stage: string;
  prompt: string;
  sceneId?: string;
  /** 큐 작업의 requestId. 응답 매칭에 그대로 쓰입니다. 없으면 새로 만듭니다(레거시 gemini:submit). */
  requestId?: string;
}

export interface JobResult {
  success: boolean;
  jobId: string;
  errorCode?: string;
  message?: string;
  sendState?: SendState;
  /** 전송 여부 불명 → 큐는 needs_confirmation으로 두고 자동 재전송하지 않음 */
  uncertain?: boolean;
  needsUser?: boolean;
  tab?: { id: number; title: string; url?: string };
  insertMethod?: string;
  evidence?: string;
}

/** content script가 입력·전송 버튼 확인·전송 증거 대기까지 하므로 넉넉히 */
const SUBMIT_TIMEOUT_MS = 60000;

export class GeminiAdapter {
  /** requestId → 기다리는 응답 타입과 처리기. 같은 requestId의 다른 타입(예: RESPONSE_RECEIVED)은 가로채지 않음 */
  private pending = new Map<string, { types: MessageType[] | null; handler: (msg: ProtocolMessage) => void }>();

  constructor() {
    pipeClient.onMessage((msg) => {
      const entry = this.pending.get(msg.requestId);
      if (entry && (!entry.types || entry.types.includes(msg.type))) {
        this.pending.delete(msg.requestId);
        entry.handler(msg);
      }
    });
  }

  async getStatus(): Promise<ProviderStatus> {
    try {
      const connected = await pipeClient.ensureConnected();
      if (!connected) {
        return {
          connected: false,
          hostRegistered: false,
          extensionConnected: false,
          geminiTabFound: false,
          loginState: 'unknown',
          message: 'Native Host에 연결되지 않았습니다. 연결 설정을 확인해 주세요.'
        };
      }
      // Request status from extension
      const req = createMessage('GEMINI_STATUS_REQUEST', {});
      const result = await this.request(req, 5000, ['GEMINI_STATUS_RESULT']);
      if (result?.type === 'GEMINI_STATUS_RESULT') {
        const p = result.payload as { tabs?: unknown[]; loginState?: string };
        return {
          connected: true,
          hostRegistered: true,
          extensionConnected: true,
          geminiTabFound: Array.isArray(p.tabs) && p.tabs.length > 0,
          loginState: (p.loginState as ProviderStatus['loginState']) || 'unknown',
          message: Array.isArray(p.tabs) && p.tabs.length ? 'Gemini 탭이 감지되었습니다.' : 'Gemini 탭을 찾을 수 없습니다.'
        };
      }
      return {
        connected: true,
        hostRegistered: true,
        extensionConnected: false,
        geminiTabFound: false,
        loginState: 'unknown',
        message: '확장 프로그램 응답이 없습니다.'
      };
    } catch (e) {
      return {
        connected: false,
        hostRegistered: false,
        extensionConnected: false,
        geminiTabFound: false,
        loginState: 'unknown',
        message: e instanceof Error ? e.message : '연결 확인 실패'
      };
    }
  }

  async ping(): Promise<{ ok: boolean; roundtripMs: number; message: string }> {
    const start = Date.now();
    const nonce = Math.random().toString(36).slice(2);
    const req = createMessage('PING', { nonce });
    try {
      const res = await this.request(req, 4000, ['PONG']);
      const ms = Date.now() - start;
      if (res?.type === 'PONG') {
        return { ok: true, roundtripMs: ms, message: `왕복 성공 (${ms}ms)` };
      }
      return { ok: false, roundtripMs: ms, message: '응답 형식 오류' };
    } catch (e) {
      return { ok: false, roundtripMs: Date.now() - start, message: e instanceof Error ? e.message : '실패' };
    }
  }

  async submitPrompt(job: PromptJob): Promise<JobResult> {
    const requestId = job.requestId || crypto.randomUUID();
    const req = createMessage('PROMPT_SUBMIT_REQUEST', {
      prompt: job.prompt,
      stage: job.stage,
      jobId: job.jobId,
      projectId: job.projectId,
      marker: makeRequestMarker(requestId)
    }, { requestId, projectId: job.projectId, jobId: job.jobId, sceneId: job.sceneId });
    let sent = false;
    try {
      const res = await this.request(req, SUBMIT_TIMEOUT_MS, ['PROMPT_SUBMIT_RESULT'], () => { sent = true; });
      if (res?.type === 'PROMPT_SUBMIT_RESULT') {
        const p = res.payload as JobResult & { sendState?: SendState };
        if (p.jobId && p.jobId !== job.jobId) {
          return { success: false, uncertain: true, jobId: job.jobId, errorCode: 'MISMATCHED_RESULT', message: '다른 작업의 전송 결과가 도착했습니다. 전송 여부 불명.' };
        }
        const sendState: SendState = p.sendState || (p.success ? 'sent' : 'not_sent');
        return {
          success: sendState === 'sent' && !!p.success, uncertain: sendState === 'uncertain', sendState, jobId: job.jobId,
          errorCode: p.errorCode, message: p.message, needsUser: p.needsUser, tab: p.tab, insertMethod: p.insertMethod, evidence: p.evidence
        };
      }
      if (!sent) return { success: false, sendState: 'not_sent', jobId: job.jobId, errorCode: 'HOST_NOT_CONNECTED', message: 'Native Host에 연결할 수 없어 보내지 않았습니다.', needsUser: true };
      // 요청은 Host로 나갔지만 결과를 못 받음 → Gemini에 들어갔을 수 있으므로 불명 처리
      return { success: false, uncertain: true, sendState: 'uncertain', jobId: job.jobId, errorCode: 'TIMEOUT', message: '전송 결과 응답 시간 초과(전송 여부 불명). 자동 재전송하지 않습니다.' };
    } catch (e) {
      return { success: false, uncertain: sent, sendState: sent ? 'uncertain' : 'not_sent', jobId: job.jobId, errorCode: 'ERROR', message: e instanceof Error ? e.message : '실패' };
    }
  }

  /** 확장 프로그램에 보관된 완료 응답을 다시 요청 (Gemini로 재전송하지 않음). 응답 본문은 RESPONSE_RECEIVED로 따로 도착 */
  async requestResult(job: { jobId: string; requestId: string; projectId: string }): Promise<{ ok: boolean; message: string }> {
    const req = createMessage('RESULT_QUERY_REQUEST', { jobId: job.jobId, requestId: job.requestId, projectId: job.projectId });
    const res = await this.request(req, 5000, ['ERROR']);
    if (res?.type === 'ERROR') return { ok: false, message: (res.payload as { message?: string }).message || '보관된 응답이 없습니다.' };
    return { ok: true, message: '확장 프로그램에 응답을 요청했습니다.' };
  }

  /** 선택자 진단: Gemini 탭에서 아무것도 입력·전송하지 않고 셀렉터 일치 현황만 받음 */
  async probe(): Promise<{ ok: boolean; message?: string; report?: unknown; tab?: { id: number; title: string } }> {
    if (!(await pipeClient.ensureConnected())) return { ok: false, message: 'Native Host에 연결되지 않았습니다.' };
    const req = createMessage('SELECTOR_PROBE_REQUEST', {});
    const res = await this.request(req, 8000, ['SELECTOR_PROBE_RESULT']);
    if (res?.type === 'SELECTOR_PROBE_RESULT') return res.payload as { ok: boolean; message?: string; report?: unknown };
    return { ok: false, message: '확장 프로그램 응답이 없습니다.' };
  }

  private request(msg: ProtocolMessage, timeoutMs: number, types: MessageType[] | null = null, onSent?: () => void): Promise<ProtocolMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.requestId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(msg.requestId, {
        types,
        handler: (res) => {
          clearTimeout(timer);
          resolve(res);
        }
      });
      pipeClient.send(msg).then(() => onSent?.()).catch(() => {
        clearTimeout(timer);
        this.pending.delete(msg.requestId);
        resolve(null);
      });
    });
  }
}

export const geminiAdapter = new GeminiAdapter();
