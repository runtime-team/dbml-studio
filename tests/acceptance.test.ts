import { afterEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { buildProjectPath, parseProjectPath } from '../src/collaboration/links';
import { CATALOGOS, VENTAS, harness } from './collab-harness';

let h = harness();
afterEach(() => { h.close(); h = harness(); });

async function shared() {
  const owner = await h.account('owner'), editor = await h.account('editor'), viewer = await h.account('viewer');
  const id = await h.project(owner);
  await h.call(`projects/${id}/members`, { body: { username: 'editor', role: 'editor' }, token: owner.token });
  await h.call(`projects/${id}/members`, { body: { username: 'viewer', role: 'viewer' }, token: owner.token });
  const cat = await h.addFile(owner.token, id, 'catalogos', 'paises.dbml', CATALOGOS);
  const ven = await h.addFile(owner.token, id, 'ventas', 'pedidos.dbml', VENTAS);
  return { owner, editor, viewer, id, cat, ven, server: h.socket() };
}
const tableNames = async (id: string, token: string, pkg: string) =>
  ((await h.call(`projects/${id}/diagrams`, { token })).data.diagrams.find((d: any) => d.packageId === pkg)?.nodes ?? []).map((n: any) => `${n.kind}:${n.name}`).sort();

describe('Fase 8 — criterios de aceptación', () => {
  test('1. dos usuarios abren el mismo proyecto mediante enlace', async () => {
    const s = await shared();
    const link = (await h.call(`projects/${s.id}/links`, { body: { mode: 'view' }, token: s.owner.token })).data;
    const a = await h.call(`projects/${s.id}`, { token: s.owner.token });
    const b = await h.call(`projects/${s.id}`, { link: link.token });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.data.documents).toHaveLength(2);
    expect(b.data).toMatchObject({ editable: false, commentable: false, role: 'viewer' });
    // Ambos aparecen como presentes en el canal del proyecto.
    const x = h.client(s.server, s.id, undefined, { token: s.owner.token, editable: false });
    const y = h.client(s.server, s.id, undefined, { link: link.token, editable: false });
    await h.until(() => x.state.presence.length === 2 && y.state.presence.length === 2, 'presencia de dos usuarios');
    expect(x.state.presence.map((m: any) => m.name).sort()).toEqual(['owner', null].sort());
    x.client.destroy(); y.client.destroy();
  });

  test('2 y 3. dos usuarios editan a la vez el mismo archivo sin perder información', async () => {
    const s = await shared();
    const a = h.client(s.server, s.id, s.cat, { token: s.owner.token }), b = h.client(s.server, s.id, s.cat, { token: s.editor.token });
    await h.until(() => a.state.status === 'connected' && b.state.status === 'connected', 'conexiones');
    const ta = a.doc.getText('source'), tb = b.doc.getText('source');
    // Ediciones simultáneas en posiciones distintas y en la misma posición, de forma intercalada.
    for (let i = 0; i < 20; i++) {
      ta.insert(0, `// a${i}\n`);
      tb.insert(tb.length, `\n// b${i}`);
      if (i % 5 === 0) await Bun.sleep(5);
    }
    ta.insert(ta.toString().indexOf('nombre'), '/*A*/'); tb.insert(tb.toString().indexOf('nombre'), '/*B*/');
    await h.until(() => a.text() === b.text() && a.text().includes('// b19') && a.text().includes('// a19'), 'convergencia');
    const stored = h.textOf(s.id, s.cat, s.owner.userId);
    expect(stored).toBe(a.text());
    for (let i = 0; i < 20; i++) { expect(stored).toContain(`// a${i}\n`); expect(stored).toContain(`\n// b${i}`); }
    expect(stored).toContain('/*A*/'); expect(stored).toContain('/*B*/');
    expect(stored.match(/Table paises/g)).toHaveLength(1);
    a.client.destroy(); b.client.destroy();
  });

  test('4 y 11. los diagramas se actualizan tras cambios válidos y los cambios de un paquete se reflejan en otros', async () => {
    const s = await shared();
    expect(await tableNames(s.id, s.viewer.token, 'ventas')).toEqual(['external:paises', 'local:pedidos']);
    const channel = h.client(s.server, s.id, undefined, { token: s.viewer.token, editable: false });
    const editor = h.client(s.server, s.id, s.cat, { token: s.editor.token });
    await h.until(() => editor.state.status === 'connected' && channel.state.status === 'connected', 'conexiones');
    // Cambio válido en catalogos: se añade una columna a paises y una tabla nueva.
    const text = editor.doc.getText('source');
    text.insert(text.length, '\nTable monedas {\n  id int [pk]\n  pais_id int [ref: > paises.id]\n}');
    await h.until(() => channel.state.events.length >= 0 && h.textOf(s.id, s.cat, s.owner.userId).includes('monedas'), 'persistencia');
    const catalogos = (await h.call(`projects/${s.id}/diagrams`, { token: s.viewer.token })).data;
    expect(catalogos.ok).toBe(true);
    expect(await tableNames(s.id, s.viewer.token, 'catalogos')).toEqual(['local:monedas', 'local:paises']);
    // El paquete ventas sigue mostrando paises como referencia externa, con las columnas que ahora existen.
    text.insert(text.toString().indexOf('nombre'), 'codigo varchar\n  ');
    await h.until(() => h.textOf(s.id, s.cat, s.owner.userId).includes('codigo varchar'), 'segundo cambio');
    const ventas = (await h.call(`projects/${s.id}/diagrams`, { token: s.viewer.token })).data.diagrams.find((d: any) => d.packageId === 'ventas');
    expect(ventas.nodes.find((n: any) => n.tableId === 'public.paises').columns).toEqual(['id', 'codigo', 'nombre']);
    // Un cambio con errores no bloquea la edición y se conserva la última versión válida.
    text.insert(text.length, '\nTable roto {');
    await h.until(() => h.textOf(s.id, s.cat, s.owner.userId).includes('roto'), 'cambio inválido');
    const broken = (await h.call(`projects/${s.id}/diagrams`, { token: s.viewer.token })).data;
    expect(broken).toMatchObject({ ok: false, stale: true });
    expect(broken.diagnostics.some((d: any) => d.filepath === 'catalogos/paises.dbml' && d.packageId === 'catalogos')).toBe(true);
    expect(broken.diagrams.find((d: any) => d.packageId === 'ventas').nodes.find((n: any) => n.tableId === 'public.paises').columns).toEqual(['id', 'codigo', 'nombre']);
    editor.client.destroy(); channel.client.destroy();
  });

  test('5. un Viewer no puede modificar el proyecto (API ni tiempo real)', async () => {
    const s = await shared();
    const viewer = h.client(s.server, s.id, s.cat, { token: s.viewer.token, editable: true }); // intenta escribir aunque el cliente lo permita
    await h.until(() => viewer.state.status === 'connected', 'conexión');
    viewer.doc.getText('source').insert(0, '// intruso\n');
    await h.until(() => viewer.state.errors.includes('Acceso denegado'), 'rechazo');
    expect(h.textOf(s.id, s.cat, s.owner.userId)).toBe(CATALOGOS);
    expect((await h.call(`projects/${s.id}/diagram`, { body: { packageId: 'ventas', patch: { layout: { 'node:ventas:public.pedidos': { x: 1, y: 1 } } } }, token: s.viewer.token })).status).toBe(403);
    expect((await h.call(`projects/${s.id}/documents`, { body: { packageId: 'x', name: 'x.dbml', content: '' }, token: s.viewer.token })).status).toBe(403);
    viewer.client.destroy();
  });

  test('6. un enlace revocado deja de otorgar acceso, también a conexiones abiertas', async () => {
    const s = await shared();
    const link = (await h.call(`projects/${s.id}/links`, { body: { mode: 'view' }, token: s.owner.token })).data;
    const guest = h.client(s.server, s.id, s.cat, { link: link.token, editable: false });
    await h.until(() => guest.state.status === 'connected' && guest.text() === CATALOGOS, 'lectura por enlace');
    await h.call(`projects/${s.id}/links/${link.id}/revoke`, { body: {}, token: s.owner.token });
    await h.until(() => guest.state.status === 'offline', 'cierre de la conexión revocada');
    expect((await h.call(`projects/${s.id}`, { link: link.token })).status).toBe(403);
    expect((await h.call(`projects/${s.id}/diagrams`, { link: link.token })).status).toBe(403);
    guest.client.destroy();
    // Una conexión nueva con el enlace revocado es rechazada.
    const again = h.client(s.server, s.id, s.cat, { link: link.token, editable: false });
    await h.until(() => again.state.errors.includes('Acceso denegado'), 'rechazo de la reconexión');
    again.client.destroy();
  });

  test('7 y 12. se comparten enlaces directos a paquetes, tablas y conectores; los privados siguen cerrados', async () => {
    const s = await shared();
    await h.call(`projects/${s.id}/diagram`, { body: { packageId: 'ventas', patch: { views: { upsert: [{ table: 'public.paises', display: 'connector', id: 'c', label: 'CAT-01' }] } } }, token: s.editor.token });
    const diagrams = (await h.call(`projects/${s.id}/diagrams`, { token: s.viewer.token })).data.diagrams;
    const connector = diagrams.find((d: any) => d.packageId === 'ventas').connectors[0];
    const url = buildProjectPath({ projectId: s.id, packageId: 'ventas', tableId: 'public.pedidos', connectorId: connector.id });
    const [path, query] = url.split('?');
    const location = parseProjectPath(path!, `?${query}`)!;
    expect(location).toMatchObject({ projectId: s.id, packageId: 'ventas', tableId: 'public.pedidos', connectorId: connector.id });
    // El destino del enlace existe en el proyecto y el identificador no depende de nombres de archivo ni posiciones.
    const target = diagrams.find((d: any) => d.packageId === location.packageId);
    expect(target.nodes.some((n: any) => n.tableId === location.tableId)).toBe(true);
    expect(target.connectors.some((c: any) => c.id === location.connectorId)).toBe(true);
    expect(connector.id).not.toMatch(/\.dbml|"x":/);
    expect(url).not.toContain('pedidos.dbml');
    // Un tercero sin permiso no entra por el enlace directo.
    const stranger = await h.account('stranger');
    expect((await h.call(`projects/${location.projectId}/diagrams`, { token: stranger.token })).status).toBe(403);
    expect((await h.call(`projects/${location.projectId}/diagrams`)).status).toBe(403);
  });

  test('8. los comentarios permanecen asociados a su entidad', async () => {
    const s = await shared();
    const diagrams = (await h.call(`projects/${s.id}/diagrams`, { token: s.owner.token })).data.diagrams;
    const relation = diagrams.find((d: any) => d.packageId === 'ventas').relationships[0].id;
    await h.call(`projects/${s.id}/comments`, { body: { targetType: 'relationship', targetId: relation, packageId: 'ventas', body: '¿Debe ser obligatoria?' }, token: s.editor.token });
    // Se mueven las tablas, se renombra el paquete visual y se recompila: el comentario sigue apuntando a la misma relación.
    await h.call(`projects/${s.id}/diagram`, { body: { packageId: 'ventas', patch: { layout: { 'node:ventas:public.pedidos': { x: 640, y: 320 } } } }, token: s.owner.token });
    const found = (await h.call(`projects/${s.id}/comments?targetType=relationship&targetId=${encodeURIComponent(relation)}`, { token: s.viewer.token })).data.threads;
    expect(found).toHaveLength(1);
    const again = (await h.call(`projects/${s.id}/diagrams`, { token: s.owner.token })).data.diagrams.find((d: any) => d.packageId === 'ventas');
    expect(again.relationships.some((r: any) => r.id === found[0].targetId)).toBe(true);
  });

  test('9. la reconexión no provoca duplicación de cambios', async () => {
    const s = await shared();
    const first = h.client(s.server, s.id, s.cat, { token: s.owner.token });
    await h.until(() => first.state.status === 'connected', 'conexión');
    first.doc.getText('source').insert(0, '// marca única\n');
    await h.until(() => h.textOf(s.id, s.cat, s.owner.userId).includes('marca única'), 'guardado');
    // Se corta la conexión varias veces con ediciones pendientes entre medias.
    for (let i = 0; i < 3; i++) {
      (first.client as any).socket?.close();
      first.doc.getText('source').insert(first.doc.getText('source').length, `\n// offline ${i}`);
      await h.until(() => first.state.status === 'connected' && h.textOf(s.id, s.cat, s.owner.userId).includes(`offline ${i}`), `reconexión ${i}`);
    }
    const stored = h.textOf(s.id, s.cat, s.owner.userId);
    expect(stored.match(/marca única/g)).toHaveLength(1);
    for (let i = 0; i < 3; i++) expect(stored.match(new RegExp(`offline ${i}`, 'g'))).toHaveLength(1);
    expect(first.text()).toBe(stored);
    // Reenviar el mismo estado completo es idempotente.
    const replay = Y.encodeStateAsUpdate(first.doc);
    h.services.documents.apply(s.id, s.cat, { userId: s.owner.userId }, replay); h.services.documents.apply(s.id, s.cat, { userId: s.owner.userId }, replay);
    expect(h.textOf(s.id, s.cat, s.owner.userId)).toBe(stored);
    first.client.destroy();
  });

  test('10. el historial permite recuperar una versión anterior', async () => {
    const s = await shared();
    const v1 = (await h.call(`projects/${s.id}/revisions`, { body: { message: 'antes' }, token: s.owner.token })).data.revision;
    const editor = h.client(s.server, s.id, s.cat, { token: s.editor.token });
    await h.until(() => editor.state.status === 'connected', 'conexión');
    editor.doc.getText('source').insert(0, '// se borrará\n');
    await h.until(() => h.textOf(s.id, s.cat, s.owner.userId).includes('se borrará'), 'edición');
    // Cada edición recibida programa una revisión automática (aquí con espera nula) atribuida a quien editó.
    await h.until(async () => (await h.call(`projects/${s.id}/revisions`, { token: s.owner.token })).data.revisions.length >= 2, 'revisión automática');
    const [latest] = (await h.call(`projects/${s.id}/revisions`, { token: s.owner.token })).data.revisions;
    expect(latest).toMatchObject({ kind: 'edit', affectedPackages: ['catalogos'], authorName: 'editor' });
    expect((await h.call(`projects/${s.id}/revisions/${v1.id}/restore`, { body: {}, token: s.editor.token })).status).toBe(201);
    await h.until(() => editor.text() === CATALOGOS, 'el editor conectado recibe la restauración');
    expect(h.textOf(s.id, s.cat, s.owner.userId)).toBe(CATALOGOS);
    editor.client.destroy();
  });

  test('el estado compartido del diagrama llega a todos, mientras el estado personal no se sincroniza', async () => {
    const s = await shared();
    const watcher = h.client(s.server, s.id, undefined, { token: s.viewer.token, editable: false });
    await h.until(() => watcher.state.status === 'connected', 'conexión');
    await h.call(`projects/${s.id}/diagram`, { body: { packageId: 'ventas', patch: { layout: { 'node:ventas:public.pedidos': { x: 160, y: 96 } } } }, token: s.editor.token });
    await h.until(() => watcher.state.events.some(e => e.type === 'diagram-changed' && e.packageId === 'ventas'), 'evento de diagrama');
    const ventas = (await h.call(`projects/${s.id}/diagrams`, { token: s.viewer.token })).data.diagrams.find((d: any) => d.packageId === 'ventas');
    expect(ventas.layout).toEqual({ 'node:ventas:public.pedidos': { x: 160, y: 96 } });
    // Dos editores que mueven tablas distintas a la vez no se pisan.
    await Promise.all([
      h.call(`projects/${s.id}/diagram`, { body: { packageId: 'ventas', patch: { layout: { 'node:ventas:public.paises': { x: 8, y: 8 } } } }, token: s.editor.token }),
      h.call(`projects/${s.id}/diagram`, { body: { packageId: 'ventas', patch: { layout: { 'node:ventas:public.pedidos': { x: 640, y: 8 } } } }, token: s.owner.token }),
    ]);
    const merged = (await h.call(`projects/${s.id}/diagrams`, { token: s.viewer.token })).data.diagrams.find((d: any) => d.packageId === 'ventas').layout;
    expect(merged).toEqual({ 'node:ventas:public.paises': { x: 8, y: 8 }, 'node:ventas:public.pedidos': { x: 640, y: 8 } });
    // Zoom, pestaña activa y selección no tienen API de persistencia: ningún campo de estado personal se almacena.
    const stored = JSON.stringify(h.db.query('SELECT config FROM diagram_configs').all());
    expect(stored).not.toMatch(/zoom|selected|activeTab|scroll/i);
    watcher.client.destroy();
  });

  test('una configuración de diagrama que introduciría errores se rechaza y no se guarda', async () => {
    const s = await shared();
    const bad = await h.call(`projects/${s.id}/diagram`, { body: { packageId: 'ventas', patch: { views: { upsert: [{ table: 'public.no_existe', display: 'full', id: 'x' }] } } }, token: s.editor.token });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('Tabla externa inexistente');
    expect(h.db.query('SELECT COUNT(*) AS n FROM diagram_configs').get()).toEqual({ n: 0 });
    expect((await h.call(`projects/${s.id}/diagram`, { body: { packageId: '../x', patch: {} }, token: s.editor.token })).status).toBe(400);
  });

  test('exporta SVG, PDF y SQL de un proyecto compartido a quien puede leerlo', async () => {
    const s = await shared();
    const link = (await h.call(`projects/${s.id}/links`, { body: { mode: 'view' }, token: s.owner.token })).data;
    const svg = await h.api(new Request(`http://localhost/api/shared/projects/${s.id}/export/ventas.svg`, { headers: { 'x-share-token': link.token } }));
    expect(svg.status).toBe(200);
    expect(await svg.text()).toContain('<svg');
    const sql = await h.api(new Request(`http://localhost/api/shared/projects/${s.id}/export/schema.sql`, { headers: { authorization: `Bearer ${s.viewer.token}` } }));
    expect((await sql.text()).match(/CREATE TABLE/g)).toHaveLength(2);
    const pdf = await h.api(new Request(`http://localhost/api/shared/projects/${s.id}/export/all.pdf?size=A3`, { headers: { authorization: `Bearer ${s.viewer.token}` } }));
    expect(Buffer.from(await pdf.arrayBuffer()).toString('latin1').startsWith('%PDF-')).toBe(true);
    expect((await h.api(new Request(`http://localhost/api/shared/projects/${s.id}/export/schema.sql`))).status).toBe(403);
  });
});
