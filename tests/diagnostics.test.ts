import { describe, expect, test } from 'bun:test';
import { compileProject, findCycles, resolveImport } from '../src/project/compiler';
import { ProjectCompileError, formatDiagnostic } from '../src/project/diagnostics';
import { makeProject } from './helpers';

const failure = (packages: Record<string, Record<string, string>>) => {
  try { compileProject(makeProject(packages)); } catch (error) { if (error instanceof ProjectCompileError) return error; throw error; }
  throw new Error('se esperaba un error de compilación');
};

describe('diagnósticos', () => {
  test('una tabla duplicada se reporta en el archivo real con la definición original', () => {
    const error = failure({ a: { 'a.dbml': 'Table x { id int }' }, b: { 'b.dbml': '\n\nTable x { id int }' } });
    const d = error.diagnostics[0]!;
    expect(d.code).toBe('STU001');
    expect(d.filepath).toBe('b/b.dbml');
    expect(d.location?.start?.line).toBe(3);
    expect(d.packageId).toBe('b');
    expect(d.message).toContain('a/a.dbml');
    expect(d.suggestion).toContain('use');
    expect(formatDiagnostic(d)).toContain('b/b.dbml:3');
  });

  test('una referencia a una tabla de otro archivo sin importarla sugiere el use exacto', () => {
    const error = failure({ catalogos: { 'paises.dbml': 'Table paises { id int [pk] }' }, ventas: { 'pedidos.dbml': 'Table pedidos {\n id int [pk]\n pais_id int [ref: > paises.id]\n}' } });
    const d = error.diagnostics[0]!;
    expect(d.code).toBe('STU003');
    expect(d.filepath).toBe('ventas/pedidos.dbml');
    expect(d.location?.start?.line).toBe(3);
    expect(d.suggestion).toContain("use * from '../catalogos/paises'");
    expect(d.message).toContain('catalogos');
  });

  test('una referencia a una tabla inexistente indica que no existe en ningún paquete', () => {
    const error = failure({ a: { 'a.dbml': 'Table a {\n id int [ref: > fantasma.id]\n}' } });
    expect(error.diagnostics[0]!.suggestion).toContain('fantasma');
    expect(error.diagnostics[0]!.filepath).toBe('a/a.dbml');
  });

  test('un nombre que existe en varios esquemas es ambiguo y se sugiere calificarlo', () => {
    const error = failure({
      a: { 'a.dbml': 'Table s1.x { id int [pk] }' },
      b: { 'b.dbml': 'Table s2.x { id int [pk] }' },
      c: { 'c.dbml': "use * from '../a/a'\nuse * from '../b/b'\nTable y {\n id int [pk]\n x_id int [ref: > x.id]\n}" },
    });
    const d = error.diagnostics[0]!;
    expect(d.code).toBe('STU002');
    expect(d.message).toContain('s1.x');
    expect(d.message).toContain('s2.x');
    expect(d.suggestion).toContain('Califica');
  });

  test('un error de sintaxis conserva archivo, línea y columna', () => {
    const error = failure({ a: { 'a.dbml': 'Table a {\n id int\n' } });
    const d = error.diagnostics[0]!;
    expect(d.filepath).toBe('a/a.dbml');
    expect(d.location?.start?.line).toBeGreaterThan(0);
    expect(d.packageId).toBe('a');
  });

  test('los ciclos de importación entre archivos son una advertencia, no un error', () => {
    const compiled = compileProject(makeProject({
      a: { 'a.dbml': "use * from '../b/b'\nTable ta { id int [pk] }" },
      b: { 'b.dbml': "use * from '../a/a'\nTable tb {\n id int [pk]\n a_id int [ref: > ta.id]\n}" },
    }));
    expect(compiled.schema.schemas.flatMap(s => s.tables)).toHaveLength(2);
    expect(compiled.warnings).toHaveLength(1);
    expect(compiled.warnings[0]).toMatchObject({ code: 'STU004', severity: 'warning' });
    expect(compiled.warnings[0]!.message).toContain('a/a.dbml');
  });

  test('findCycles detecta componentes y autociclos sin desbordar la pila', () => {
    const edges = new Map<string, string[]>([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['d']], ['e', ['a']]]);
    expect(findCycles(['a', 'b', 'c', 'd', 'e'], edges)).toEqual([['a', 'b', 'c'], ['d']]);
    const long = Array.from({ length: 20000 }, (_, i) => `n${i}`);
    const chain = new Map(long.slice(0, -1).map((n, i) => [n, [long[i + 1]!]] as [string, string[]]));
    expect(findCycles(long, chain)).toEqual([]);
  });

  test('resolveImport replica la resolución del módulo oficial', () => {
    expect(resolveImport('ventas/pedidos.dbml', '../catalogos/paises')).toBe('catalogos/paises.dbml');
    expect(resolveImport('ventas/pedidos.dbml', './detalles.dbml')).toBe('ventas/detalles.dbml');
  });
});
