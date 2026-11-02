import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { join } from 'node:path';
import { loadProject, parseDiagramConfig } from '../src/project/loader';
import { ProjectBuilder } from '../src/project/build';
import { exportFromBuild } from '../src/project/export';
import { compileProject } from '../src/project/compiler';
import { makeProject } from './helpers';

const root = join(import.meta.dir, '..');
const examples = ['docs/ejemplos/proyecto-basico', 'docs/ejemplos/multiples-paquetes', 'docs/ejemplos/referencias-externas', 'docs/ejemplos/conectores', 'examples/empresa'];

describe('los ejemplos documentados usan sintaxis realmente implementada', () => {
  for (const example of examples) {
    test(`${example} compila sin errores y exporta SVG, PDF y SQL`, async () => {
      const project = await loadProject(join(root, example, 'dbml.project.yaml'));
      const build = new ProjectBuilder().build(project);
      expect(build.diagnostics.filter(d => d.severity !== 'warning')).toEqual([]);
      expect(build.ok).toBe(true);
      expect(build.diagrams).toHaveLength(project.packages.length);
      for (const diagram of build.diagrams) {
        expect(String((await exportFromBuild(build, { format: 'svg', packageId: diagram.packageId })).body)).toContain('<svg');
      }
      expect(Buffer.from((await exportFromBuild(build, { format: 'pdf' })).body as Uint8Array).toString('latin1').startsWith('%PDF-')).toBe(true);
      expect(String((await exportFromBuild(build, { format: 'sql' })).body)).toContain('CREATE TABLE');
    });
  }

  test('multiples-paquetes descubre los paquetes y excluye el borrador', async () => {
    const project = await loadProject(join(root, 'docs/ejemplos/multiples-paquetes/dbml.project.yaml'));
    expect(project.packages.map(p => p.id)).toEqual(['catalogos', 'empleados', 'ventas']);
    expect(project.packages.find(p => p.id === 'ventas')!.files.size).toBe(2);
    expect(project.manifest.options?.sqlDialect).toBe('postgres');
  });

  test('conectores y referencias-externas producen las representaciones descritas en el manual', async () => {
    const connectors = new ProjectBuilder().build(await loadProject(join(root, 'docs/ejemplos/conectores/dbml.project.yaml')));
    const ventas = connectors.diagrams.find(d => d.packageId === 'ventas')!;
    expect(ventas.connectors.map(c => c.label)).toEqual(['CAT-01', 'CAT-01']);
    expect(ventas.layout).toEqual({ 'node:ventas:public.pedidos': { x: 440, y: 96 } });
    const refs = new ProjectBuilder().build(await loadProject(join(root, 'docs/ejemplos/referencias-externas/dbml.project.yaml')));
    expect(refs.diagrams.find(d => d.packageId === 'ventas')!.nodes.filter(n => n.tableId === 'public.paises').map(n => n.display).sort()).toEqual(['compact', 'full']);
  });

  const docBlocks = async (language: string) => {
    const blocks: string[] = [];
    for (const doc of ['manual-usuario.md', 'referencia-sintaxis.md', 'arquitectura.md', 'guia-desarrollador.md']) {
      const text = (await readFile(join(root, 'docs', doc), 'utf8')).replace(/\r\n/g, '\n');
      blocks.push(...[...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))].map(m => m[1]!));
    }
    return blocks;
  };

  test('todos los bloques dbml de la documentación compilan', async () => {
    const blocks = await docBlocks('dbml');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      // Los bloques con `use` se comprueban dentro de un paquete vecino que aporta la tabla `paises`.
      const files: Record<string, Record<string, string>> = /\buse\b|\breuse\b/.test(block)
        ? { catalogos: { 'paises.dbml': 'Table paises {\n id int [pk]\n nombre varchar\n}' }, ventas: { 'pedidos.dbml': block } }
        : { doc: { 'doc.dbml': block } };
      expect(() => compileProject(makeProject(files)), block).not.toThrow();
    }
  });

  test('todos los bloques yaml de la documentación son manifiestos o diagram.yaml válidos', async () => {
    const blocks = await docBlocks('yaml');
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    let manifests = 0, diagrams = 0;
    for (const block of blocks) {
      const data = parse(block) as Record<string, any>;
      if ('version' in data) {
        manifests++;
        const dir = await mkdtemp(join(tmpdir(), 'dbml-doc-'));
        try {
          for (const id of data.source?.packages ?? []) { await mkdir(join(dir, id)); await writeFile(join(dir, id, 'a.dbml'), 'Table t { id int }'); }
          if (!data.source?.packages) { await mkdir(join(dir, 'x')); await writeFile(join(dir, 'x', 'a.dbml'), 'Table t { id int }'); }
          await writeFile(join(dir, 'dbml.project.yaml'), block);
          await expect(loadProject(join(dir, 'dbml.project.yaml')), block).resolves.toBeDefined();
        } finally { await rm(dir, { recursive: true, force: true }); }
      } else if ('package' in data || 'external' in data || 'layout' in data) {
        diagrams++;
        expect(() => parseDiagramConfig(data, data.package ?? 'ventas'), block).not.toThrow();
      }
    }
    expect(manifests).toBeGreaterThanOrEqual(2);
    expect(diagrams).toBeGreaterThanOrEqual(3);
  });

  test('los directorios de ejemplo no contienen archivos generados', async () => {
    for (const example of examples.slice(0, 4)) expect((await readdir(join(root, example))).includes('output')).toBe(false);
  });
});

describe('proyectos grandes', () => {
  test('compila cientos de tablas repartidas en varios paquetes en un tiempo razonable', () => {
    const packages: Record<string, Record<string, string>> = {};
    const perPackage = 25, count = 16; // 400 tablas
    for (let p = 0; p < count; p++) {
      const lines: string[] = [];
      for (let t = 0; t < perPackage; t++) {
        const fk = t > 0 ? `\n  prev int [ref: > t${p}_${t - 1}.id]` : p > 0 ? `\n  ext int [ref: > t${p - 1}_0.id]` : '';
        lines.push(`Table t${p}_${t} {\n  id int [pk]${fk}\n  nombre varchar\n}`);
      }
      const imports = p > 0 ? `use * from '../pk${p - 1}/schema'\n` : '';
      packages[`pk${p}`] = { 'schema.dbml': imports + lines.join('\n') };
    }
    const builder = new ProjectBuilder();
    const started = performance.now();
    const result = builder.build(makeProject(packages));
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    expect(result.diagrams).toHaveLength(count);
    expect(result.compiled!.schema.schemas.flatMap(s => s.tables)).toHaveLength(perPackage * count);
    expect(elapsed).toBeLessThan(20_000);
    // La segunda construcción con los mismos datos es inmediata (caché).
    builder.build(makeProject(packages));
    expect(builder.stats.compiles).toBe(1); // mismo contenido → misma clave de caché
  }, 60_000);
});
