import { Database } from 'bun:sqlite';
import * as Y from 'yjs';
import { createSharedApi } from '../src/collaboration/api';
import { createServices, type ServiceOptions, type Services } from '../src/collaboration/services';
import { startCollaborationSocket } from '../src/collaboration/socket';
import { CollaborationClient, type ClientOptions } from '../src/collaboration/client';
import { RateLimiter } from '../src/collaboration/ratelimit';

export const PASSWORD = 'contraseña muy larga';
export const ORIGIN = 'http://localhost:5173';

/** Entorno colaborativo completo en memoria: servicios, API HTTP y, bajo demanda, el servidor WebSocket. */
export function harness(options: ServiceOptions = {}) {
  const db = new Database(':memory:');
  const services: Services = createServices(db, { idleMs: 0, passwordCost: { memoryCost: 1024, timeCost: 1 }, limits: { write: new RateLimiter(10_000, 10_000), read: new RateLimiter(10_000, 10_000), export: new RateLimiter(10_000, 10_000) }, ...options });
  const api = createSharedApi(services.access, services.sessions, services.documents, services);
  const servers: ReturnType<typeof startCollaborationSocket>[] = [];

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string; link?: string; ip?: string; raw?: string; type?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.link) headers['x-share-token'] = init.link;
    const hasBody = init.body !== undefined || init.raw !== undefined;
    if (hasBody) headers['content-type'] = init.type ?? 'application/json';
    const response = await api(new Request(`http://localhost/api/shared/${path}`, { method: init.method ?? (hasBody ? 'POST' : 'GET'), headers, ...(hasBody ? { body: init.raw ?? JSON.stringify(init.body) } : {}) }), init.ip ?? 'test');
    const text = await response.text();
    let data: any = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };

  const account = async (name: string) => {
    const userId = await services.sessions.createAccount(name, PASSWORD);
    const session = (await services.sessions.login(name, PASSWORD))!;
    return { name, userId, token: session.token };
  };

  const socket = () => {
    const server = startCollaborationSocket({ access: services.access, sessions: services.sessions, documents: services.documents, events: services.events, origins: [ORIGIN] });
    servers.push(server);
    return server;
  };
  const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;

  /** Cliente CRDT conectado al servidor, con su propio documento. */
  const client = (server: ReturnType<typeof socket>, project: string, documentId: string | undefined, who: { token?: string; link?: string; editable?: boolean }, extra: Partial<ClientOptions> = {}) => {
    const doc = new Y.Doc();
    const state = { status: '', events: [] as any[], presence: [] as any[], errors: [] as string[] };
    const c = new CollaborationClient(doc, {
      url: `ws://127.0.0.1:${server.port}/ws`, projectId: project, documentId, sessionToken: who.token, linkToken: who.link, editable: who.editable ?? true, reconnectDelayMs: 40,
      socketFactory: url => new Socket(url, { headers: { Origin: ORIGIN } }),
      onStatus: s => { state.status = s; }, onEvent: e => state.events.push(e), onPresence: m => { state.presence = m; }, onError: m => state.errors.push(m), ...extra,
    });
    c.connect();
    return { doc, client: c, state, text: () => doc.getText('source').toString() };
  };

  const until = async (predicate: () => boolean | Promise<boolean>, what = 'condición', ms = 4000) => {
    const end = Date.now() + ms;
    while (!(await predicate())) { if (Date.now() > end) throw new Error(`Tiempo agotado esperando: ${what}`); await Bun.sleep(15); }
  };

  const project = async (owner: { token: string }, name = 'Proyecto de prueba') => (await call('projects', { body: { name }, token: owner.token })).data.id as string;
  const addFile = async (token: string, projectId: string, packageId: string, name: string, content: string) =>
    (await call(`projects/${projectId}/documents`, { body: { packageId, name, content }, token })).data.id as string;
  const textOf = (projectId: string, documentId: string, userId: string) => {
    const doc = new Y.Doc();
    try { Y.applyUpdate(doc, services.documents.read(projectId, documentId, { userId })); return doc.getText('source').toString(); } finally { doc.destroy(); }
  };

  return { db, services, api, call, account, socket, client, until, project, addFile, textOf, close() { for (const s of servers) s.stop(true); db.close(); } };
}

export const CATALOGOS = 'Table paises {\n  id int [pk]\n  nombre varchar\n}';
export const VENTAS = "use * from '../catalogos/paises'\nTable pedidos {\n  id int [pk]\n  pais_id int [ref: > paises.id]\n}";
