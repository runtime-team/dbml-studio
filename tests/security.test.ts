import { afterEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { RateLimiter } from '../src/collaboration/ratelimit';
import { AccessStore } from '../src/collaboration/access';
import { Database } from 'bun:sqlite';
import { CATALOGOS, ORIGIN, PASSWORD, VENTAS, harness } from './collab-harness';

let h = harness();
afterEach(() => { h.close(); h = harness(); });

describe('autorización en el servidor', () => {
  test('los proyectos privados no exponen nada a quien no tiene acceso', async () => {
    const owner = await h.account('owner'), stranger = await h.account('stranger');
    const id = await h.project(owner);
    const doc = await h.addFile(owner.token, id, 'ventas', 'a.dbml', 'Table secreto { id int }');
    const paths = [`projects/${id}`, `projects/${id}/diagrams`, `projects/${id}/documents/${doc}`, `projects/${id}/comments`, `projects/${id}/revisions`, `projects/${id}/export/schema.sql`, `projects/${id}/export/ventas.svg`, `projects/${id}/definition?table=public.secreto`, `projects/${id}/links`, `projects/${id}/members`, `projects/${id}/audit`];
    for (const path of paths) {
      for (const who of [{}, { token: stranger.token }, { token: 'a'.repeat(43) }, { link: 'inventado' }]) {
        const response = await h.call(path, who);
        expect(response.status, `${path} ${JSON.stringify(Object.keys(who))}`).toBe(403);
        expect(JSON.stringify(response.data ?? '')).not.toContain('secreto');
      }
    }
  });

  test('un usuario o enlace de un proyecto no accede a otro proyecto', async () => {
    const a = await h.account('alice'), b = await h.account('bob');
    const pa = await h.project(a, 'A'), pb = await h.project(b, 'B');
    const docB = await h.addFile(b.token, pb, 'x', 'x.dbml', 'Table b { id int }');
    const linkA = (await h.call(`projects/${pa}/links`, { body: { mode: 'view' }, token: a.token })).data;
    expect((await h.call(`projects/${pb}`, { token: a.token })).status).toBe(403);
    expect((await h.call(`projects/${pb}`, { link: linkA.token })).status).toBe(403);
    // Un documento de B no se lee ni se edita pasando por el proyecto A.
    expect((await h.call(`projects/${pa}/documents/${docB}`, { token: a.token })).status).toBe(404);
    expect((await h.call(`projects/${pa}/documents/${docB}/delete`, { body: {}, token: a.token })).status).toBe(404);
    expect(() => h.services.documents.apply(pa, docB, { userId: a.userId }, Y.encodeStateAsUpdate(new Y.Doc()))).toThrow();
  });

  test('un Viewer no puede modificar nada y un Commenter solo comenta', async () => {
    const owner = await h.account('owner'), viewer = await h.account('viewer'), commenter = await h.account('commenter');
    const id = await h.project(owner);
    await h.call(`projects/${id}/members`, { body: { username: 'viewer', role: 'viewer' }, token: owner.token });
    await h.call(`projects/${id}/members`, { body: { username: 'commenter', role: 'commenter' }, token: owner.token });
    const doc = await h.addFile(owner.token, id, 'p', 'a.dbml', 'Table a { id int [pk] }');
    for (const who of [viewer, commenter]) {
      expect((await h.call(`projects/${id}/documents`, { body: { packageId: 'p', name: 'b.dbml', content: '' }, token: who.token })).status).toBe(403);
      expect((await h.call(`projects/${id}/documents/${doc}/delete`, { body: {}, token: who.token })).status).toBe(403);
      expect((await h.call(`projects/${id}/diagram`, { body: { packageId: 'p', patch: {} }, token: who.token })).status).toBe(403);
      expect((await h.call(`projects/${id}/revisions`, { body: {}, token: who.token })).status).toBe(403);
      expect((await h.call(`projects/${id}/links`, { body: { mode: 'view' }, token: who.token })).status).toBe(403);
      expect((await h.call(`projects/${id}/members`, { body: { username: 'owner', role: 'viewer' }, token: who.token })).status).toBe(403);
      expect((await h.call(`projects/${id}/rename`, { body: { name: 'robado' }, token: who.token })).status).toBe(403);
    }
    expect(h.services.access.can(id, viewer.userId, 'edit')).toBe(false);
    expect((await h.call(`projects/${id}`, { token: owner.token })).data.name).toBe('Proyecto de prueba');
  });

  test('los enlaces de edición exigen sesión y los enlaces caducados o revocados dejan de funcionar', async () => {
    let now = 1_000_000;
    h.close(); h = harness({ now: () => now });
    const owner = await h.account('owner'), guest = await h.account('guest');
    const id = await h.project(owner);
    await h.addFile(owner.token, id, 'p', 'a.dbml', 'Table a { id int }');
    const edit = (await h.call(`projects/${id}/links`, { body: { mode: 'edit', ttlSeconds: 3600 }, token: owner.token })).data;
    const anonymous = await h.call(`projects/${id}/documents`, { body: { packageId: 'p', name: 'x.dbml', content: '' }, link: edit.token });
    expect(anonymous.status).toBe(403); // no hay edición anónima
    expect((await h.call(`projects/${id}`, { link: edit.token })).status).toBe(403); // ni siquiera lectura sin ser miembro: el enlace de edición no concede lectura anónima
    expect((await h.call(`projects/${id}/documents`, { body: { packageId: 'p', name: 'x.dbml', content: '' }, link: edit.token, token: guest.token })).status).toBe(201);
    now += 3601 * 1000;
    expect((await h.call(`projects/${id}/documents`, { body: { packageId: 'p', name: 'y.dbml', content: '' }, link: edit.token, token: guest.token })).status).toBe(403);
    const view = (await h.call(`projects/${id}/links`, { body: { mode: 'view' }, token: owner.token })).data;
    expect((await h.call(`projects/${id}`, { link: view.token })).status).toBe(200);
    await h.call(`projects/${id}/links/${view.id}/revoke`, { body: {}, token: owner.token });
    expect((await h.call(`projects/${id}`, { link: view.token })).status).toBe(403);
    expect((await h.call(`projects/${id}/links/${view.id}/revoke`, { body: {}, token: owner.token })).status).toBe(200); // idempotente
    expect((await h.call(`projects/${id}/links/inexistente/revoke`, { body: {}, token: owner.token })).status).toBe(404);
  });

  test('guarda las contraseñas y los enlaces solo como hashes', async () => {
    const owner = await h.account('owner');
    const id = await h.project(owner);
    const link = (await h.call(`projects/${id}/links`, { body: { mode: 'view' }, token: owner.token })).data;
    const dump = JSON.stringify([...h.db.query('SELECT * FROM share_links').all(), ...h.db.query('SELECT * FROM accounts').all(), ...h.db.query('SELECT * FROM sessions').all()]);
    expect(dump).not.toContain(link.token);
    expect(dump).not.toContain(owner.token);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).toContain('$argon2id$');
    expect(link.token.length).toBeGreaterThanOrEqual(43);
  });

  test('el registro de acciones administrativas es consultable solo por administradores', async () => {
    const owner = await h.account('owner'), editor = await h.account('editor');
    const id = await h.project(owner);
    await h.call(`projects/${id}/members`, { body: { username: 'editor', role: 'editor' }, token: owner.token });
    const link = (await h.call(`projects/${id}/links`, { body: { mode: 'view' }, token: owner.token })).data;
    await h.call(`projects/${id}/links/${link.id}/revoke`, { body: {}, token: owner.token });
    await h.call(`projects/${id}/members/${editor.userId}/remove`, { body: {}, token: owner.token });
    await h.call('login', { body: { username: 'owner', password: 'incorrecta1234' } });
    const entries = (await h.call(`projects/${id}/audit`, { token: owner.token })).data.entries as { action: string; actorName: string }[];
    expect(entries.map(e => e.action).reverse()).toEqual(['project.create', 'member.set', 'link.create', 'link.revoke', 'member.remove']);
    expect(entries.every(e => e.actorName === 'owner')).toBe(true);
    expect((await h.call(`projects/${id}/audit`, { token: editor.token })).status).toBe(403);
    expect(h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action='auth.failed'").get()).toEqual({ n: 1 });
  });

  test('las cuentas existentes y las inexistentes responden igual en el inicio de sesión', async () => {
    await h.account('owner');
    const bad = await h.call('login', { body: { username: 'owner', password: 'incorrecta1234' } });
    const missing = await h.call('login', { body: { username: 'nadie', password: 'incorrecta1234' } });
    expect([bad.status, bad.data]).toEqual([missing.status, missing.data]);
    expect(bad.status).toBe(403);
    expect((await h.call('me')).status).toBe(401);
  });

  test('el registro de cuentas está desactivado salvo que se habilite', async () => {
    expect((await h.call('register', { body: { username: 'nuevo', password: PASSWORD } })).status).toBe(403);
    expect((await h.call('config')).data).toEqual({ registration: false });
    h.close(); h = harness({ registration: true });
    expect((await h.call('config')).data).toEqual({ registration: true });
    const created = await h.call('register', { body: { username: 'nuevo', password: PASSWORD } });
    expect(created.status).toBe(201);
    expect((await h.call('me', { token: created.data.token })).data.username).toBe('nuevo');
    expect((await h.call('register', { body: { username: 'nuevo', password: PASSWORD } })).status).toBe(400);
    expect((await h.call('register', { body: { username: 'otro', password: 'corta' } })).status).toBe(400);
  });
});

describe('límites y validación', () => {
  test('limita los intentos de inicio de sesión por origen y usuario', async () => {
    let now = 0;
    h.close(); h = harness({ now: () => now, limits: { login: new RateLimiter(3, 0.1, () => now) } });
    await h.account('owner');
    const attempt = (ip = 'a') => h.call('login', { body: { username: 'owner', password: 'incorrecta1234' }, ip });
    expect([(await attempt()).status, (await attempt()).status, (await attempt()).status]).toEqual([403, 403, 403]);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await attempt('otra-ip')).status).toBe(403); // otro origen tiene su propia cubeta
    now += 60_000;
    expect((await attempt()).status).toBe(403);
    expect(h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action='auth.rate-limited'").get()).toEqual({ n: 1 });
  });

  test('limita la frecuencia de operaciones de escritura por cuenta', async () => {
    let now = 0;
    h.close(); h = harness({ now: () => now, limits: { write: new RateLimiter(5, 1, () => now) } });
    const owner = await h.account('owner');
    const id = await h.project(owner);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await h.call(`projects/${id}/comments`, { body: { targetType: 'project', targetId: id, body: `n${i}` }, token: owner.token })).status);
    expect(statuses.filter(s => s === 429).length).toBeGreaterThanOrEqual(3);
    now += 10_000;
    expect((await h.call(`projects/${id}/comments`, { body: { targetType: 'project', targetId: id, body: 'ok' }, token: owner.token })).status).toBe(201);
  });

  test('rechaza cuerpos enormes, JSON inválido, tipos incorrectos y rutas desconocidas', async () => {
    const owner = await h.account('owner');
    const id = await h.project(owner);
    const big = await h.call(`projects/${id}/documents`, { raw: JSON.stringify({ packageId: 'p', name: 'a.dbml', content: 'x'.repeat(1_200_000) }), token: owner.token });
    expect(big.status).toBe(413);
    // Los límites se miden por bytes, aunque el contenido use pocos caracteres UTF-16.
    const multibyte = await h.call(`projects/${id}/documents`, { raw: JSON.stringify({ packageId: 'p', name: 'a.dbml', content: '😀'.repeat(300_000) }), token: owner.token });
    expect(multibyte.status).toBe(413);
    expect((await h.call(`projects/${id}/documents`, { raw: '{no es json', token: owner.token })).status).toBe(400);
    expect((await h.call(`projects/${id}/documents`, { raw: '[1,2]', token: owner.token })).status).toBe(400);
    expect((await h.call(`projects/${id}/documents`, { raw: 'a=b', type: 'text/plain', token: owner.token })).status).toBe(415);
    expect((await h.call(`projects/${id}/inexistente`, { token: owner.token })).status).toBe(404);
    for (const name of ['../x.dbml', 'a b.dbml', 'a.txt', '', 'x'.repeat(130) + '.dbml'])
      expect((await h.call(`projects/${id}/documents`, { body: { packageId: 'p', name, content: '' }, token: owner.token })).status, name).toBe(400);
    for (const packageId of ['../p', 'a/b', '', 'x'.repeat(81)])
      expect((await h.call(`projects/${id}/documents`, { body: { packageId, name: 'a.dbml', content: '' }, token: owner.token })).status, packageId).toBe(400);
    expect((await h.call(`projects/${id}/documents`, { body: { packageId: 'p', name: 'a.dbml', content: 5 }, token: owner.token })).status).toBe(400);
  });

  test('los errores internos no filtran detalles', async () => {
    const owner = await h.account('owner');
    const id = await h.project(owner);
    h.db.exec('DROP TABLE comments');
    const response = await h.call(`projects/${id}/comments`, { token: owner.token });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.data)).toBe('{"error":"Error interno"}');
  });

  test('el WebSocket valida orígenes, mensajes y tamaños', async () => {
    const owner = await h.account('owner'), viewer = await h.account('viewer'), stranger = await h.account('stranger');
    const id = await h.project(owner);
    await h.call(`projects/${id}/members`, { body: { username: 'viewer', role: 'viewer' }, token: owner.token });
    const doc = await h.addFile(owner.token, id, 'p', 'a.dbml', 'Table a { id int }');
    const server = h.socket();
    const Socket = WebSocket as unknown as new (url: string, options?: { headers: Record<string, string> }) => WebSocket;
    const open = (origin?: string) => new Promise<WebSocket>((resolve, reject) => { const ws = new Socket(`ws://127.0.0.1:${server.port}/ws`, origin ? { headers: { Origin: origin } } : undefined); ws.onopen = () => resolve(ws); ws.onerror = () => reject(new Error('rechazado')); });
    await expect(open('https://malo.example')).rejects.toThrow();
    await expect(open()).rejects.toThrow();
    const messages = (ws: WebSocket) => { const list: any[] = []; ws.onmessage = e => list.push(JSON.parse(String(e.data))); return list; };
    const send = async (ws: WebSocket, list: any[], payload: unknown, wait: (m: any) => boolean) => { const before = list.length; ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); await h.until(() => list.slice(before).some(wait), 'respuesta'); };

    const ws = await open(ORIGIN); const list = messages(ws);
    await send(ws, list, 'esto no es json', m => m.type === 'error');
    await send(ws, list, { type: 'update', update: 'AAAA' }, m => m.type === 'error' && m.message === 'Solicitud inválida'); // sin abrir antes
    await send(ws, list, { type: 'desconocido' }, m => m.type === 'error' && m.message === 'Mensaje desconocido');
    await send(ws, list, { type: 'open', projectId: id, documentId: doc, sessionToken: stranger.token }, m => m.type === 'error' && m.message === 'Acceso denegado');
    await send(ws, list, { type: 'open', projectId: id, documentId: doc, sessionToken: viewer.token }, m => m.type === 'state');
    await send(ws, list, { type: 'open', projectId: id, documentId: doc, sessionToken: viewer.token }, m => m.type === 'error'); // no se puede reabrir
    // El lector no puede escribir ni con un update bien formado.
    const edit = new Y.Doc(); edit.getText('source').insert(0, 'hack');
    await send(ws, list, { type: 'update', update: Buffer.from(Y.encodeStateAsUpdate(edit)).toString('base64') }, m => m.type === 'error' && m.message === 'Acceso denegado');
    expect(h.textOf(id, doc, owner.userId)).toBe('Table a { id int }');
    await send(ws, list, { type: 'presence', anchor: -1, head: 0 }, m => m.type === 'error' && m.message === 'Selección inválida');
    await send(ws, list, { type: 'presence', anchor: 0, head: 1, rel: 'no-es-un-objeto' }, m => m.type === 'error' && m.message === 'Selección inválida');
    await send(ws, list, { type: 'presence', anchor: 0, head: 1, rel: { anchor: {}, head: { x: 'y'.repeat(2000) } } }, m => m.type === 'error' && m.message === 'Selección inválida');
    // Una selección con posiciones relativas válidas se reenvía tal cual a los participantes.
    await send(ws, list, { type: 'presence', anchor: 2, head: 3, rel: { anchor: { type: { client: 1, clock: 2 }, tname: null, item: null, assoc: 0 }, head: { type: null, tname: 'source', item: null, assoc: 0 } } },
      m => m.type === 'presence' && m.members.some((x: any) => x.selection?.rel?.head?.tname === 'source' && x.selection.anchor === 2));
    ws.close();

    // Un propietario con un update corrupto recibe un error y el documento sigue intacto.
    const w2 = await open(ORIGIN); const l2 = messages(w2);
    await send(w2, l2, { type: 'open', projectId: id, documentId: doc, sessionToken: owner.token }, m => m.type === 'state');
    await send(w2, l2, { type: 'update', update: Buffer.from([255, 255, 255, 9, 9]).toString('base64') }, m => m.type === 'error');
    await send(w2, l2, { type: 'update', update: 'x'.repeat(1_351_000) }, m => m.type === 'error' && m.message === 'Solicitud inválida');
    expect(h.textOf(id, doc, owner.userId)).toBe('Table a { id int }');
    w2.close();
  });

  test('limita los mensajes por segundo en cada conexión y cierra a quien abusa', async () => {
    const owner = await h.account('owner');
    const id = await h.project(owner);
    const doc = await h.addFile(owner.token, id, 'p', 'a.dbml', 'x');
    h.close(); h = harness({ passwordCost: { memoryCost: 1024, timeCost: 1 } });
    const o2 = await h.account('owner'); const id2 = await h.project(o2); const doc2 = await h.addFile(o2.token, id2, 'p', 'a.dbml', 'x');
    void doc; void id;
    const { startCollaborationSocket } = await import('../src/collaboration/socket');
    const server = startCollaborationSocket({ access: h.services.access, sessions: h.services.sessions, documents: h.services.documents, origins: [ORIGIN], messagesPerSecond: 1 });
    const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const ws = new Socket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: ORIGIN } });
    const received: any[] = []; let closed = false;
    ws.onmessage = e => received.push(JSON.parse(String(e.data))); ws.onclose = () => { closed = true; };
    await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
    ws.send(JSON.stringify({ type: 'open', projectId: id2, documentId: doc2, sessionToken: o2.token }));
    for (let i = 0; i < 400; i++) ws.send(JSON.stringify({ type: 'presence', anchor: 0, head: 0 }));
    await h.until(() => received.some(m => m.message === 'Demasiados mensajes'), 'aviso de límite');
    await h.until(() => closed, 'cierre de la conexión');
    server.stop(true);
  });

  test('el almacén de acceso migra bases de datos antiguas sin perder datos', () => {
    const old = new Database(':memory:');
    old.exec("CREATE TABLE shared_projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL); CREATE TABLE project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(project_id,user_id)); CREATE TABLE share_links (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0); INSERT INTO shared_projects VALUES ('p1','u1'); INSERT INTO project_members VALUES ('p1','u1','owner');");
    const access = new AccessStore(old);
    expect(access.getProject('p1')).toEqual({ id: 'p1', name: 'Proyecto', ownerId: 'u1' });
    expect(access.can('p1', 'u1', 'admin')).toBe(true);
    expect(access.createLink('p1', 'u1', 'view').expiresAt).toBeNull();
    old.close();
  });
});
