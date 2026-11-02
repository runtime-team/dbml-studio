import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject, matchesPattern, parseDiagramConfig } from '../src/project/loader';
import { compileProject } from '../src/project/compiler';
import { StudioError } from '../src/project/diagnostics';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function scaffold(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbml-proj-'));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return join(dir, 'dbml.project.yaml');
}

describe('proyectos y paquetes', () => {
  test('proyecto de un solo archivo', async () => {
    const manifest = await scaffold({ 'dbml.project.yaml': 'name: uno\nversion: 1\nsource:\n  packages: [app]\n', 'app/schema.dbml': 'Table t { id int [pk] }' });
    const project = await loadProject(manifest);
    expect(project.packages).toHaveLength(1);
    expect(project.packages[0]!.files.size).toBe(1);
    expect(compileProject(project).schema.schemas[0]!.tables).toHaveLength(1);
  });

  test('un paquete reúne varios archivos en un mismo modelo lógico', async () => {
    const manifest = await scaffold({
      'dbml.project.yaml': 'name: multi\nversion: 1\nsource:\n  packages: [ventas]\n',
      'ventas/a.dbml': 'Table a { id int [pk] }',
      'ventas/b.dbml': "use * from './a'\nTable b {\n id int [pk]\n a_id int [ref: > a.id]\n}",
    });
    const project = await loadProject(manifest);
    const compiled = compileProject(project);
    expect(project.packages[0]!.files.size).toBe(2);
    expect([...compiled.owners.values()]).toEqual(['ventas', 'ventas']);
    expect(compiled.schema.schemas[0]!.refs).toHaveLength(1);
  });

  test('descubre paquetes cuando no se listan y respeta exclude', async () => {
    const manifest = await scaffold({
      'dbml.project.yaml': 'name: auto\nversion: 1\nsource:\n  exclude: ["*.borrador.dbml", "legado"]\noutput:\n  directory: salida\n',
      'catalogos/p.dbml': 'Table p { id int [pk] }',
      'ventas/v.dbml': 'Table v { id int [pk] }',
      'ventas/roto.borrador.dbml': 'Table sin cerrar {',
      'legado/l.dbml': 'Table l { id int }',
      'salida/generado.dbml': 'Table g { id int }',
      'docs/ejemplo.dbml': 'Table d { id int }',
      '.oculto/x.dbml': 'Table x { id int }',
      'node_modules/m/m.dbml': 'Table m { id int }',
      'vacio/leeme.md': 'sin dbml',
    });
    const project = await loadProject(manifest);
    expect(project.packages.map(p => p.id)).toEqual(['catalogos', 'ventas']);
    expect([...project.packages[1]!.files.keys()].map(f => f.split(/[\\/]/).pop())).toEqual(['v.dbml']);
    expect(() => compileProject(project)).not.toThrow();
  });

  test('rechaza manifiestos inválidos con un diagnóstico', async () => {
    for (const body of ['name: x\nversion: 2\nsource: {}\n', 'version: 1\nsource: {}\n', 'name: x\nversion: 1\nsource:\n  packages: uno\n', 'name: x\nversion: 1\nsource: {}\noutput:\n  formats: [gif]\n', 'name: x\nversion: 1\nsource: {}\noptions:\n  sqlDialect: access\n', 'name: [\n']) {
      const manifest = await scaffold({ 'dbml.project.yaml': body });
      const error = await loadProject(manifest).then(() => undefined, e => e);
      expect(error).toBeInstanceOf(StudioError);
      expect((error as StudioError).diagnostics[0]!.code).toBe('STU020');
    }
  });

  test('detecta paquetes duplicados y nombres de paquete inválidos', async () => {
    const manifest = await scaffold({ 'dbml.project.yaml': 'name: x\nversion: 1\nsource:\n  packages: [a, a]\n', 'a/a.dbml': 'Table a { id int }' });
    await expect(loadProject(manifest)).rejects.toThrow('duplicado');
  });

  test('un diagram.yaml inválido nombra el archivo y el campo', async () => {
    const manifest = await scaffold({ 'dbml.project.yaml': 'name: x\nversion: 1\nsource:\n  packages: [a]\n', 'a/a.dbml': 'Table a { id int }', 'a/diagram.yaml': 'package: otro\n' });
    const error = await loadProject(manifest).then(() => undefined, e => e) as StudioError;
    expect(error.diagnostics[0]).toMatchObject({ code: 'STU018', filepath: 'a/diagram.yaml', packageId: 'a' });
  });

  test('parseDiagramConfig valida posiciones', () => {
    expect(parseDiagramConfig({ layout: { 'node:a:public.t': { x: 10, y: 20 } } }, 'a').layout).toBeDefined();
    for (const layout of [{ n: { x: -1, y: 0 } }, { n: { x: 'a', y: 0 } }, { n: null }, [] as unknown, { n: { x: Infinity, y: 0 } }])
      expect(() => parseDiagramConfig({ layout }, 'a')).toThrow(StudioError);
  });

  test('matchesPattern admite comodines simples', () => {
    expect(matchesPattern('*.borrador.dbml', 'x.borrador.dbml')).toBe(true);
    expect(matchesPattern('legado', 'legado')).toBe(true);
    expect(matchesPattern('legado', 'legado2')).toBe(false);
    expect(matchesPattern('a.b', 'aXb')).toBe(false);
  });
});
