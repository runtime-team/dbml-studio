import { test, expect } from 'bun:test';
import { paginateDiagram, renderPdf } from '../src/diagram/pdf';
import type { Diagram } from '../src/diagram/model';

test('genera PDF con una página por diagrama en A3 vertical', async () => {
  const diagram: Diagram = { id: 'd', packageId: 'ventas', nodes: [{ id: 'n', tableId: 'public.paises', name: 'paises', owner: 'catalogos', kind: 'external', display: 'connector', columns: [] }], relationships: [], connectors: [{ id: 'c', nodeId: 'n', relationshipId: 'r', sourceTableId: 'public.pedidos', targetTableId: 'public.paises', targetPackageId: 'catalogos', sourcePackageId: 'ventas', cardinality: '*:1', optional: false, label: 'CAT-01', endpoints: [] }] };
  const pdf = await renderPdf([diagram, { ...diagram, id: 'd2' }], { size: 'A3', orientation: 'portrait' });
  const raw = Buffer.from(pdf).toString('latin1');
  expect(raw.startsWith('%PDF-')).toBe(true);
  expect(raw).toContain('/Count 2');
  expect(raw).toContain('/MediaBox [0 0 841.89 1190.55]');
});

test('divide diagramas grandes sin cortar nodos y agrega índice de relaciones entre páginas', async () => {
  const diagram: Diagram = { id: 'grande', packageId: 'ventas', connectors: [], nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, tableId: `public.t${i}`, owner: 'ventas', kind: 'local', name: `t${i}`, columns: Array.from({ length: 8 }, (_, j) => `c${j}`), display: 'full' })), relationships: [{ id: 'r', endpoints: [{ tableId: 'public.t0', columns: ['c0'], cardinality: '1' }, { tableId: 'public.t11', columns: ['c0'], cardinality: '*' }] }] };
  const pages = paginateDiagram(diagram, 547, 794);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.flatMap(p => p.nodes).map(n => n.id).sort()).toEqual(diagram.nodes.map(n => n.id).sort());
  const pdf = Buffer.from(await renderPdf([diagram], { orientation: 'portrait' })).toString('latin1');
  expect(pdf).toContain(`/Count ${pages.length + 1}`);
});
