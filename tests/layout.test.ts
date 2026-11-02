import { describe, expect, test } from 'bun:test';
import { compileProject } from '../src/project/compiler';
import { compileDiagrams, type Diagram, type TableNode } from '../src/diagram/model';
import { anchorY, layoutDiagram, NODE_WIDTH, routeEdge, relationshipEnds, type Box } from '../src/diagram/layout';
import { renderSvg } from '../src/diagram/svg';
import { movePatch } from '../src/ui/logic';
import { applyDiagramPatch } from '../src/project/diagram-config';
import { makeProject } from './helpers';

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const anyOverlap = (boxes: Box[]) => boxes.some((a, i) => boxes.slice(i + 1).some(b => overlaps(a, b)));

/** Esquema sintético: `n` tablas con una cadena de FKs y algunas relaciones cruzadas. */
function synthetic(n: number): Diagram {
  const lines = Array.from({ length: n }, (_, i) => {
    const refs = [i > 0 ? `p${i} int [ref: > t${i - 1}.id]` : '', i > 3 && i % 3 === 0 ? `q${i} int [ref: > t${i - 4}.id]` : ''].filter(Boolean).join('\n  ');
    return `Table t${i} {\n  id int [pk]\n  ${refs}\n}`;
  });
  const project = makeProject({ g: { 'g.dbml': lines.join('\n') } });
  return compileDiagrams(project, compileProject(project))[0]!;
}

describe('layout', () => {
  test('es determinista y no superpone tablas', () => {
    const diagram = synthetic(40);
    const a = layoutDiagram(diagram), b = layoutDiagram(structuredClone(diagram));
    expect(a.boxes.map(x => [x.node.id, x.x, x.y])).toEqual(b.boxes.map(x => [x.node.id, x.x, x.y]));
    expect(anyOverlap(a.boxes)).toBe(false);
    expect(a.boxes).toHaveLength(40);
  });

  test('coloca las tablas referenciadas a la izquierda de las que las referencian', () => {
    const diagram = synthetic(6);
    const { boxes } = layoutDiagram(diagram);
    const x = (id: string) => boxes.find(b => b.node.tableId === id)!.x;
    expect(x('public.t0')).toBeLessThan(x('public.t1'));
    expect(x('public.t1')).toBeLessThan(x('public.t2'));
  });

  test('escala a cientos de tablas sin superposiciones', () => {
    const diagram = synthetic(400);
    const started = performance.now();
    const layout = layoutDiagram(diagram);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(anyOverlap(layout.boxes)).toBe(false);
    // Las columnas de capa se parten en varias para no generar un diagrama de miles de píxeles de alto.
    expect(layout.height).toBeLessThan(40_000);
  });

  test('las posiciones guardadas se respetan y las tablas nuevas no mueven las existentes', () => {
    const diagram = synthetic(5);
    const frozen: Record<string, { x: number; y: number }> = {};
    for (const box of layoutDiagram(diagram).boxes) frozen[box.node.id] = { x: box.x + 16, y: box.y + 8 };
    const withLayout = { ...diagram, layout: frozen };
    const before = layoutDiagram(withLayout);
    for (const box of before.boxes) expect([box.x, box.y]).toEqual([frozen[box.node.id]!.x, frozen[box.node.id]!.y]);
    // Se añade una tabla nueva: las demás conservan su posición.
    const extra: TableNode = { id: 'node:g:public.nueva', tableId: 'public.nueva', owner: 'g', kind: 'local', name: 'nueva', columns: ['id'], display: 'full' };
    const grown = layoutDiagram({ ...withLayout, nodes: [...withLayout.nodes, extra] });
    for (const box of before.boxes) expect(grown.boxes.find(b => b.node.id === box.node.id)).toMatchObject({ x: box.x, y: box.y });
    expect(anyOverlap(grown.boxes)).toBe(false);
  });

  test('un nodo nuevo relacionado con uno fijado se coloca a su lado', () => {
    const diagram = synthetic(2); // t1 referencia a t0
    const t1 = diagram.nodes.find(n => n.tableId === 'public.t1')!;
    const withOne = { ...diagram, nodes: [t1], layout: { [t1.id]: { x: 500, y: 200 } } };
    const t0 = diagram.nodes.find(n => n.tableId === 'public.t0')!;
    const both = layoutDiagram({ ...diagram, nodes: [t0, t1], layout: withOne.layout });
    const box0 = both.boxes.find(b => b.node.id === t0.id)!;
    expect(box0.x).toBeLessThan(500 - NODE_WIDTH);
    expect(box0.y).toBe(200);
  });

  test('movePatch congela la disposición completa la primera vez y luego solo envía lo que cambia', () => {
    const diagram = synthetic(4);
    const target = diagram.nodes[1]!;
    const first = movePatch(diagram, { [target.id]: { x: 203, y: 197 } });
    expect(Object.keys(first.layout!)).toHaveLength(4);
    expect(first.layout![target.id]).toEqual({ x: 200, y: 200 }); // ajustado a la cuadrícula
    const frozen = applyDiagramPatch(undefined, first);
    const second = movePatch({ ...diagram, layout: frozen.layout }, { [target.id]: { x: 400, y: 200 } });
    expect(Object.keys(second.layout!)).toEqual([target.id]);
  });

  test('las aristas se anclan en la fila de la clave y las relaciones paralelas usan filas distintas', () => {
    const project = makeProject({ g: { 'g.dbml': 'Table paises { id int [pk] }\nTable pedidos {\n id int [pk]\n envio int [ref: > paises.id]\n factura int [ref: > paises.id]\n}' } });
    const diagram = compileDiagrams(project, compileProject(project))[0]!;
    const { boxes } = layoutDiagram(diagram);
    const ys = diagram.relationships.map(r => { const e = relationshipEnds(diagram, r, boxes)!; return routeEdge(e.a, e.b, e.aColumn, e.bColumn).path; });
    expect(new Set(ys).size).toBe(2);
    const pedidos = boxes.find(b => b.node.tableId === 'public.pedidos')!;
    expect(anchorY(pedidos, 'envio')).not.toBe(anchorY(pedidos, 'factura'));
    expect(anchorY(pedidos, 'envio')).toBe(pedidos.y + 67 + 24 * 1);
  });

  test('el SVG incluye datos para accesibilidad, selección y conectores con paquete, tabla y página', () => {
    const project = makeProject({
      c: { 'c.dbml': 'Table paises { id int [pk] }' },
      v: { 'v.dbml': "use * from '../c/c'\nTable pedidos {\n id int [pk]\n pais_id int [ref: > paises.id]\n}" },
    }, { v: { external: [{ table: 'public.paises', display: 'connector', label: 'CAT-01', id: 'x' }] } });
    const diagram = compileDiagrams(project, compileProject(project)).find(d => d.packageId === 'v')!;
    const svg = renderSvg(diagram, { pages: { c: 3 }, selectedTable: 'public.pedidos' });
    expect(svg).toContain('CAT-01 · p. 3');
    expect(svg).toContain('Paquete: c');
    expect(svg).toContain('Tabla: paises');
    expect(svg).toContain('Cardinalidad: *:1');
    expect(svg).toContain('data-connectors="connector:');
    expect(svg).toContain('data-selected="true"');
    expect(svg).toContain('tabindex="0"');
    expect(renderSvg(diagram)).not.toContain('· p.');
  });
});
