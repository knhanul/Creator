/**
 * Gemini Provider Adapter — isolates all Gemini-specific logic.
 * Connection failures do not affect the rest of the app.
 */
import { createMessage, type ProtocolMessage } from '../../shared/gemini-protocol';
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
}

export interface JobResult {
  success: boolean;
  jobId: string;
  errorCode?: string;
  message?: string;
}

export class GeminiAdapter {
  private pending = new Map<string, (msg: ProtocolMessage) => void>();

  constructor() {
    pipeClient.onMessage((msg) => {
      const handler = this.pending.get(msg.requestId);
      if (handler) {
        handler(msg);
        this.pending.delete(msg.requestId);
      }
    });
  }

  async getStatus(): Promise<ProviderStatus> {
    try {
      const connected = await pipeClient.isConnected();
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
      const result = await this.request(req, 5000);
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
      const res = await this.request(req, 4000);
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
    const req = createMessage('PROMPT_SUBMIT_REQUEST', {
      prompt: job.prompt,
      stage: job.stage,
      jobId: job.jobId
    }, { projectId: job.projectId, jobId: job.jobId, sceneId: job.sceneId });
    try {
      const res = await this.request(req, 15000);
      if (res?.type === 'PROMPT_SUBMIT_RESULT') {
        const p = res.payload as { success?: boolean; errorCode?: string; message?: string };
        return { success: !!p.success, jobId: job.jobId, errorCode: p.errorCode, message: p.message };
      }
      return { success: false, jobId: job.jobId, errorCode: 'TIMEOUT', message: '응답 시간 초과' };
    } catch (e) {
      return { success: false, jobId: job.jobId, errorCode: 'ERROR', message: e instanceof Error ? e.message : '실패' };
    }
  }

  private request(msg: ProtocolMessage, timeoutMs: number): Promise<ProtocolMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.requestId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(msg.requestId, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      pipeClient.send(msg).catch(() => {
        clearTimeout(timer);
        this.pending.delete(msg.requestId);
        resolve(null);
      });
    });
  }
}

export const geminiAdapter = new GeminiAdapter();
