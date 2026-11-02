import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { AccessStore } from './access';
import { SharedDocuments } from './documents';
import { SessionStore } from './sessions';
import { RateLimiter } from './ratelimit';
import type { ProjectEvents } from './events';

interface SocketData { peerId?: string; projectId?: string; documentId?: string; sessionToken?: string; linkToken?: string; selection?: { anchor: number; head: number; rel?: { anchor: unknown; head: unknown } }; limiter?: RateLimiter; violations?: number }
interface InitMessage { type: 'open'; projectId: string; documentId?: string; sessionToken?: string; linkToken?: string }
const error = (ws: ServerWebSocket<SocketData>, message: string) => ws.send(JSON.stringify({ type: 'error', message }));

export interface SocketOptions {
  access: AccessStore; documents: SharedDocuments; sessions: SessionStore; origins: string[]; port?: number; hostname?: string;
  /** Bus de eventos del proyecto: los cambios de diagramas, comentarios, historial y accesos se reenvían a los participantes. */
  events?: ProjectEvents;
  /** Máximo de conexiones simultáneas (por defecto 2000). */
  maxPeers?: number;
  /** Mensajes por segundo permitidos por conexión (por defecto 60, con ráfaga de 200). */
  messagesPerSecond?: number;
  /** Tiempo máximo para enviar `open` tras conectar (por defecto 10 s). */
  openTimeoutMs?: number;
}

/**
 * WebSocket endpoint is deliberately opt-in; deployment must provide a trusted origin list and TLS.
 * Un cliente puede abrir un documento (sincronización CRDT) o solo el canal del proyecto (sin `documentId`)
 * para recibir presencia y eventos. La autorización se revalida en cada operación.
 */
export function createCollaborationSocket(options: Omit<SocketOptions, 'port' | 'hostname'>): { websocket: WebSocketHandler<SocketData>; handleUpgrade(request: Request, server: Server<SocketData>): Response | undefined } {
  const peers = new Set<ServerWebSocket<SocketData>>();
  const maxPeers = options.maxPeers ?? 2000;
  const principal = async (data: SocketData) => ({ userId: await options.sessions.resolve(data.sessionToken), linkToken: data.linkToken });
  const canRead = async (peer: ServerWebSocket<SocketData>) => { const p = await principal(peer.data); return !!peer.data.projectId && !!p.userId && options.access.can(peer.data.projectId, p.userId, 'read', p.linkToken); };
  const projectPeers = (projectId: string) => [...peers].filter(p => p.data.projectId === projectId);
  /** Cierra a quien ya no tiene acceso; devuelve los pares autorizados. */
  const authorized = async (projectId: string) => {
    const checks = await Promise.all(projectPeers(projectId).map(async peer => ({ peer, allowed: await canRead(peer) })));
    return checks.flatMap(({ peer, allowed }) => { if (allowed) return [peer]; peer.close(1008, 'Acceso revocado'); return []; });
  };
  const broadcastPresence = async (projectId: string) => {
    const live = await authorized(projectId);
    const identities = await Promise.all(live.map(async peer => ({ peer, userId: (await principal(peer.data)).userId ?? null })));
    const names = await options.sessions.usernames(identities.map(item => item.userId ?? ''));
    const members = identities.map(({ peer, userId }) => ({ peerId: peer.data.peerId, userId, name: userId ? names.get(userId) ?? null : null, documentId: peer.data.documentId ?? null, selection: peer.data.selection ?? null }));
    const payload = JSON.stringify({ type: 'presence', members });
    for (const peer of live) peer.send(payload);
  };

  options.events?.on((projectId, event) => {
    if (event.type === 'doc-edited') return;
    if (event.type === 'access-changed') { void broadcastPresence(projectId); return; }
    void (async () => {
      const live = await authorized(projectId);
      if (event.type === 'doc-updated') {
        const state = JSON.stringify({ type: 'state', update: Buffer.from(event.state).toString('base64') });
        for (const peer of live) { if (peer.data.documentId === event.documentId) peer.send(state); peer.send(JSON.stringify({ type: 'project-changed', documentId: event.documentId })); }
        return;
      }
      const { type, ...rest } = event;
      const payload = JSON.stringify({ type: 'event', event: { type, ...rest } });
      for (const peer of live) peer.send(payload);
    })();
  });

  /** Valida el origen y actualiza la conexión. Devuelve `undefined` si se actualizó, o la respuesta de rechazo. */
  const handleUpgrade = (request: Request, instance: Server<SocketData>): Response | undefined => {
    if (!options.origins.includes(request.headers.get('origin') ?? '')) return new Response('Acceso denegado', { status: 403 });
    if (peers.size >= maxPeers) return new Response('Servidor ocupado', { status: 503 });
    if (instance.upgrade(request, { data: {} })) return undefined;
    return new Response('Se requiere WebSocket', { status: 400 });
  };

  const websocket: WebSocketHandler<SocketData> = {
      maxPayloadLength: 1_400_000,
      // Las conexiones que desaparecen sin cerrarse (caída de red, navegador cerrado) se descartan pronto para no mostrar presencia fantasma.
      idleTimeout: 40,
      sendPings: true,
      open(ws) {
        ws.data.limiter = new RateLimiter(200, options.messagesPerSecond ?? 60);
        ws.data.peerId = crypto.randomUUID();
        peers.add(ws);
        // Una conexión que nunca se identifica no debe ocupar recursos indefinidamente.
        const timer = setTimeout(() => { if (!ws.data.projectId) ws.close(1008, 'Se requiere open'); }, options.openTimeoutMs ?? 10_000);
        (timer as { unref?: () => void }).unref?.();
      },
      async message(ws, message) {
        if (typeof message !== 'string') { error(ws, 'Mensaje inválido'); return; }
        if (!ws.data.limiter?.take('m')) {
          ws.data.violations = (ws.data.violations ?? 0) + 1;
          if (ws.data.violations > 50) { ws.close(1008, 'Límite de mensajes excedido'); return; }
          error(ws, 'Demasiados mensajes'); return;
        }
        try {
          const data = JSON.parse(message) as InitMessage | { type: 'update'; update: string } | { type: 'presence'; anchor: number; head: number; rel?: { anchor: unknown; head: unknown } };
          if (data.type === 'open') {
            if (ws.data.projectId || typeof data.projectId !== 'string' || (data.documentId !== undefined && typeof data.documentId !== 'string')) throw new Error('Solicitud inválida');
            const next: SocketData = { ...ws.data, projectId: data.projectId, documentId: data.documentId, sessionToken: typeof data.sessionToken === 'string' ? data.sessionToken.slice(0, 256) : undefined, linkToken: typeof data.linkToken === 'string' ? data.linkToken.slice(0, 256) : undefined };
            const identity = await principal(next);
            if (!identity.userId) throw new Error('Inicia sesión para colaborar');
            if (data.documentId) {
              const state = await options.documents.read(data.projectId, data.documentId, identity);
              ws.data = next;
              ws.send(JSON.stringify({ type: 'state', update: Buffer.from(state).toString('base64') }));
            } else {
              if (!await options.access.can(data.projectId, identity.userId, 'read', identity.linkToken)) throw new Error('Acceso denegado');
              ws.data = next;
              ws.send(JSON.stringify({ type: 'ready' }));
            }
            // El cliente aprende su identificador de conexión para no dibujar su propio cursor como remoto.
            ws.send(JSON.stringify({ type: 'hello', peerId: ws.data.peerId }));
            await broadcastPresence(data.projectId);
          } else if (data.type === 'update') {
            const { projectId, documentId } = ws.data;
            if (!projectId || !documentId || typeof data.update !== 'string' || data.update.length > 1_350_000) throw new Error('Solicitud inválida');
            const identity = await principal(ws.data);
            if (!identity.userId) throw new Error('Inicia sesión para colaborar');
            const state = await options.documents.apply(projectId, documentId, identity, Buffer.from(data.update, 'base64'));
            const payload = JSON.stringify({ type: 'state', update: Buffer.from(state).toString('base64') });
            for (const peer of await authorized(projectId)) {
              if (peer.data.documentId === documentId) peer.send(payload);
              peer.send(JSON.stringify({ type: 'project-changed', documentId }));
            }
            options.events?.emit(projectId, { type: 'doc-edited', documentId, userId: identity.userId });
          } else if (data.type === 'presence') {
            const { projectId } = ws.data, identity = await principal(ws.data);
            if (!projectId || !identity.userId || !await options.access.can(projectId, identity.userId, 'read', identity.linkToken)) throw new Error('Acceso denegado');
            if (!Number.isSafeInteger(data.anchor) || !Number.isSafeInteger(data.head) || data.anchor < 0 || data.head < 0 || data.anchor > 1_000_000 || data.head > 1_000_000) throw new Error('Selección inválida');
            // Las posiciones relativas de Yjs (ancladas a caracteres) permiten a cada receptor dibujar el cursor correctamente aunque el texto cambie.
            const rel = data.rel;
            const validRel = rel && typeof rel === 'object' && rel.anchor && typeof rel.anchor === 'object' && rel.head && typeof rel.head === 'object' && JSON.stringify(rel).length <= 1200;
            if (rel !== undefined && !validRel) throw new Error('Selección inválida');
            ws.data.selection = { anchor: data.anchor, head: data.head, ...(validRel ? { rel } : {}) };
            await broadcastPresence(projectId);
          } else throw new Error('Mensaje desconocido');
        } catch (e) { error(ws, e instanceof Error ? e.message : 'Error de sincronización'); }
      },
      close(ws) { peers.delete(ws); if (ws.data.projectId) void broadcastPresence(ws.data.projectId); },
  };
  return { websocket, handleUpgrade };
}

/** Servidor WebSocket independiente (pruebas y despliegues que lo separan de la API). `server.ts` usa `createCollaborationSocket` en el mismo puerto. */
export function startCollaborationSocket(options: SocketOptions): Server<SocketData> {
  const socket = createCollaborationSocket(options);
  return Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 0,
    fetch(request, instance) {
      if (new URL(request.url).pathname !== '/ws') return new Response('Acceso denegado', { status: 403 });
      return socket.handleUpgrade(request, instance);
    },
    websocket: socket.websocket,
  });
}
