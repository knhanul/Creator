/**
 * Named Pipe client for communication with Native Messaging Host.
 * Windows: \\\\.\\pipe\\com.gomo.create
 * Other: /tmp/com.gomo.create.sock
 */
import { createServer, Server, Socket } from 'node:net';
import type { ProtocolMessage } from '../../shared/gemini-protocol';

const PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\com.gomo.create' : '/tmp/com.gomo.create.sock';

type MessageHandler = (msg: ProtocolMessage) => void;

class PipeClient {
  private socket: Socket | null = null;
  private server: Server | null = null;
  private handlers: MessageHandler[] = [];
  private buffer = '';

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
  }

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
      });
      this.server.listen(PIPE);
      this.server.on('error', () => { /* already in use or permission */ });
    } catch { /* ignore */ }
  }

  private attach(sock: Socket) {
    sock.on('data', (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as ProtocolMessage;
          this.emit(msg);
        } catch { /* ignore */ }
      }
    });
    sock.on('close', () => {
      if (this.socket === sock) this.socket = null;
    });
    sock.on('error', () => {
      if (this.socket === sock) this.socket = null;
    });
  }
}

export const pipeClient = new PipeClient();
