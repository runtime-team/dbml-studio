import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AccessStore } from '../src/collaboration/access';
import { SessionStore } from '../src/collaboration/sessions';
import { SharedDocuments } from '../src/collaboration/documents';
import { createSharedApi } from '../src/collaboration/api';

test('API compartida aplica identidad, roles y revocación en el servidor', async () => {
  const db = new Database(':memory:');
  try {
    const access = new AccessStore(db), sessions = new SessionStore(db), documents = new SharedDocuments(db, access), api = createSharedApi(access, sessions, documents);
    await sessions.createAccount('owner', 'contraseña muy larga');
    const post = (path: string, body: unknown, token?: string) => api(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
    const login = await post('/api/shared/login', { username: 'owner', password: 'contraseña muy larga' });
    const { token } = await login.json() as { token: string };
    const created = await post('/api/shared/projects', {}, token); expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect((await post(`/api/shared/projects/${id}/documents`, { packageId: 'ventas', name: 'a.dbml', content: 'Table x { id int }' })).status).toBe(403);
    expect((await post(`/api/shared/projects/${id}/documents`, { packageId: 'ventas', name: 'a.dbml', content: 'Table x { id int }' }, token)).status).toBe(201);
    const link = await (await post(`/api/shared/projects/${id}/links`, { mode: 'view' }, token)).json() as { id: string; token: string };
    expect((await api(new Request(`http://localhost/api/shared/projects/${id}/links`))).status).toBe(403);
    const linksResponse = await api(new Request(`http://localhost/api/shared/projects/${id}/links`, { headers: { authorization: `Bearer ${token}` } }));
    expect(((await linksResponse.json()) as { links: { id: string }[] }).links[0]?.id).toBe(link.id);
    const read = () => api(new Request(`http://localhost/api/shared/projects/${id}`, { headers: { 'x-share-token': link.token } }));
    expect((await read()).status).toBe(200);
    const data = await (await read()).json() as { editable: boolean; documents: unknown[] };
    expect(data.editable).toBe(false); expect(data.documents).toHaveLength(1);
    const diagram = await api(new Request(`http://localhost/api/shared/projects/${id}/diagrams`, { headers: { 'x-share-token': link.token } }));
    expect(diagram.status).toBe(200);
    const rendered = await diagram.json() as { ok: boolean; diagrams: { packageId: string; hash: string; nodes: { id: string }[] }[] };
    expect(rendered.diagrams[0]?.packageId).toBe('ventas');
    expect(rendered.ok).toBe(true);
    expect(rendered.diagrams[0]?.nodes).toHaveLength(1);
    expect(rendered.diagrams[0]?.hash).toMatch(/^[0-9a-f]{16}$/);
    await post(`/api/shared/projects/${id}/links/${link.id}/revoke`, {}, token);
    expect((await read()).status).toBe(403);
  } finally { db.close(); }
});
