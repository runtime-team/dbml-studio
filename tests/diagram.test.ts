import { expect, test } from 'bun:test';
import { compileProject } from '../src/project/compiler';
import { compileDiagrams } from '../src/diagram/model';
import { buildReferenceIndex, navigate, goBack, goForward } from '../src/diagram/navigation';
import type { Project } from '../src/project/loader';
import { join } from 'node:path';

test('una relación entre paquetes crea un nodo externo sin duplicar la tabla lógica', () => {
  const root = process.cwd();
  const project: Project = { root, manifest: { name: 'demo', version: 1, source: { packages: ['catalogos', 'ventas'] } }, packages: [
    { id: 'catalogos', path: join(root, 'catalogos'), files: new Map([[join(root, 'catalogos', 'paises.dbml'), 'Table paises {\n id int [pk]\n}']]) },
    { id: 'ventas', path: join(root, 'ventas'), files: new Map([[join(root, 'ventas', 'pedidos.dbml'), "use * from '../catalogos/paises'\nTable pedidos {\n id int [pk]\n pais_id int [ref: > paises.id]\n}"]]) },
  ] };
  const compiled = compileProject(project);
  const diagrams = compileDiagrams(project, compiled);
  expect(compiled.schema.schemas.flatMap(s => s.tables).length).toBe(2);
  expect(diagrams.find(d => d.packageId === 'ventas')?.nodes.map(n => [n.tableId, n.kind])).toContainEqual(['public.paises', 'external']);
  expect(diagrams.find(d => d.packageId === 'ventas')?.relationships).toHaveLength(1);
  const index = buildReferenceIndex(diagrams);
  expect(index.get('public.paises')?.relations).toHaveLength(1);
  expect(index.get('public.paises')?.packages.sort()).toEqual(['catalogos', 'ventas']);
  const initial = { current: { packageId: 'ventas' }, back: [], forward: [] };
  const next = navigate(initial, { packageId: 'catalogos', tableId: 'public.paises' });
  expect(goForward(goBack(next)).current).toEqual(next.current);
  project.packages[1]!.diagram = { external: [{ table: 'public.paises', display: 'compact', show: ['id'], id: 'resumen' }, { table: 'public.paises', display: 'connector', id: 'enlace', label: 'CAT-01' }] };
  const view = compileDiagrams(project, compiled)[1]!;
  expect(view.nodes.filter(n => n.tableId === 'public.paises').map(n => n.display)).toEqual(['compact', 'connector']);
  expect(view.connectors[0]).toMatchObject({ label: 'CAT-01', targetPackageId: 'catalogos', targetTableId: 'public.paises' });
  project.packages[1]!.diagram = { external: [{ table: 'public.paises', display: 'compact', show: ['inexistente'] }] };
  expect(() => compileDiagrams(project, compiled)).toThrow('Columnas inválidas');
});

test('distingue relaciones múltiples y permite elegir una para el conector', () => {
  const root = process.cwd();
  const project: Project = { root, manifest: { name: 'demo', version: 1, source: { packages: ['a', 'b'] } }, packages: [
    { id: 'a', path: join(root, 'a'), files: new Map([[join(root, 'a', 'p.dbml'), 'Table paises {\n id int [pk]\n}']]) },
    { id: 'b', path: join(root, 'b'), files: new Map([[join(root, 'b', 'p.dbml'), "use * from '../a/p'\nTable pedidos {\n id int [pk]\n envio int [ref: > paises.id]\n facturacion int [ref: > paises.id]\n}"]]) },
  ] };
  const compiled = compileProject(project);
  const base = compileDiagrams(project, compiled)[1]!;
  expect(new Set(base.relationships.map(r => r.id)).size).toBe(2);
  const relation = base.relationships.find(r => r.endpoints.some(e => e.columns.includes('envio')))!;
  project.packages[1]!.diagram = { external: [{ table: 'public.paises', display: 'connector', relationship: relation.id }] };
  const diagram = compileDiagrams(project, compiled)[1]!;
  expect(diagram.connectors).toHaveLength(1);
  expect(diagram.connectors[0]!.relationshipId).toBe(relation.id);
  expect(buildReferenceIndex(compileDiagrams(project, compiled)).get('public.paises')?.relations).toHaveLength(2);
});
