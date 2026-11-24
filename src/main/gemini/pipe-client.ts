/**
 * Named Pipe server (Electron main) for Native Messaging Hosts.
 * Windows: \\.\pipe\com.gomo.create · Other: /tmp/com.gomo.create.sock
 *
 * Chrome은 확장의 connectNative()마다 Host 프로세스를 하나씩 띄우므로, Chrome 프로필이 여럿이거나 확장 사본이
 * 여럿이면 Host도 여러 개가 동시에 붙을 수 있습니다. 예전에는 "마지막에 붙은 Host"에만 보냈기 때문에,
 * 이전 버전 확장이 띄운 Host가 나중에 붙으면 앱이 그 확장과 이야기했습니다(→ EXTENSION_OUTDATED 오진).
 * 이제 모든 연결을 기억하고, 자동화 프로토콜을 지원하는 확장의 Host를 우선 사용합니다.
 */
import { createServer, Server, Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { ProtocolMessage } from '../../shared/gemini-protocol';
import { pickHostConnection, type HostConnectionInfo } from '../../shared/gemini-diagnostics';

const PIPE = process.env.GOMO_CREATE_PIPE || (process.platform === 'win32' ? '\\\\.\\pipe\\com.gomo.create' : '/tmp/com.gomo.create.sock');

type MessageHandler = (msg: ProtocolMessage) => void;
interface Conn { sock: Socket; info: HostConnectionInfo }

class PipeClient {
  private conns: Conn[] = [];
  private server: Server | null = null;
  private serverError: string | null = null;
  private handlers: MessageHandler[] = [];
  private seq = 0;

  onMessage(handler: MessageHandler) { this.handlers.push(handler); }

  private disconnectHandlers: Array<() => void> = [];
  private connectHandlers: Array<() => void> = [];
  /** 사용할 수 있는 Host 연결이 하나도 없게 되었을 때 (작업 상태를 '사용자 확인 필요'로 바꾸는 데 사용) */
  onDisconnect(handler: () => void) { this.disconnectHandlers.push(handler); }
  /** Host가 (재)연결되었을 때 */
  onConnect(handler: () => void) { this.connectHandlers.push(handler); }

  private emit(msg: ProtocolMessage) {
    for (const h of this.handlers) { try { h(msg); } catch { /* ignore */ } }
  }

  private live(): Conn[] { return this.conns.filter(c => !c.sock.destroyed); }
  /** 요청을 보낼 연결: 자동화 프로토콜을 지원하는 확장의 Host 중 가장 최근 → 없으면 가장 최근 연결 */
  private active(): Conn | null {
    const live = this.live();
    const id = pickHostConnection(live.map(c => c.info));
    return live.find(c => c.info.connId === id) || null;
  }

  async isConnected(): Promise<boolean> { return !!this.active(); }

  /** Host connects inbound. Start the server and wait briefly for it. */
  async ensureConnected(): Promise<boolean> {
    this.ensureServer();
    if (this.active()) return true;
    await new Promise((r) => setTimeout(r, 800));
    return !!this.active();
  }

  async send(msg: ProtocolMessage): Promise<void> {
    if (!(await this.ensureConnected())) throw new Error('Native Host에 연결할 수 없습니다.');
    this.active()!.sock.write(JSON.stringify(msg) + '\n');
  }

  /** 진단용: 현재 붙어 있는 모든 Host 연결과 그중 사용 중인 것 */
  connections(): { pipe: string; serverError: string | null; activeConnId: number | null; hosts: HostConnectionInfo[] } {
    const live = this.live();
    return { pipe: PIPE, serverError: this.serverError, activeConnId: this.active()?.info.connId ?? null, hosts: live.map(c => ({ ...c.info })) };
  }

  private ensureServer() {
    if (this.server) return;
    try {
      this.server = createServer((sock) => {
        const conn: Conn = { sock, info: { connId: ++this.seq, connectedAt: new Date().toISOString() } };
        this.conns.push(conn);
        this.attach(conn);
        for (const h of this.connectHandlers) { try { h(); } catch { /* ignore */ } }
      });
      this.server.on('error', (e: NodeJS.ErrnoException) => {
        // 다른 GOMO 앱 인스턴스가 이미 파이프를 열고 있으면 이 인스턴스에는 Host가 붙지 않음 → 진단에 표시
        this.serverError = e.code === 'EADDRINUSE' ? '다른 GOMO 창작실 창(또는 프로세스)이 이미 연결 통로를 쓰고 있습니다.' : String(e.code || e.message);
      });
      this.server.listen(PIPE);
    } catch (e) { this.serverError = String(e); }
  }

  private attach(conn: Conn) {
    const { sock } = conn;
    let buffer = ''; // 소켓별 버퍼
    const decoder = new StringDecoder('utf8'); // 청크 경계의 멀티바이트 문자 보호
    sock.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { continue; }
        this.track(conn, msg);
        this.emit(msg as unknown as ProtocolMessage);
      }
    });
    sock.on('close', () => {
      this.conns = this.conns.filter(c => c !== conn);
      if (!this.active()) { for (const h of this.disconnectHandlers) { try { h(); } catch { /* ignore */ } } }
    });
    sock.on('error', () => { /* 'close'가 뒤따라 오며 거기서 정리·알림 */ });
  }

  /** Host·확장이 스스로 보고한 정보를 연결별로 기억 (진단·연결 선택용) */
  private track(conn: Conn, msg: Record<string, unknown>) {
    const i = conn.info;
    const now = new Date().toISOString();
    const p = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, unknown>;
    const hostFields = (o: Record<string, unknown>) => {
      i.host = {
        protocol: typeof o.protocol === 'number' ? o.protocol : null, version: String(o.version ?? ''),
        pid: typeof o.pid === 'number' ? o.pid : undefined, startedAt: o.startedAt as string | undefined,
        caller: o.caller as string | undefined, logFile: o.logFile as string | undefined, chromeConnected: o.chromeConnected as boolean | undefined
      };
      const e = o.extension as { version?: string; protocol?: number; at?: string } | null | undefined;
      if (e) i.extensionHello = { version: e.version ?? null, protocol: e.protocol ?? null, at: e.at || now };
    };
    if (msg.type === 'HOST_HELLO') hostFields(msg);
    else if (msg.type === 'HOST_INFO_RESULT') hostFields(p);
    else if (msg.type === 'HELLO') i.extensionHello = { version: (p.version as string) ?? null, protocol: (p.protocol as number) ?? null, at: now };
    else {
      // 0.2.2+ 확장은 모든 회신 봉투에 extensionProtocol을 실음
      if (typeof msg.extensionProtocol === 'number') i.lastReplyProtocol = msg.extensionProtocol;
      i.lastFromHostAt = now;
    }
  }
}

export const pipeClient = new PipeClient();
