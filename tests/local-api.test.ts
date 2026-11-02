import { afterEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createLocalApi } from '../src/server/local';
import { pdfText } from './helpers';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dbml-local-'));
  dirs.push(dir);
  await cp(join(import.meta.dir, '..', 'docs', 'ejemplos', 'referencias-externas'), dir, { recursive: true });
  const api = createLocalApi({ manifest: join(dir, 'dbml.project.yaml'), port: 3001, workspaceRoot: dir });
  const origin = 'http://localhost:5173';
  const get = (path: string, headers: Record<string, string> = {}) => api(new Request(`http://localhost:3001${path}`, { headers }));
  const post = (path: string, body: unknown, headers: Record<string, string> = { origin }) => api(new Request(`http://localhost:3001${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { dir, api, get, post };
}
type State = { ok: boolean; stale: boolean; files: { packageId: string; filename: string; content: string; revision: string }[]; configs: Record<string, { revision: string }>; diagrams: { packageId: string; nodes: { id: string; display: string; tableId: string }[]; layout?: Record<string, unknown> }[]; diagnostics: { code?: string; severity?: string; filepath?: string }[] };

describe('API local', () => {
  test('descubre manifiestos de proyecto dentro del espacio de trabajo', async () => {
    const { dir, get } = await setup();
    const other = join(dir, 'examples', 'empresa');
    await cp(join(import.meta.dir, '..', 'examples', 'empresa'), other, { recursive: true });
    const response = await get('/api/projects');
    expect(response.status).toBe(200);
    const result = await response.json() as { workspaceRoot: string; projects: { name: string; manifestPath: string; relativePath: string; packages: number }[] };
    expect(result.workspaceRoot).toBe(dir);
    expect(result.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'referencias-externas', relativePath: 'dbml.project.yaml', packages: 2 }),
      expect.objectContaining({ name: 'empresa', relativePath: 'examples/empresa/dbml.project.yaml' }),
    ]));
  });

  test('abre manifiestos locales por ruta y mantiene aislado el proyecto de cada pestaña', async () => {
    const { dir, get, post } = await setup();
    const other = join(dir, 'otro-proyecto');
    await cp(join(import.meta.dir, '..', 'examples', 'empresa'), other, { recursive: true });
    const manifestPath = join(other, 'dbml.project.yaml');
    const opened = await post('/api/projects/open', { manifestPath });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ name: 'empresa', manifestPath });
    const scoped = await get('/api/project', { 'x-dbml-manifest': manifestPath });
    expect(scoped.status).toBe(200);
    expect((await scoped.json() as State & { manifestPath: string }).manifestPath).toBe(manifestPath);
    const defaultProject = await get('/api/project');
    expect((await defaultProject.json() as State & { manifestPath: string }).manifestPath).toBe(join(dir, 'dbml.project.yaml'));
  });

  test('crea un proyecto de inicio sin sobrescribir carpetas con contenido', async () => {
    const { dir, post } = await setup();
    const target = join(dir, 'nuevo-proyecto');
    const created = await post('/api/projects/create', { name: 'Nuevo proyecto', directory: target });
    expect(created.status).toBe(201);
    const state = await created.json() as State & { name: string; manifestPath: string };
    expect(state).toMatchObject({ name: 'Nuevo proyecto', manifestPath: join(target, 'dbml.project.yaml'), ok: true });
    expect(state.diagrams.map(d => d.packageId)).toEqual(['principal']);
    expect(await readFile(join(target, 'principal', 'schema.dbml'), 'utf8')).toContain('Table ejemplo');

    const occupied = join(dir, 'ocupado');
    await mkdir(occupied);
    await writeFile(join(occupied, 'conservar.txt'), 'no tocar');
    const rejected = await post('/api/projects/create', { name: 'No sobrescribir', directory: occupied });
    expect(rejected.status).toBe(409);
    expect(await readFile(join(occupied, 'conservar.txt'), 'utf8')).toBe('no tocar');
  });

  test('crea proyectos en la carpeta projects del espacio de trabajo sin pedir ruta', async () => {
    const { dir, post } = await setup();
    const target = join(dir, 'projects', 'nuevo-proyecto');
    const response = await post('/api/projects/create', { name: 'Nuevo proyecto' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: 'Nuevo proyecto', manifestPath: join(target, 'dbml.project.yaml'), ok: true });
    expect(await readFile(join(target, 'principal', 'schema.dbml'), 'utf8')).toContain('Table ejemplo');
  });
  test('entrega el proyecto compilado con diagramas, diagnósticos y revisiones', async () => {
    const { get } = await setup();
    const response = await get('/api/project');
    expect(response.status).toBe(200);
    const state = await response.json() as State;
    expect(state.ok).toBe(true);
    expect(state.diagrams.map(d => d.packageId)).toEqual(['catalogos', 'ventas']);
    expect(state.files.every(f => /^[0-9a-f]{64}$/.test(f.revision))).toBe(true);
    expect(state.configs.ventas!.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(state.diagrams.find(d => d.packageId === 'ventas')!.nodes.filter(n => n.tableId === 'public.paises').map(n => n.display).sort()).toEqual(['compact', 'full']);
  });

  test('guarda cambios con control de revisión y devuelve errores sin perder el trabajo a medias', async () => {
    const { get, post, dir } = await setup();
    const state = await (await get('/api/project')).json() as State;
    const file = state.files.find(f => f.filename === 'pedidos.dbml')!;
    const saved = await post('/api/save', { packageId: 'ventas', filename: 'pedidos.dbml', content: file.content + '\nTable nueva { id int [pk] }', revision: file.revision });
    expect(saved.status).toBe(200);
    expect(await readFile(join(dir, 'ventas', 'pedidos.dbml'), 'utf8')).toContain('Table nueva');
    // Revisión obsoleta → conflicto.
    const stale = await post('/api/save', { packageId: 'ventas', filename: 'pedidos.dbml', content: 'x', revision: file.revision });
    expect(stale.status).toBe(409);
    // Un texto que no compila se guarda igualmente y se informa.
    const fresh = (await (await get('/api/project')).json() as State).files.find(f => f.filename === 'pedidos.dbml')!;
    const broken = await post('/api/save', { packageId: 'ventas', filename: 'pedidos.dbml', content: 'Table {', revision: fresh.revision });
    const brokenState = await broken.json() as State;
    expect(broken.status).toBe(200);
    expect(brokenState.ok).toBe(false);
    expect(brokenState.stale).toBe(true);
    expect(brokenState.diagrams.length).toBe(2);
    expect(brokenState.diagnostics.some(d => d.severity !== 'warning' && d.filepath === 'ventas/pedidos.dbml')).toBe(true);
    expect(await readFile(join(dir, 'ventas', 'pedidos.dbml'), 'utf8')).toBe('Table {');
  });

  test('la vista previa compila el borrador sin escribir en disco ni alterar las revisiones', async () => {
    const { get, post, dir } = await setup();
    const state = await (await get('/api/project')).json() as State;
    const file = state.files.find(f => f.filename === 'pedidos.dbml')!;
    const before = await readFile(join(dir, 'ventas', 'pedidos.dbml'), 'utf8');
    const preview = await (await post('/api/preview', { packageId: 'ventas', filename: 'pedidos.dbml', content: 'Table {' })).json() as State;
    expect(preview.ok).toBe(false);
    expect(preview.files.find(f => f.filename === 'pedidos.dbml')).toMatchObject({ revision: file.revision, content: before });
    expect(await readFile(join(dir, 'ventas', 'pedidos.dbml'), 'utf8')).toBe(before);
  });

  test('persiste posiciones y cambios de modo en diagram.yaml y detecta conflictos', async () => {
    const { get, post, dir } = await setup();
    const state = await (await get('/api/project')).json() as State;
    const revision = state.configs.ventas!.revision;
    const moved = await post('/api/diagram', { packageId: 'ventas', revision, patch: { layout: { 'node:ventas:public.pedidos': { x: 400, y: 120 } } } });
    expect(moved.status).toBe(200);
    const yaml = parse(await readFile(join(dir, 'ventas', 'diagram.yaml'), 'utf8'));
    expect(yaml).toMatchObject({ package: 'ventas', layout: { 'node:ventas:public.pedidos': { x: 400, y: 120 } } });
    expect(yaml.external).toHaveLength(2);
    const after = await moved.json() as State;
    expect(after.diagrams.find(d => d.packageId === 'ventas')!.layout).toEqual({ 'node:ventas:public.pedidos': { x: 400, y: 120 } });
    // La revisión anterior ya no es vigente.
    const conflict = await post('/api/diagram', { packageId: 'ventas', revision, patch: { layout: { 'node:ventas:public.pedidos': { x: 8, y: 8 } } } });
    expect(conflict.status).toBe(409);
    // Cambiar a conector y restablecer.
    const connector = await post('/api/diagram', { packageId: 'ventas', revision: after.configs.ventas!.revision, patch: { views: { upsert: [{ table: 'public.paises', display: 'connector', id: 'resumen', label: 'CAT-01' }] } } });
    expect(connector.status).toBe(200);
    expect((await connector.json() as State).diagrams.find(d => d.packageId === 'ventas')!.nodes.some(n => n.display === 'connector')).toBe(true);
  });

  test('rechaza configuraciones que introducirían errores y no escribe nada', async () => {
    const { get, post, dir } = await setup();
    const state = await (await get('/api/project')).json() as State;
    const before = await readFile(join(dir, 'ventas', 'diagram.yaml'), 'utf8');
    const response = await post('/api/diagram', { packageId: 'ventas', revision: state.configs.ventas!.revision, patch: { views: { upsert: [{ table: 'public.no_existe', display: 'full', id: 'x' }] } } });
    expect(response.status).toBe(422);
    expect((await response.json() as { error: string }).error).toContain('Tabla externa inexistente');
    expect(await readFile(join(dir, 'ventas', 'diagram.yaml'), 'utf8')).toBe(before);
    const malformed = await post('/api/diagram', { packageId: 'ventas', revision: state.configs.ventas!.revision, patch: { layout: { malo: { x: 1, y: 1 } } } });
    expect(malformed.status).toBe(400);
  });

  test('exige origen y host locales y tipo de contenido JSON para escribir', async () => {
    const { get, post } = await setup();
    expect((await post('/api/save', {}, {})).status).toBe(403);
    expect((await post('/api/save', {}, { origin: 'https://malo.example' })).status).toBe(403);
    expect((await get('/api/project', { host: 'malo.example' })).status).toBe(403);
    expect((await get('/api/project', { host: 'localhost:3001' })).status).toBe(200);
    const { api } = await setup();
    const noType = await api(new Request('http://localhost:3001/api/save', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: '{}' }));
    expect(noType.status).toBe(400);
  });

  test('limita el cuerpo local por bytes antes de decodificar JSON', async () => {
    const { api } = await setup();
    const response = await api(new Request('http://localhost:3001/api/preview', {
      method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ packageId: 'ventas', filename: 'pedidos.dbml', content: '😀'.repeat(300_000) }),
    }));
    expect(response.status).toBe(413);
  });

  test('exporta SVG, PDF, SQL y entrega la definición de una tabla', async () => {
    const { get } = await setup();
    const svg = await get('/api/export/ventas.svg');
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(svg.headers.get('content-disposition')).toContain('ventas.svg');
    expect(await svg.text()).toContain('data-node');
    const pdf = new Uint8Array(await (await get('/api/export/all.pdf?size=A3&orientation=portrait')).arrayBuffer());
    expect(pdfText(pdf)).toContain('pais_facturacion');
    expect(Buffer.from(pdf).toString('latin1')).toContain('/MediaBox [0 0 841.89 1190.55]');
    const sql = await (await get('/api/export/schema.sql')).text();
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(2);
    expect((await get('/api/export/nada.exe')).status).toBe(404);
    expect((await get('/api/export/all.pdf?size=A0')).status).toBe(422);
    const definition = await (await get('/api/definition?table=public.paises')).json() as { file: string; line: number; source: string; packageId: string };
    expect(definition).toMatchObject({ file: 'catalogos/paises.dbml', line: 1, packageId: 'catalogos' });
    expect(definition.source).toContain('continente varchar');
    expect((await get('/api/definition?table=public.nada')).status).toBe(404);
  });

  test('un manifiesto roto responde con un diagnóstico claro', async () => {
    const { dir, get } = await setup();
    await writeFile(join(dir, 'dbml.project.yaml'), 'name: x\nversion: 9\nsource: {}\n');
    const response = await get('/api/project');
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('Manifiesto inválido');
  });
});
