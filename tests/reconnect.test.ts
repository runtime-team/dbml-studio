import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as Y from 'yjs';
import { AccessStore } from '../src/collaboration/access';
import { SharedDocuments } from '../src/collaboration/documents';
import { SessionStore } from '../src/collaboration/sessions';
import { startCollaborationSocket } from '../src/collaboration/socket';
import { CollaborationClient } from '../src/collaboration/client';

test('reconecta y persiste ediciones realizadas durante la desconexión', async () => {
  const db = new Database(':memory:');
  const access = new AccessStore(db), sessions = new SessionStore(db), documents = new SharedDocuments(db, access);
  const user = await sessions.createAccount('owner', 'contraseña muy larga');
  const session = (await sessions.login('owner', 'contraseña muy larga'))!;
  const project = access.createProject(user), id = documents.create(project, { userId: user }, 'ventas', 'a.dbml', 'abc');
  const config = { access, sessions, documents, origins: ['http://localhost:5173'] };
  let server = startCollaborationSocket(config); const port = server.port;
  const BunSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const local = new Y.Doc(); let status = '';
  const client = new CollaborationClient(local, { url: `ws://127.0.0.1:${port}/ws`, projectId: project, documentId: id, sessionToken: session.token, editable: true, reconnectDelayMs: 50, socketFactory: url => new BunSocket(url, { headers: { Origin: 'http://localhost:5173' } }), onStatus: value => { status = value; } });
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw new Error('Tiempo de espera agotado'); await Bun.sleep(20); } };
  try {
    client.connect(); await waitFor(() => status === 'connected');
    server.stop(true); await waitFor(() => status === 'offline' || status === 'connecting');
    local.getText('source').insert(3, '!');
    server = startCollaborationSocket({ ...config, port });
    await waitFor(() => status === 'connected');
    await waitFor(() => { const state = new Y.Doc(); Y.applyUpdate(state, documents.read(project, id, { userId: user })); const value = state.getText('source').toString(); state.destroy(); return value === 'abc!'; });
    expect(local.getText('source').toString()).toBe('abc!');
  } finally { client.destroy(); local.destroy(); server.stop(true); db.close(); }
});
