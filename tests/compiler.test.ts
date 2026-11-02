import { expect, test } from 'bun:test';
import { compileProject, ProjectCompileError } from '../src/project/compiler';
import type { Project } from '../src/project/loader';
import { join } from 'node:path';

function projectOf(files: Record<string, string>): Project {
  const root = process.cwd();
  return { root, manifest: { name: 'test', version: 1, source: { packages: ['p'] } }, packages: [{ id: 'p', path: join(root, 'p'), files: new Map(Object.entries(files).map(([name, content]) => [join(root, 'p', name), content])) }] };
}

test('compila fuentes separadas en un esquema único y exporta SQL', () => {
  const root = process.cwd();
  const project: Project = { root, manifest: { name: 'demo', version: 1, source: { packages: ['demo'] } }, packages: [{ id: 'demo', path: root, files: new Map([
    [`${root}/a.dbml`, 'Table users {\n id int [pk]\n}'],
    [`${root}/b.dbml`, "use * from './a'\nTable orders {\n id int [pk]\n user_id int [ref: > users.id]\n}"],
  ]) }] };
  const result = compileProject(project);
  expect(result.schema.schemas.flatMap(s => s.tables).map(t => t.name).sort()).toEqual(['orders', 'users']);
  expect(result.exportSql()).toContain('CREATE TABLE');
});

test('conserva enum, índices, grupo y referencia DBML estándar', () => {
  const compiled = compileProject(projectOf({ 'schema.dbml': `
Enum estado {
  pendiente
  completado
}
Table users {
  id int [pk]
  name varchar [not null]
  indexes {
    name [unique]
  }
}
Table orders {
  id int [pk]
  user_id int
  status estado
}
Ref: orders.user_id > users.id
TableGroup negocio {
  users
  orders
}
` }));
  const schema = compiled.schema.schemas[0]!;
  expect(schema.tables.map(t => t.name).sort()).toEqual(['orders', 'users']);
  expect(schema.enums.map(e => e.name)).toContain('estado');
  expect(schema.tableGroups.map(g => g.name)).toContain('negocio');
  expect(schema.refs).toHaveLength(1);
  expect(schema.tables.find(t => t.name === 'users')?.indexes).toHaveLength(1);
  const sql = compiled.exportSql();
  expect(sql.match(/CREATE TABLE/g)).toHaveLength(2);
  expect(sql).toContain('FOREIGN KEY');
});

test('detecta importaciones inexistentes y referencias rotas', () => {
  expect(() => compileProject(projectOf({ 'a.dbml': "use * from './missing'\nTable a {\n id int\n}" }))).toThrow();
  expect(() => compileProject(projectOf({ 'a.dbml': 'Table a {\n id int [ref: > missing.id]\n}' }))).toThrow();
});

test('conserva archivo, línea y código en diagnósticos', () => {
  try { compileProject(projectOf({ 'a.dbml': 'Table a {\n id int [ref: > missing.id]\n}' })); throw new Error('se esperaba error'); }
  catch (error) {
    expect(error).toBeInstanceOf(ProjectCompileError);
    const diagnostic = (error as ProjectCompileError).diagnostics[0]!;
    expect(diagnostic.filepath).toContain('a.dbml');
    expect(diagnostic.location?.start?.line).toBe(2);
    expect(diagnostic.code).toBeDefined();
    expect((error as Error).message).toContain('missing');
  }
});

test('produce la misma salida con archivos en distinto orden', () => {
  const a = 'Table users {\n id int [pk]\n}';
  const b = "use * from './a'\nTable orders {\n id int [pk]\n user_id int [ref: > users.id]\n}";
  expect(compileProject(projectOf({ 'a.dbml': a, 'b.dbml': b })).exportSql()).toBe(compileProject(projectOf({ 'b.dbml': b, 'a.dbml': a })).exportSql());
});
