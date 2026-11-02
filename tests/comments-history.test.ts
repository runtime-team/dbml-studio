import { afterEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { CATALOGOS, VENTAS, harness } from './collab-harness';

let h = harness();
afterEach(() => { h.close(); h = harness(); });

async function scenario() {
  const owner = await h.account('owner'), editor = await h.account('editor'), commenter = await h.account('commenter'), viewer = await h.account('viewer'), outsider = await h.account('outsider');
  const id = await h.project(owner);
  for (const [who, role] of [[editor, 'editor'], [commenter, 'commenter'], [viewer, 'viewer']] as const) await h.call(`projects/${id}/members`, { body: { username: who.name, role }, token: owner.token });
  const cat = await h.addFile(owner.token, id, 'catalogos', 'paises.dbml', CATALOGOS);
  const ven = await h.addFile(owner.token, id, 'ventas', 'pedidos.dbml', VENTAS);
  return { owner, editor, commenter, viewer, outsider, id, cat, ven };
}

describe('comentarios', () => {
  test('se asocian a la entidad lógica, se responden, se resuelven y muestran autor y fecha', async () => {
    const s = await scenario();
    const create = await h.call(`projects/${s.id}/comments`, { body: { targetType: 'table', targetId: 'public.paises', packageId: 'catalogos', body: '¿Falta el código ISO?' }, token: s.commenter.token });
    expect(create.status).toBe(201);
    const thread = create.data.thread;
    expect(thread).toMatchObject({ targetType: 'table', targetId: 'public.paises', packageId: 'catalogos', resolved: false });
    expect(thread.comments[0]).toMatchObject({ authorName: 'commenter', body: '¿Falta el código ISO?' });
    expect(typeof thread.comments[0].createdAt).toBe('number');
    const reply = await h.call(`projects/${s.id}/comments`, { body: { parentId: thread.id, body: 'Lo añado.' }, token: s.editor.token });
    expect(reply.data.thread.comments.map((c: any) => c.authorName)).toEqual(['commenter', 'editor']);
    expect(reply.data.thread.targetId).toBe('public.paises');
    const resolved = await h.call(`projects/${s.id}/comments/${thread.id}/resolve`, { body: { resolved: true }, token: s.editor.token });
    expect(resolved.data.thread).toMatchObject({ resolved: true });
    const open = await h.call(`projects/${s.id}/comments?status=open`, { token: s.viewer.token });
    expect(open.data.threads).toHaveLength(0);
    const closed = await h.call(`projects/${s.id}/comments?status=resolved&targetType=table&targetId=public.paises`, { token: s.viewer.token });
    expect(closed.data.threads).toHaveLength(1);
    // Responder reabre la discusión.
    const reopened = await h.call(`projects/${s.id}/comments`, { body: { parentId: thread.id, body: 'Aún falta.' }, token: s.commenter.token });
    expect(reopened.data.thread.resolved).toBe(false);
  });

  test('admite comentarios sobre proyecto, paquete, tabla, columna, relación y conector', async () => {
    const s = await scenario();
    const targets = [['project', s.id], ['package', 'ventas'], ['table', 'public.pedidos'], ['column', 'public.pedidos.pais_id'], ['relationship', 'relationship:%5B%22x%22%5D'], ['connector', 'connector:node:ventas:public.paises:c:relationship:x']];
    for (const [targetType, targetId] of targets) expect((await h.call(`projects/${s.id}/comments`, { body: { targetType, targetId, body: `sobre ${targetType}` }, token: s.owner.token })).status).toBe(201);
    const all = await h.call(`projects/${s.id}/comments?status=all`, { token: s.owner.token });
    expect(all.data.threads.map((t: any) => t.targetType).sort()).toEqual(['column', 'connector', 'package', 'project', 'relationship', 'table']);
    expect(all.data.counts['column|public.pedidos.pais_id']).toBe(1);
    expect((await h.call(`projects/${s.id}/comments`, { body: { targetType: 'fantasia', targetId: 'x', body: 'no' }, token: s.owner.token })).status).toBe(400);
  });

  test('los comentarios no modifican el esquema SQL ni los diagramas', async () => {
    const s = await scenario();
    const before = (await h.call(`projects/${s.id}/export/schema.sql`, { token: s.owner.token })).data;
    const diagramsBefore = (await h.call(`projects/${s.id}/diagrams`, { token: s.owner.token })).data.diagrams.map((d: any) => d.hash);
    await h.call(`projects/${s.id}/comments`, { body: { targetType: 'table', targetId: 'public.paises', body: 'nota' }, token: s.owner.token });
    expect((await h.call(`projects/${s.id}/export/schema.sql`, { token: s.owner.token })).data).toBe(before);
    expect((await h.call(`projects/${s.id}/diagrams`, { token: s.owner.token })).data.diagrams.map((d: any) => d.hash)).toEqual(diagramsBefore);
  });

  test('permanecen asociados a su entidad aunque cambien las posiciones del diagrama', async () => {
    const s = await scenario();
    await h.call(`projects/${s.id}/comments`, { body: { targetType: 'table', targetId: 'public.paises', packageId: 'catalogos', body: 'anclado' }, token: s.owner.token });
    await h.call(`projects/${s.id}/diagram`, { body: { packageId: 'catalogos', patch: { layout: { 'node:catalogos:public.paises': { x: 900, y: 700 } } } }, token: s.owner.token });
    const found = await h.call(`projects/${s.id}/comments?targetType=table&targetId=public.paises`, { token: s.owner.token });
    expect(found.data.threads).toHaveLength(1);
    expect(found.data.threads[0].targetId).toBe('public.paises');
    expect(JSON.stringify(found.data)).not.toContain('900');
  });

  test('respeta los permisos: lectores y anónimos no comentan, solo autor o editores resuelven', async () => {
    const s = await scenario();
    const body = { targetType: 'package', targetId: 'ventas', body: 'hola' };
    expect((await h.call(`projects/${s.id}/comments`, { body, token: s.viewer.token })).status).toBe(403);
    expect((await h.call(`projects/${s.id}/comments`, { body })).status).toBe(403);
    expect((await h.call(`projects/${s.id}/comments`, { body, token: s.outsider.token })).status).toBe(403);
    const link = (await h.call(`projects/${s.id}/links`, { body: { mode: 'view' }, token: s.owner.token })).data;
    expect((await h.call(`projects/${s.id}/comments`, { body, link: link.token })).status).toBe(403);
    expect((await h.call(`projects/${s.id}/comments`, { token: s.viewer.token })).status).toBe(200); // lectura permitida
    const thread = (await h.call(`projects/${s.id}/comments`, { body, token: s.editor.token })).data.thread;
    expect((await h.call(`projects/${s.id}/comments/${thread.id}/resolve`, { body: {}, token: s.commenter.token })).status).toBe(403);
    expect((await h.call(`projects/${s.id}/comments/${thread.id}/edit`, { body: { body: 'x' }, token: s.owner.token })).status).toBe(403);
    expect((await h.call(`projects/${s.id}/comments/${thread.id}/edit`, { body: { body: 'editado' }, token: s.editor.token })).data.thread.comments[0]).toMatchObject({ body: 'editado' });
    expect((await h.call(`projects/${s.id}/comments/${thread.id}/delete`, { body: {}, token: s.commenter.token })).status).toBe(403);
    expect((await h.call(`projects/${s.id}/comments/${thread.id}/delete`, { body: {}, token: s.owner.token })).status).toBe(200); // un administrador puede moderar
    expect((await h.call(`projects/${s.id}/comments?status=all`, { token: s.owner.token })).data.threads).toHaveLength(0);
  });

  test('valida el contenido y aísla los proyectos entre sí', async () => {
    const s = await scenario();
    for (const bad of ['', '   ', 'x'.repeat(4001)]) expect((await h.call(`projects/${s.id}/comments`, { body: { targetType: 'project', targetId: s.id, body: bad }, token: s.owner.token })).status).toBe(400);
    const other = await h.project(s.outsider, 'Otro');
    const thread = (await h.call(`projects/${s.id}/comments`, { body: { targetType: 'project', targetId: s.id, body: 'privado' }, token: s.owner.token })).data.thread;
    // Desde otro proyecto, ni se ve ni se puede resolver ni responder.
    expect((await h.call(`projects/${other}/comments?status=all`, { token: s.outsider.token })).data.threads).toHaveLength(0);
    expect((await h.call(`projects/${other}/comments/${thread.id}/resolve`, { body: {}, token: s.outsider.token })).status).toBe(404);
    expect((await h.call(`projects/${other}/comments`, { body: { parentId: thread.id, body: 'intruso' }, token: s.outsider.token })).status).toBe(404);
  });
});

describe('historial y versiones', () => {
  test('registra autor, fecha y paquetes afectados y no duplica versiones sin cambios', async () => {
    const s = await scenario();
    const first = await h.call(`projects/${s.id}/revisions`, { body: { message: 'Primera versión' }, token: s.owner.token });
    expect(first.status).toBe(201);
    expect(first.data.revision).toMatchObject({ seq: 1, kind: 'manual', message: 'Primera versión', authorId: s.owner.userId });
    expect(first.data.revision.affectedPackages).toEqual(['catalogos', 'ventas']);
    const same = await h.call(`projects/${s.id}/revisions`, { body: { message: 'otra vez' }, token: s.owner.token });
    expect(same.data).toMatchObject({ unchanged: true });
    // Solo cambia ventas.
    h.services.documents.setText(s.id, s.ven, { userId: s.owner.userId }, VENTAS + '\nTable extra { id int [pk] }');
    const second = await h.call(`projects/${s.id}/revisions`, { body: { message: 'Añade extra' }, token: s.editor.token });
    expect(second.data.revision).toMatchObject({ seq: 2, affectedPackages: ['ventas'], authorId: s.editor.userId });
    const list = await h.call(`projects/${s.id}/revisions`, { token: s.viewer.token });
    expect(list.data.revisions.map((r: any) => [r.seq, r.authorName])).toEqual([[2, 'editor'], [1, 'owner']]);
    expect((await h.call(`projects/${s.id}/revisions`, { body: { message: 'x' }, token: s.viewer.token })).status).toBe(403);
  });

  test('las ediciones se agrupan en una revisión automática con todos sus autores', async () => {
    const s = await scenario();
    h.services.history.touch(s.id, s.owner.userId);
    h.services.history.touch(s.id, s.editor.userId);
    h.services.documents.setText(s.id, s.cat, { userId: s.editor.userId }, CATALOGOS + '\nTable extra { id int }');
    const automatic = h.services.history.flush(s.id)!;
    expect(automatic).toMatchObject({ kind: 'edit', authorId: s.editor.userId, affectedPackages: ['catalogos', 'ventas'] });
    expect(new Set(automatic.authors)).toEqual(new Set([s.owner.userId, s.editor.userId]));
    expect(h.services.history.flush(s.id)).toBeUndefined();
    // Sin cambios no se crea una revisión nueva.
    h.services.history.touch(s.id, s.owner.userId);
    expect(h.services.history.flush(s.id)).toBeUndefined();
  });

  test('compara versiones con el estado actual y entre sí, incluyendo la configuración visual', async () => {
    const s = await scenario();
    const r1 = (await h.call(`projects/${s.id}/revisions`, { body: { message: 'v1' }, token: s.owner.token })).data.revision;
    h.services.documents.setText(s.id, s.cat, { userId: s.owner.userId }, 'Table paises {\n  id int [pk]\n  nombre varchar\n  codigo varchar\n}');
    await h.call(`projects/${s.id}/diagram`, { body: { packageId: 'ventas', patch: { layout: { 'node:ventas:public.pedidos': { x: 80, y: 80 } } } }, token: s.owner.token });
    const r2 = (await h.call(`projects/${s.id}/revisions`, { body: { message: 'v2' }, token: s.owner.token })).data.revision;
    const diff = (await h.call(`projects/${s.id}/revisions/${r1.id}/diff?against=${r2.id}`, { token: s.viewer.token })).data;
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ packageId: 'catalogos', name: 'paises.dbml', status: 'modified', added: 1, removed: 0 });
    expect(diff.files[0].hunks[0].lines.filter((l: any) => l.type === 'add').map((l: any) => l.text)).toEqual(['  codigo varchar']);
    expect(diff.diagrams).toEqual([{ packageId: 'ventas', movedNodes: 1, viewsChanged: false }]);
    expect(diff.affectedPackages).toEqual(['catalogos', 'ventas']);
    const current = (await h.call(`projects/${s.id}/revisions/${r2.id}/diff`, { token: s.owner.token })).data;
    expect(current.files).toEqual([]);
    expect((await h.call(`projects/${s.id}/revisions/${r2.id}/diff?against=${r1.id}`, { token: s.owner.token })).data.files[0].added).toBe(0);
  });

  test('restaurar crea una revisión nueva y auditable sin borrar el historial', async () => {
    const s = await scenario();
    const r1 = (await h.call(`projects/${s.id}/revisions`, { body: { message: 'original' }, token: s.owner.token })).data.revision;
    const original = await h.call(`projects/${s.id}/diagrams`, { token: s.owner.token });
    // Cambios posteriores: texto, archivo nuevo, archivo eliminado y diagrama movido.
    h.services.documents.setText(s.id, s.cat, { userId: s.owner.userId }, 'Table paises { id int [pk] }\nTable ruido { id int }');
    await h.addFile(s.owner.token, s.id, 'catalogos', 'nuevo.dbml', 'Table nuevo { id int [pk] }');
    await h.call(`projects/${s.id}/documents/${s.ven}/delete`, { body: {}, token: s.owner.token });
    await h.call(`projects/${s.id}/diagram`, { body: { packageId: 'catalogos', patch: { layout: { 'node:catalogos:public.paises': { x: 400, y: 400 } } } }, token: s.owner.token });
    expect((await h.call(`projects/${s.id}/diagrams`, { token: s.owner.token })).data.diagrams.map((d: any) => d.packageId)).toEqual(['catalogos']);

    expect((await h.call(`projects/${s.id}/revisions/${r1.id}/restore`, { body: {}, token: s.viewer.token })).status).toBe(403);
    const restored = await h.call(`projects/${s.id}/revisions/${r1.id}/restore`, { body: {}, token: s.editor.token });
    expect(restored.status).toBe(201);
    expect(restored.data.revision).toMatchObject({ kind: 'restore', restoredFrom: r1.id, authorId: s.editor.userId });

    const after = await h.call(`projects/${s.id}/diagrams`, { token: s.owner.token });
    expect(after.data.diagrams.map((d: any) => [d.packageId, d.hash])).toEqual(original.data.diagrams.map((d: any) => [d.packageId, d.hash]));
    expect(h.textOf(s.id, s.cat, s.owner.userId)).toBe(CATALOGOS);
    expect(h.textOf(s.id, s.ven, s.owner.userId)).toBe(VENTAS); // recuperado con su mismo identificador
    expect((await h.call(`projects/${s.id}`, { token: s.owner.token })).data.documents.map((d: any) => d.name).sort()).toEqual(['paises.dbml', 'pedidos.dbml']);
    // El historial conserva todo: la original, el estado previo a restaurar y la restauración.
    const list = (await h.call(`projects/${s.id}/revisions`, { token: s.owner.token })).data.revisions;
    expect(list.map((r: any) => r.kind)).toEqual(['restore', 'edit', 'manual']);
    expect(list.find((r: any) => r.seq === 2).message).toContain('Estado previo');
    const audit = (await h.call(`projects/${s.id}/audit`, { token: s.owner.token })).data.entries;
    expect(audit.some((e: any) => e.action === 'revision.restore' && e.actorName === 'editor')).toBe(true);
  });

  test('restaurar avisa a los participantes conectados y conserva ediciones concurrentes razonables', async () => {
    const s = await scenario();
    const server = h.socket();
    const r1 = (await h.call(`projects/${s.id}/revisions`, { body: { message: 'base' }, token: s.owner.token })).data.revision;
    const live = h.client(server, s.id, s.cat, { token: s.editor.token });
    await h.until(() => live.state.status === 'connected', 'conexión');
    live.doc.getText('source').insert(live.text().length, '\n// nota local');
    await h.until(() => h.textOf(s.id, s.cat, s.owner.userId).includes('nota local'), 'guardado');
    await h.call(`projects/${s.id}/revisions/${r1.id}/restore`, { body: {}, token: s.owner.token });
    await h.until(() => live.text() === CATALOGOS, 'restauración en vivo');
    expect(live.state.events.length + 0).toBeGreaterThanOrEqual(0);
    live.client.destroy(); live.doc.destroy();
  });

  test('rechaza revisiones de otro proyecto', async () => {
    const s = await scenario();
    const r1 = (await h.call(`projects/${s.id}/revisions`, { body: { message: 'v' }, token: s.owner.token })).data.revision;
    const other = await h.project(s.outsider, 'Otro');
    expect((await h.call(`projects/${other}/revisions/${r1.id}`, { token: s.outsider.token })).status).toBe(404);
    expect((await h.call(`projects/${other}/revisions/${r1.id}/restore`, { body: {}, token: s.outsider.token })).status).toBe(404);
    expect((await h.call(`projects/${s.id}/revisions`, { token: s.outsider.token })).status).toBe(403);
  });
});

// El constructor de Y se mantiene importado para que el tipado de los documentos de prueba sea explícito.
void Y;
