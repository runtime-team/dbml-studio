import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as Y from 'yjs';
import { AccessStore } from '../src/collaboration/access';
import { SharedDocuments } from '../src/collaboration/documents';
import { SessionStore } from '../src/collaboration/sessions';
import { startCollaborationSocket } from '../src/collaboration/socket';

test('WebSocket valida sesión y permisos al recibir actualizaciones', async () => {
  const db = new Database(':memory:');
  const access = new AccessStore(db), sessions = new SessionStore(db), documents = new SharedDocuments(db, access);
  const user = await sessions.createAccount('owner', 'contraseña muy larga');
  const session = (await sessions.login('owner', 'contraseña muy larga'))!;
  const project = access.createProject(user), id = documents.create(project, { userId: user }, 'ventas', 'a.dbml', 'abc');
  const otherId = documents.create(project, { userId: user }, 'ventas', 'b.dbml', 'otro');
  const server = startCollaborationSocket({ access, sessions, documents, origins: ['http://localhost:5173'] });
  const BunSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const ws = new BunSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: 'http://localhost:5173' } });
  const other = new BunSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: 'http://localhost:5173' } });
  try {
    const receive = (type: string, predicate: (message: any) => boolean = () => true) => new Promise<any>((resolve, reject) => { const timeout = setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error('timeout')); }, 3000); const handler = (e: MessageEvent) => { const message = JSON.parse(String(e.data)); if (message.type !== type || !predicate(message)) return; clearTimeout(timeout); ws.removeEventListener('message', handler); resolve(message); }; ws.addEventListener('message', handler); });
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket error')); });
    if (other.readyState !== WebSocket.OPEN) await new Promise<void>((resolve, reject) => { other.onopen = () => resolve(); other.onerror = () => reject(new Error('socket error')); });
    const otherReady = new Promise<void>(resolve => { other.addEventListener('message', e => { if (JSON.parse(String(e.data)).type === 'state') resolve(); }); });
    other.send(JSON.stringify({ type: 'open', projectId: project, documentId: otherId, sessionToken: session.token })); await otherReady;
    let response = receive('state'); ws.send(JSON.stringify({ type: 'open', projectId: project, documentId: id, sessionToken: session.token }));
    const initial = await response; expect(initial.type).toBe('state');
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(initial.update, 'base64')); doc.getText('source').insert(3, '!');
    response = receive('presence', message => message.members.some((member: any) => member.selection?.anchor === 1)); ws.send(JSON.stringify({ type: 'presence', anchor: 1, head: 2 }));
    expect((await response).members.some((member: any) => member.selection?.anchor === 1 && member.selection?.head === 2)).toBe(true);
    const otherChanged = new Promise<any>(resolve => { other.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.type === 'project-changed') resolve(m); }); });
    response = receive('state'); ws.send(JSON.stringify({ type: 'update', update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') }));
    expect((await response).type).toBe('state');
    expect((await otherChanged).documentId).toBe(id);
    sessions.revoke(session.token);
    response = receive('error'); ws.send(JSON.stringify({ type: 'update', update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') }));
    expect((await response).message).toBe('Acceso denegado');
    doc.destroy();
  } finally { ws.close(); other.close(); server.stop(true); db.close(); }
});
