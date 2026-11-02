import * as Y from 'yjs';

export interface PresenceMember { peerId?: string; userId: string | null; name?: string | null; documentId: string | null; selection: { anchor: number; head: number; rel?: { anchor: unknown; head: unknown } } | null }
export type ProjectEventMessage = { type: 'diagram-changed'; packageId: string; version: number } | { type: 'comments-changed' } | { type: 'package-renamed'; from: string; to: string } | { type: 'history-changed'; revisionId?: string } | { type: 'documents-changed' };
export interface ClientOptions {
  url: string; projectId: string;
  /** Si se omite, la conexión es solo un canal del proyecto: presencia y eventos, sin sincronizar texto. */
  documentId?: string;
  sessionToken?: string; linkToken?: string; editable: boolean;
  onPresence?: (members: PresenceMember[]) => void; onStatus?: (status: 'connecting' | 'connected' | 'offline') => void;
  onProjectChanged?: (documentId: string) => void;
  onEvent?: (event: ProjectEventMessage) => void;
  onError?: (message: string) => void; socketFactory?: (url: string) => WebSocket; reconnectDelayMs?: number;
}
const toBase64 = (bytes: Uint8Array) => { let result = ''; for (const byte of bytes) result += String.fromCharCode(byte); return btoa(result); };
const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

/**
 * Keeps offline Yjs edits in the document and replays them after the next server state.
 * Tras reconectar solo se envía lo que el servidor aún no tiene (Yjs es idempotente), así que no hay duplicados.
 */
export class CollaborationClient {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private ready = false;
  private attempts = 0;
  /** Identificador de esta conexión, asignado por el servidor; permite excluir el cursor propio. */
  peerId?: string;
  private remote = Symbol('remote');
  private update = (bytes: Uint8Array, origin: unknown) => {
    if (origin !== this.remote && this.options.editable && this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'update', update: toBase64(bytes) }));
  };
  constructor(readonly document: Y.Doc, private options: ClientOptions) { document.on('update', this.update); }
  connect(): void {
    if (this.closed || this.socket) return;
    this.options.onStatus?.('connecting');
    const socket = this.socket = this.options.socketFactory?.(this.options.url) ?? new WebSocket(this.options.url);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'open', projectId: this.options.projectId, documentId: this.options.documentId, sessionToken: this.options.sessionToken, linkToken: this.options.linkToken }));
    const markReady = () => { this.ready = true; this.attempts = 0; this.options.onStatus?.('connected'); };
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'state') {
        Y.applyUpdate(this.document, fromBase64(message.update), this.remote);
        if (!this.ready) {
          // Se reenvía el estado local completo: incluye las ediciones hechas sin conexión.
          if (this.options.editable) socket.send(JSON.stringify({ type: 'update', update: toBase64(Y.encodeStateAsUpdate(this.document)) }));
          markReady();
        }
      } else if (message.type === 'ready') { if (!this.ready) markReady(); }
      else if (message.type === 'hello') this.peerId = message.peerId;
      else if (message.type === 'presence') this.options.onPresence?.(message.members);
      else if (message.type === 'project-changed') this.options.onProjectChanged?.(message.documentId);
      else if (message.type === 'event') this.options.onEvent?.(message.event);
      else if (message.type === 'error') { this.options.onError?.(message.message); if (!this.ready) socket.close(); }
    };
    socket.onclose = () => {
      this.ready = false; this.socket = undefined; this.options.onStatus?.('offline');
      // Espera creciente (con tope) para no saturar al servidor durante una caída.
      if (!this.closed) this.timer = setTimeout(() => this.connect(), Math.min(15_000, (this.options.reconnectDelayMs ?? 1500) * 2 ** Math.min(this.attempts++, 4)));
    };
    socket.onerror = () => socket.close();
  }
  /** `rel` son posiciones relativas de Yjs (JSON); con ellas los demás ven el cursor en el carácter correcto aunque el texto cambie. */
  selection(anchor: number, head: number, rel?: { anchor: unknown; head: unknown }): void { if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'presence', anchor, head, ...(rel ? { rel } : {}) })); }
  destroy(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.socket?.close(); this.document.off('update', this.update); }
}
