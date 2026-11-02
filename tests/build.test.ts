import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ProjectBuilder } from '../src/project/build';
import { compileProject } from '../src/project/compiler';
import { compileDiagrams } from '../src/diagram/model';
import { exportFromBuild, ExportError } from '../src/project/export';
import { renderPdf } from '../src/diagram/pdf';
import { renderSvg } from '../src/diagram/svg';
import { applyDiagramPatch, serializeDiagramConfig, validatePatch } from '../src/project/diagram-config';
import { parse } from 'yaml';
import { EMPRESA, makeProject, pdfText } from './helpers';

const fileOf = (project: ReturnType<typeof makeProject>, pkg: string, name: string) => join(project.root, pkg, name);

describe('compilación incremental y caché', () => {
  test('sin cambios no recompila; un cambio visual solo reconstruye diagramas', () => {
    const project = makeProject(EMPRESA);
    const builder = new ProjectBuilder();
    const first = builder.build(project);
    expect(builder.build(project)).toBe(first);
    expect(builder.stats).toEqual({ compiles: 1, diagramBuilds: 1 });
    project.packages.find(p => p.id === 'ventas')!.diagram = { layout: { 'node:ventas:public.pedidos': { x: 100, y: 100 } } };
    const moved = builder.build(project);
    expect(builder.stats).toEqual({ compiles: 1, diagramBuilds: 2 });
    expect(moved.changedPackages).toEqual(['ventas']);
  });

  test('un cambio en un paquete solo marca como modificados los diagramas afectados', () => {
    const project = makeProject(EMPRESA);
    const builder = new ProjectBuilder();
    builder.build(project);
    const file = fileOf(project, 'empleados', 'empleados.dbml');
    project.packages.find(p => p.id === 'empleados')!.files.set(file, project.packages.find(p => p.id === 'empleados')!.files.get(file)! + '\nTable otro { id int [pk] }');
    const next = builder.build(project);
    expect(builder.stats.compiles).toBe(2);
    expect(next.changedPackages).toEqual(['empleados']);
    expect(next.diagrams.find(d => d.packageId === 'ventas')!.hash).toBe(builder.build(project).diagrams.find(d => d.packageId === 'ventas')!.hash);
  });

  test('con errores de sintaxis se conserva la última versión válida y se informan los errores', () => {
    const project = makeProject(EMPRESA);
    const builder = new ProjectBuilder();
    const good = builder.build(project);
    const pkg = project.packages.find(p => p.id === 'catalogos')!;
    const file = fileOf(project, 'catalogos', 'paises.dbml');
    pkg.files.set(file, 'Table paises {\n id int [pk]\n');
    const broken = builder.build(project);
    expect(broken.ok).toBe(false);
    expect(broken.stale).toBe(true);
    expect(broken.diagrams).toEqual(good.diagrams);
    expect(broken.diagnostics.some(d => d.severity !== 'warning' && d.packageId === 'catalogos')).toBe(true);
    // Al corregirlo se vuelve a una compilación normal.
    pkg.files.set(file, EMPRESA.catalogos['paises.dbml']);
    const fixed = builder.build(project);
    expect(fixed.ok).toBe(true);
    expect(fixed.stale).toBe(false);
    expect(fixed.changedPackages).toEqual([]);
  });

  test('si nunca hubo una versión válida no hay diagramas obsoletos que mostrar', () => {
    const project = makeProject({ a: { 'a.dbml': 'Table {' } });
    const result = new ProjectBuilder().build(project);
    expect(result).toMatchObject({ ok: false, stale: false, diagrams: [] });
  });
});

describe('generación determinista y exportación', () => {
  test('dos compilaciones del mismo proyecto producen el mismo SQL, SVG y huellas', () => {
    const a = new ProjectBuilder().build(makeProject(EMPRESA)), b = new ProjectBuilder().build(makeProject(EMPRESA));
    expect(a.compiled!.exportSql()).toBe(b.compiled!.exportSql());
    expect(a.diagrams.map(d => [d.hash, renderSvg(d)])).toEqual(b.diagrams.map(d => [d.hash, renderSvg(d)]));
  });

  test('el orden de los archivos no altera el resultado', () => {
    const reversed = { ...EMPRESA, ventas: Object.fromEntries(Object.entries(EMPRESA.ventas).reverse()) };
    const a = new ProjectBuilder().build(makeProject(EMPRESA)), b = new ProjectBuilder().build(makeProject(reversed));
    expect(a.diagrams.map(d => d.hash)).toEqual(b.diagrams.map(d => d.hash));
  });

  test('el SQL se genera solo del modelo lógico: sin duplicar tablas aunque haya vistas externas', () => {
    const project = makeProject(EMPRESA, { ventas: { external: [{ table: 'public.paises', display: 'full', id: 'a' }, { table: 'public.paises', display: 'compact', show: ['id'], id: 'b' }, { table: 'public.paises', display: 'connector', id: 'c' }] } });
    const build = new ProjectBuilder().build(project);
    const sql = build.compiled!.exportSql();
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(5);
    expect(sql.match(/CREATE TABLE "paises"/g)).toHaveLength(1);
    expect(sql).not.toContain('node:');
    expect(build.compiled!.exportSql('mysql')).toContain('CREATE TABLE');
  });

  test('exportFromBuild entrega SVG, PDF y SQL y rechaza peticiones inválidas', async () => {
    const build = new ProjectBuilder().build(makeProject(EMPRESA));
    const svg = await exportFromBuild(build, { format: 'svg', packageId: 'ventas' });
    expect(svg).toMatchObject({ contentType: expect.stringContaining('image/svg+xml'), filename: 'ventas.svg' });
    expect(String(svg.body)).toContain('<svg');
    const pdf = await exportFromBuild(build, { format: 'pdf', size: 'A3', orientation: 'portrait' });
    expect(Buffer.from(pdf.body as Uint8Array).toString('latin1')).toMatch(/^%PDF-/);
    expect((await exportFromBuild(build, { format: 'sql' })).filename).toBe('proyecto.sql');
    await expect(exportFromBuild(build, { format: 'svg' })).rejects.toBeInstanceOf(ExportError);
    await expect(exportFromBuild(build, { format: 'pdf', packageId: 'nada' })).rejects.toThrow('no existe');
    await expect(exportFromBuild(build, { format: 'pdf', size: 'A0' })).rejects.toThrow('Tamaño');
    await expect(exportFromBuild(build, { format: 'sql', dialect: 'access' })).rejects.toThrow('Dialecto');
    await expect(exportFromBuild(new ProjectBuilder().build(makeProject({ a: { 'a.dbml': 'Table {' } })), { format: 'sql' })).rejects.toThrow('errores de compilación');
  });

  test('el PDF imprime la referencia del conector con la página del diagrama destino', async () => {
    const project = makeProject(EMPRESA, { ventas: { external: [{ table: 'public.paises', display: 'connector', label: 'CAT-01', id: 'c' }] } });
    const build = new ProjectBuilder().build(project);
    const bytes = await renderPdf(build.diagrams);
    const text = pdfText(bytes);
    // Páginas: catalogos (1), empleados (2), ventas (3); el conector apunta a catalogos, que empieza en la página 1.
    expect(text).toContain('CAT-01 · p. 1');
    expect(text).toContain('Paquete: catalogos');
    expect(text).toContain('Tabla: paises');
    expect(Buffer.from(bytes).toString('latin1')).toContain('/Outlines');
  });
});

describe('parches de configuración de diagramas', () => {
  test('aplica posiciones, vistas y renombrado de nodos sin mutar la configuración original', () => {
    const original = { layout: { 'node:v:public.t': { x: 8, y: 8 } }, external: [{ table: 'public.p', display: 'full' as const }] };
    const next = applyDiagramPatch(original, {
      layout: { 'node:v:public.u': { x: 10.4, y: 20.6 }, 'node:v:public.t': null },
      renameNodes: { 'node:v:public.p:0': 'node:v:public.p:main' },
      views: { upsert: [{ table: 'public.p', display: 'compact', show: ['id'], id: 'main' }] },
    });
    expect(next.layout).toEqual({ 'node:v:public.u': { x: 10, y: 21 } });
    expect(next.external).toEqual([{ table: 'public.p', display: 'compact', show: ['id'], id: 'main' }]);
    expect(original.layout['node:v:public.t']).toEqual({ x: 8, y: 8 });
    expect(original.external).toHaveLength(1);
  });

  test('una vista sin id adopta el id al actualizarse, y las vistas se pueden quitar', () => {
    const next = applyDiagramPatch({ external: [{ table: 'public.p', display: 'full' }] }, { views: { upsert: [{ table: 'public.p', display: 'connector', id: 'enlace' }] } });
    expect(next.external).toHaveLength(1);
    expect(next.external![0]!.id).toBe('enlace');
    expect(applyDiagramPatch(next, { views: { remove: ['enlace'] } }).external).toEqual([]);
  });

  test('valida estrictamente los parches recibidos de clientes no confiables', () => {
    const bad = [
      null, [], { layout: { 'no-es-un-nodo': { x: 1, y: 1 } } }, { layout: { 'node:a:b': { x: -5, y: 1 } } }, { layout: { 'node:a:b': { x: 1e9, y: 1 } } },
      { layout: { 'node:a:b': { x: NaN, y: 1 } } }, { views: { upsert: [{ table: 'public.t', display: 'raro', id: 'x' }] } }, { views: { upsert: [{ table: 'public.t', display: 'full' }] } },
      { views: { upsert: [{ table: 'public.t', display: 'full', id: 'con espacios' }] } }, { views: { upsert: [{ table: 'public.t', display: 'compact', id: 'x', show: [1] }] } },
      { views: { remove: [5] } }, { renameNodes: { 'node:a:b': 'otra' } }, { views: { upsert: [{ table: 'x'.repeat(500), display: 'full', id: 'x' }] } },
    ];
    for (const patch of bad) expect(() => validatePatch(patch)).toThrow();
    expect(() => validatePatch({ layout: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`node:a:t${i}`, { x: 1, y: 1 }])) })).toThrow('demasiado grande');
  });

  test('serializa YAML estable que vuelve a cargarse igual', () => {
    const config = { external: [{ table: 'public.p', display: 'compact' as const, show: ['id'], id: 'a', label: undefined }], layout: { 'node:v:public.b': { x: 2, y: 4 }, 'node:v:public.a': { x: 1, y: 3 } } };
    const text = serializeDiagramConfig(config, 'v');
    expect(text.indexOf('node:v:public.a')).toBeLessThan(text.indexOf('node:v:public.b'));
    expect(text).not.toContain('label');
    expect(parse(text)).toEqual({ package: 'v', external: [{ table: 'public.p', display: 'compact', show: ['id'], id: 'a' }], layout: { 'node:v:public.a': { x: 1, y: 3 }, 'node:v:public.b': { x: 2, y: 4 } } });
  });
});

describe('compatibilidad con DBML estándar', () => {
  const standard = `
Project tienda { database_type: 'PostgreSQL' }
Enum estado { activo\n inactivo }
Table usuarios [headercolor: #3498DB] {
  id int [pk, increment]
  nombre varchar(80) [not null, note: 'Nombre completo']
  estado estado [default: 'activo']
  indexes { (nombre, estado) [name: 'idx_n'] }
}
Table posts { id int [pk]\n autor int [not null] }
Ref fk_autor: posts.autor > usuarios.id [delete: cascade]
TableGroup contenido { posts }
`;
  test('un proyecto DBML estándar sin extensiones compila y conserva su semántica', () => {
    const project = makeProject({ unico: { 'schema.dbml': standard } });
    const compiled = compileProject(project);
    const schema = compiled.schema.schemas[0]!;
    expect(schema.tables.map(t => t.name).sort()).toEqual(['posts', 'usuarios']);
    expect(schema.enums.map(e => e.name)).toEqual(['estado']);
    expect(schema.tableGroups.map(g => g.name)).toEqual(['contenido']);
    expect(schema.refs[0]!.name).toBe('fk_autor');
    const sql = compiled.exportSql();
    expect(sql).toContain('CREATE TYPE "estado"');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('CREATE INDEX "idx_n"');
    const diagram = compileDiagrams(project, compiled)[0]!;
    expect(diagram.relationships[0]).toMatchObject({ name: 'fk_autor', foreignKey: { tableId: 'public.posts' }, references: { tableId: 'public.usuarios' } });
  });

  test('la compilación a DBML estándar aplanado conserva el esquema lógico completo', async () => {
    const build = new ProjectBuilder().build(makeProject(EMPRESA, { ventas: { external: [{ table: 'public.paises', display: 'connector', id: 'c' }] } }));
    const flat = (await exportFromBuild(build, { format: 'dbml' })).body as string;
    expect(flat).not.toMatch(/\buse\b|\breuse\b/);
    expect(flat.match(/^Table /gm)).toHaveLength(5);
    // Volver a compilarlo como un único archivo produce exactamente el mismo SQL.
    const again = compileProject(makeProject({ plano: { 'schema.dbml': flat } }));
    expect(again.exportSql()).toBe(build.compiled!.exportSql());
    expect(again.exportDbml()).toBe(flat);
  });

  test('el esquema lógico es el mismo si el DBML está en un archivo o repartido en paquetes', () => {
    const single = compileProject(makeProject({ todo: { 'a.dbml': 'Table a { id int [pk] }\nTable b {\n id int [pk]\n a_id int [ref: > a.id]\n}' } }));
    const split = compileProject(makeProject({ p1: { 'a.dbml': 'Table a { id int [pk] }' }, p2: { 'b.dbml': "use * from '../p1/a'\nTable b {\n id int [pk]\n a_id int [ref: > a.id]\n}" } }));
    expect(split.exportSql()).toBe(single.exportSql());
  });
});
