/**
 * Named Pipe client for communication with Native Messaging Host.
 * Windows: \\\\.\\pipe\\com.gomo.create
 * Other: /tmp/com.gomo.create.sock
 */
import { createServer, Server, Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { ProtocolMessage } from '../../shared/gemini-protocol';

const PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\com.gomo.create' : '/tmp/com.gomo.create.sock';

type MessageHandler = (msg: ProtocolMessage) => void;

class PipeClient {
  private socket: Socket | null = null;
  private server: Server | null = null;
  private handlers: MessageHandler[] = [];

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
  }

  private disconnectHandlers: Array<() => void> = [];
  private connectHandlers: Array<() => void> = [];
  /** Host 연결이 끊겼을 때 (작업 상태를 '사용자 확인 필요'로 바꾸는 데 사용) */
  onDisconnect(handler: () => void) { this.disconnectHandlers.push(handler); }
  /** Host가 (재)연결되었을 때 */
  onConnect(handler: () => void) { this.connectHandlers.push(handler); }
  private emitDisconnect() { for (const h of this.disconnectHandlers) { try { h(); } catch { /* ignore */ } } }

  private emit(msg: ProtocolMessage) {
    for (const h of this.handlers) {
      try { h(msg); } catch { /* ignore */ }
    }
  }

  async isConnected(): Promise<boolean> {
    return !!(this.socket && !this.socket.destroyed);
  }

  /** Host connects inbound. Start the server and wait briefly for it. */
  async ensureConnected(): Promise<boolean> {
    this.ensureServer();
    if (this.socket && !this.socket.destroyed) return true;
    await new Promise((r) => setTimeout(r, 800));
    return !!(this.socket && !this.socket.destroyed);
  }

  async send(msg: ProtocolMessage): Promise<void> {
    if (!(await this.ensureConnected())) {
      throw new Error('Native Host에 연결할 수 없습니다.');
    }
    this.socket!.write(JSON.stringify(msg) + '\n');
  }

  private ensureServer() {
    if (this.server) return;
    try {
      this.server = createServer((sock) => {
        this.socket = sock;
        this.attach(sock);
        for (const h of this.connectHandlers) { try { h(); } catch { /* ignore */ } }
      });
      this.server.listen(PIPE);
      this.server.on('error', () => { /* already in use or permission */ });
    } catch { /* ignore */ }
  }

  private attach(sock: Socket) {
    let buffer = ''; // 소켓별 버퍼 (Host 재연결 시 이전 소켓의 조각과 섞이지 않도록)
    const decoder = new StringDecoder('utf8'); // 청크 경계의 멀티바이트 문자 보호
    sock.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as ProtocolMessage;
          this.emit(msg);
        } catch { /* ignore */ }
      }
    });
    sock.on('close', () => {
      if (this.socket === sock) { this.socket = null; this.emitDisconnect(); }
    });
    sock.on('error', () => { /* 'close'가 뒤따라 오며 거기서 정리·알림 */ });
  }
}

export const pipeClient = new PipeClient();
