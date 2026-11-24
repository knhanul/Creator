/**
 * Named Pipe client for communication with Native Messaging Host.
 * Windows: \\\\.\\pipe\\com.gomo.create
 * Other: /tmp/com.gomo.create.sock
 */
import { createConnection, createServer, Server, Socket } from 'node:net';
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

  /** Try to attach to the host pipe. Safe to call repeatedly. */
  async ensureConnected(): Promise<boolean> {
    if (await this.isConnected()) return true;
    try {
      await this.connect();
    } catch { /* host may connect inbound */ }
    return this.isConnected();
  }

  async send(msg: ProtocolMessage): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      await this.connect();
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(msg) + '\n');
    } else {
      throw new Error('Native Host에 연결할 수 없습니다.');
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Prefer connecting as client; also start server so host can connect to us
      this.ensureServer();
      const sock = createConnection(PIPE, () => {
        this.socket = sock;
        this.attach(sock);
        resolve();
      });
      sock.on('error', () => {
        // Host may connect to our server instead
        setTimeout(() => {
          if (this.socket) resolve();
          else reject(new Error('Pipe 연결 실패'));
        }, 300);
      });
    });
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
