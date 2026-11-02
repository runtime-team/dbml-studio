import { describe, expect, test } from 'bun:test';
import { compileProject } from '../src/project/compiler';
import { compileDiagramSet, compileDiagrams } from '../src/diagram/model';
import { buildDependencyGraph } from '../src/project/dependencies';
import { EMPRESA, makeProject } from './helpers';

const compile = (project = makeProject(EMPRESA)) => { const compiled = compileProject(project); return { project, compiled, diagrams: compileDiagrams(project, compiled) }; };

describe('relaciones entre paquetes y TableRef', () => {
  test('cada paquete genera exactamente un diagrama y las tablas se definen una vez', () => {
    const { compiled, diagrams } = compile();
    expect(diagrams.map(d => d.packageId)).toEqual(['catalogos', 'empleados', 'ventas']);
    expect(compiled.schema.schemas.flatMap(s => s.tables).map(t => t.name).sort()).toEqual(['detalles', 'empleados', 'estados', 'paises', 'pedidos']);
    expect(compiled.exportSql().match(/CREATE TABLE/g)).toHaveLength(5);
    expect(compiled.exportSql().match(/CREATE TABLE "paises"/g)).toHaveLength(1);
  });

  test('por defecto se dibujan las tablas referenciadas, no las que referencian desde otro paquete', () => {
    const { diagrams } = compile();
    const ventas = diagrams.find(d => d.packageId === 'ventas')!;
    expect(ventas.nodes.filter(n => n.kind === 'external').map(n => n.tableId).sort()).toEqual(['public.empleados', 'public.paises']);
    const catalogos = diagrams.find(d => d.packageId === 'catalogos')!;
    expect(catalogos.nodes.every(n => n.kind === 'local')).toBe(true);
    expect(catalogos.relationships.length).toBeGreaterThan(1);
  });

  test('TableRef Full conserva todas las columnas y el propietario', () => {
    const ventas = compile().diagrams.find(d => d.packageId === 'ventas')!;
    const paises = ventas.nodes.find(n => n.tableId === 'public.paises')!;
    expect(paises).toMatchObject({ kind: 'external', display: 'full', owner: 'catalogos' });
    expect(paises.columns).toEqual(['id', 'nombre', 'continente']);
    expect(paises.columnInfo?.[0]).toMatchObject({ name: 'id', pk: true, type: 'int' });
  });

  test('TableRef Compact muestra solo las columnas elegidas y valida su existencia', () => {
    const project = makeProject(EMPRESA, { ventas: { external: [{ table: 'public.paises', display: 'compact', show: ['id', 'nombre'], id: 'min' }] } });
    const { compiled } = compile(project);
    const node = compileDiagrams(project, compiled).find(d => d.packageId === 'ventas')!.nodes.find(n => n.tableId === 'public.paises')!;
    expect(node.columns).toEqual(['id', 'nombre']);
    expect(node.display).toBe('compact');
    project.packages.find(p => p.id === 'ventas')!.diagram = { external: [{ table: 'public.paises', display: 'compact', show: ['nope'] }] };
    expect(() => compileDiagrams(project, compiled)).toThrow('Columnas inválidas');
    project.packages.find(p => p.id === 'ventas')!.diagram = { external: [{ table: 'public.paises', display: 'compact' }] };
    expect(() => compileDiagrams(project, compiled)).toThrow('requiere columnas');
  });

  test('TableRef Connector sustituye la tabla por un conector con todos los datos requeridos', () => {
    const project = makeProject(EMPRESA, { ventas: { external: [{ table: 'public.paises', display: 'connector', label: 'CAT-01', id: 'c' }] } });
    const { compiled } = compile(project);
    const ventas = compileDiagrams(project, compiled).find(d => d.packageId === 'ventas')!;
    const node = ventas.nodes.find(n => n.tableId === 'public.paises')!;
    expect(node.display).toBe('connector');
    expect(ventas.connectors).toHaveLength(1);
    const connector = ventas.connectors[0]!;
    expect(connector).toMatchObject({ label: 'CAT-01', sourceTableId: 'public.pedidos', targetTableId: 'public.paises', sourcePackageId: 'ventas', targetPackageId: 'catalogos', cardinality: '*:1', optional: false });
    expect(connector.id).toBe(`connector:${node.id}:${connector.relationshipId}`);
    expect(connector.endpoints).toHaveLength(2);
    // Un conector no crea tablas ni relaciones nuevas.
    expect(compiled.schema.schemas.flatMap(s => s.tables)).toHaveLength(5);
    expect(compiled.exportSql().match(/FOREIGN KEY/g)).toHaveLength(compiled.schema.schemas[0]!.refs.length);
  });

  test('una tabla lógica puede tener varias instancias visuales', () => {
    const project = makeProject(EMPRESA, { ventas: { external: [
      { table: 'public.paises', display: 'compact', show: ['id'], id: 'a' },
      { table: 'public.paises', display: 'full', id: 'b' },
      { table: 'public.paises', display: 'connector', id: 'c', label: 'C' },
    ] } });
    const { compiled } = compile(project);
    const ventas = compileDiagrams(project, compiled).find(d => d.packageId === 'ventas')!;
    const nodes = ventas.nodes.filter(n => n.tableId === 'public.paises');
    expect(nodes.map(n => n.display).sort()).toEqual(['compact', 'connector', 'full']);
    expect(new Set(nodes.map(n => n.id)).size).toBe(3);
    expect(compiled.schema.schemas.flatMap(s => s.tables).filter(t => t.name === 'paises')).toHaveLength(1);
  });

  test('relaciones múltiples entre las mismas tablas tienen identificadores distintos y se eligen por id', () => {
    const project = makeProject({
      a: { 'a.dbml': 'Table paises { id int [pk] }' },
      b: { 'b.dbml': "use * from '../a/a'\nTable pedidos {\n id int [pk]\n envio int [ref: > paises.id]\n factura int [not null, ref: > paises.id]\n}" },
    });
    const compiled = compileProject(project);
    const base = compileDiagrams(project, compiled).find(d => d.packageId === 'b')!;
    expect(new Set(base.relationships.map(r => r.id)).size).toBe(2);
    const factura = base.relationships.find(r => r.endpoints.some(e => e.columns.includes('factura')))!;
    project.packages[1]!.diagram = { external: [{ table: 'public.paises', display: 'connector', relationship: factura.id, id: 'f' }] };
    const connectors = compileDiagrams(project, compiled).find(d => d.packageId === 'b')!.connectors;
    expect(connectors).toHaveLength(1);
    expect(connectors[0]).toMatchObject({ relationshipId: factura.id, optional: false });
  });

  test('las cardinalidades se conservan en relaciones, conectores y SQL', () => {
    const project = makeProject({
      a: { 'a.dbml': 'Table perfil { id int [pk] }\nTable etiqueta { id int [pk] }' },
      b: { 'b.dbml': "use * from '../a/a'\nTable usuario {\n id int [pk]\n perfil_id int [unique, ref: - perfil.id]\n e1 int [ref: <> etiqueta.id]\n}" },
    }, { b: { external: [{ table: 'public.perfil', display: 'connector', id: 'p' }] } });
    const compiled = compileProject(project);
    const diagram = compileDiagrams(project, compiled).find(d => d.packageId === 'b')!;
    const perfil = diagram.relationships.find(r => r.endpoints.some(e => e.tableId === 'public.perfil'))!;
    expect(perfil.endpoints.map(e => e.cardinality)).toEqual(['1', '1']);
    expect(perfil.foreignKey?.tableId).toBe('public.usuario');
    expect(diagram.connectors[0]!.cardinality).toBe('1:1');
    const manyToMany = diagram.relationships.find(r => r.endpoints.some(e => e.tableId === 'public.etiqueta'))!;
    expect(manyToMany.endpoints.map(e => e.cardinality)).toEqual(['*', '*']);
    expect(manyToMany.foreignKey).toBeUndefined();
  });

  test('una configuración externa defectuosa se informa por paquete sin tirar el resto', () => {
    const project = makeProject(EMPRESA, { ventas: { external: [
      { table: 'public.no_existe', display: 'full', id: 'x' },
      { table: 'public.pedidos', display: 'full', id: 'y' },
      { table: 'public.paises', display: 'compact', show: ['id'], id: 'ok' },
      { table: 'public.paises', display: 'connector', id: 'ok', label: 'dup' },
    ] } });
    const compiled = compileProject(project);
    const { diagrams, diagnostics } = compileDiagramSet(project, compiled);
    expect(diagnostics.map(d => d.code)).toEqual(['STU011', 'STU012', 'STU010']);
    expect(diagnostics.every(d => d.packageId === 'ventas' && d.filepath === 'ventas/diagram.yaml')).toBe(true);
    expect(diagrams.find(d => d.packageId === 'ventas')!.diagnostics).toHaveLength(3);
    expect(diagrams.find(d => d.packageId === 'ventas')!.nodes.some(n => n.tableId === 'public.paises')).toBe(true);
    expect(diagrams.find(d => d.packageId === 'catalogos')!.diagnostics).toBeUndefined();
  });

  test('el grafo separa importaciones, claves foráneas y dependencias visuales', () => {
    const { compiled, diagrams } = compile();
    const graph = buildDependencyGraph(compiled, diagrams);
    expect(graph.imports.map(e => `${e.from}>${e.to}`)).toEqual(['empleados>catalogos', 'ventas>catalogos', 'ventas>empleados']);
    expect(graph.foreignKeys.map(e => `${e.from}>${e.to}`)).toEqual(['empleados>catalogos', 'ventas>catalogos', 'ventas>empleados']);
    expect(graph.visual.map(e => `${e.from}>${e.to}`)).toEqual(['empleados>catalogos', 'ventas>catalogos', 'ventas>empleados']);
    expect(graph.order).toEqual(['catalogos', 'empleados', 'ventas']);
    expect(graph.importCycles).toEqual([]);
  });

  test('claves foráneas en ambos sentidos entre paquetes no son un ciclo inválido', () => {
    const project = makeProject({
      a: { 'a.dbml': "use * from '../b/b'\nTable ta {\n id int [pk]\n b_id int [ref: > tb.id]\n}" },
      b: { 'b.dbml': "use * from '../a/a'\nTable tb {\n id int [pk]\n a_id int [ref: > ta.id]\n}" },
    });
    const compiled = compileProject(project);
    const diagrams = compileDiagrams(project, compiled);
    const graph = buildDependencyGraph(compiled, diagrams);
    expect(graph.foreignKeys).toHaveLength(2);
    expect(graph.importCycles).toEqual([['a', 'b']]);
    expect(compiled.exportSql().match(/CREATE TABLE/g)).toHaveLength(2);
  });
});
