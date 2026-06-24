import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from './types.js';

/** WebSocket close code the server uses when the viewer session is invalid/expired. */
const WS_UNAUTHORIZED = 4001;

/**
 * WebSocket transport for standalone browser mode.
 * Connects to the Pixel Agents server via WebSocket for bidirectional messaging.
 * Includes automatic reconnection with exponential backoff and message queuing.
 */
export class WebSocketTransport implements MessageTransport {
  private ws: WebSocket | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private pendingMessages: ClientMessage[] = [];

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.disposed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      console.log('[Transport] WebSocket connected');
      // Flush any messages queued while connecting
      for (const msg of this.pendingMessages) {
        this.ws!.send(JSON.stringify(msg));
      }
      this.pendingMessages = [];
    };

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        for (const handler of this.handlers) handler(msg);
      } catch {
        // Malformed JSON, ignore
      }
    };

    this.ws.onclose = (e: CloseEvent) => {
      // 4001 = server rejected the socket because the session is invalid/expired
      // (mirrors httpServer's socket.close(4001)). Don't reconnect — navigate to
      // the login page; the server's auth gate serves it when the session is gone.
      if (e.code === WS_UNAUTHORIZED) {
        this.disposed = true;
        window.location.assign('/');
        return;
      }
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue messages while connecting (flushed in onopen)
      this.pendingMessages.push(message);
    }
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.handlers = [];
    this.pendingMessages = [];
  }

  private scheduleReconnect(): void {
    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    console.log(
      `[Transport] WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
