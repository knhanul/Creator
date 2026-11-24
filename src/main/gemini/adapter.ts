/**
 * Gemini Provider Adapter — isolates all Gemini-specific logic.
 * Connection failures do not affect the rest of the app.
 */
import { AUTOMATION_PROTOCOL, classifySubmitResult, createMessage, makeRequestMarker, type MessageType, type PeerVersions, type ProtocolMessage, type SendState, type VersionIssue } from '../../shared/gemini-protocol';
import { pipeClient } from './pipe-client';
import { diagnose, formatDiagnostics, type ConnectionDiagnostics } from '../../shared/gemini-diagnostics';

export type ProviderStatus = {
  connected: boolean;
  hostRegistered: boolean;
  extensionConnected: boolean;
  geminiTabFound: boolean;
  loginState: 'unknown' | 'needed' | 'ready' | 'restricted';
  message: string;
  /** 연결 확인 때 받은 각 구성 요소 버전 (앱 = AUTOMATION_PROTOCOL) */
  versions?: PeerVersions & { app: number };
  /** 이전 버전 구성 요소가 있으면 무엇을 갱신해야 하는지. 있으면 전송하지 않음 */
  versionIssue?: VersionIssue | null;
  /** 연결 확인 때 모은 사실 (Host 연결들, Host·확장·탭 버전, 응답 시간) */
  diagnostics?: ConnectionDiagnostics;
  /** 사용자에게 보여 주고 복사할 진단 텍스트 (본문 없음) */
  diagnosticText?: string;
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
  /** 연결 확인 진단 텍스트 (작업에 남겨 모달의 '진단 정보'에 표시) */
  diagnostics?: string;
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
    const HOST_INFO_TIMEOUT = 1500;
    const STATUS_TIMEOUT = 5000;
    const base = (): ConnectionDiagnostics => {
      const c = pipeClient.connections();
      return { at: new Date().toISOString(), app: { protocol: AUTOMATION_PROTOCOL }, pipe: c.pipe, serverError: c.serverError, activeConnId: c.activeConnId, hosts: c.hosts, hostInfo: null, hostInfoTimeoutMs: HOST_INFO_TIMEOUT, status: null, statusTimeoutMs: STATUS_TIMEOUT };
    };
    try {
      const connected = await pipeClient.ensureConnected();
      if (!connected) {
        const d = base();
        return {
          connected: false, hostRegistered: false, extensionConnected: false, geminiTabFound: false, loginState: 'unknown',
          message: 'Native Host에 연결되지 않았습니다. Chrome이 켜져 있고 확장 프로그램이 사용 중인지 확인해 주세요.',
          versionIssue: null, diagnostics: d, diagnosticText: formatDiagnostics(d, null)
        };
      }
      // 1) Host 버전 (Host가 직접 답함. 이전 Host는 이 요청을 Chrome으로 넘기고 아무도 답하지 않음)
      const hostRes = await this.request(createMessage('HOST_INFO_REQUEST', {}), HOST_INFO_TIMEOUT, ['HOST_INFO_RESULT']);
      const hp = hostRes?.type === 'HOST_INFO_RESULT' ? (hostRes.payload as unknown as Record<string, unknown>) : null;
      // 2) 확장(백그라운드)·Gemini 탭(content script) 버전과 탭 상태
      const t0 = Date.now();
      const result = await this.request(createMessage('GEMINI_STATUS_REQUEST', {}), STATUS_TIMEOUT, ['GEMINI_STATUS_RESULT']);
      const ms = Date.now() - t0;
      const d = base(); // Host 정보는 위 응답으로 갱신된 뒤 다시 읽음
      d.hostInfo = hp ? {
        protocol: typeof hp.protocol === 'number' ? hp.protocol : null, version: String(hp.version ?? ''), pid: hp.pid as number | undefined, startedAt: hp.startedAt as string | undefined,
        caller: hp.caller as string | undefined, logFile: hp.logFile as string | undefined, chromeConnected: hp.chromeConnected as boolean | undefined,
        extension: (hp.extension as { version: string | null; protocol: number | null; at?: string } | null | undefined) ?? null
      } : null;
      if (result?.type === 'GEMINI_STATUS_RESULT') {
        const p = result.payload;
        const env = result as unknown as { extensionProtocol?: number };
        d.status = { ms, extension: p.extension ?? null, content: p.content ?? null, tabs: Array.isArray(p.tabs) ? p.tabs.length : 0, envelopeProtocol: env.extensionProtocol };
      }
      const issue = diagnose(d);
      const text = formatDiagnostics(d, issue);
      const versions = { app: AUTOMATION_PROTOCOL, host: d.hostInfo ? { protocol: Number(d.hostInfo.protocol) || 0, version: d.hostInfo.version } : null, extension: d.status?.extension ? { protocol: Number(d.status.extension.protocol) || 0, version: String(d.status.extension.version || '') } : null, content: (d.status?.content as PeerVersions['content']) ?? null };
      if (d.status) {
        const tabs = d.status.tabs > 0;
        return {
          connected: true, hostRegistered: true, extensionConnected: true, geminiTabFound: tabs,
          loginState: ((result!.payload as { loginState?: string }).loginState as ProviderStatus['loginState']) || 'unknown',
          message: issue ? issue.message : (tabs ? 'Gemini 탭이 감지되었습니다.' : 'Gemini 탭을 찾을 수 없습니다.'),
          versions, versionIssue: issue, diagnostics: d, diagnosticText: text
        };
      }
      return {
        connected: true, hostRegistered: true, extensionConnected: false, geminiTabFound: false, loginState: 'unknown',
        message: issue ? issue.message : '확장 프로그램 응답이 없습니다.',
        versions, versionIssue: issue, diagnostics: d, diagnosticText: text
      };
    } catch (e) {
      const d = base();
      return {
        connected: false, hostRegistered: false, extensionConnected: false, geminiTabFound: false, loginState: 'unknown',
        message: e instanceof Error ? e.message : '연결 확인 실패', diagnostics: d, diagnosticText: formatDiagnostics(d, null)
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
        const kind = classifySubmitResult(res, job);
        if (kind.kind === 'mismatch') {
          return { success: false, uncertain: true, sendState: 'uncertain', needsUser: true, jobId: job.jobId, errorCode: 'MISMATCHED_RESULT', message: '다른 작업의 전송 결과가 도착했습니다. 전송 여부 불명.' };
        }
        if (kind.kind === 'outdated') {
          // 이전 버전 확장이 중계한 결과: "성공"이라도 믿지 않음. 명시적 not_sent가 아니면 사용자 확인(자동 재전송 금지)
          return kind.sendState === 'not_sent'
            ? { success: false, sendState: 'not_sent', needsUser: true, jobId: job.jobId, errorCode: 'EXTENSION_OUTDATED', message: p.message || 'Chrome 확장 프로그램이 이전 버전입니다. 전송하지 않았습니다.' }
            : { success: false, uncertain: true, sendState: 'uncertain', needsUser: true, jobId: job.jobId, errorCode: 'EXTENSION_OUTDATED_UNCERTAIN', message: '이전 버전 확장 프로그램이 응답했습니다. Gemini에 입력·전송되었을 수 있습니다(전송 여부 불명). 자동 재전송하지 않습니다.' };
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
