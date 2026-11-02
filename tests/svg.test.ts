import { expect, test } from 'bun:test';
import { layoutDiagram, renderSvg } from '../src/diagram/svg';
import type { Diagram } from '../src/diagram/model';

test('SVG escapa texto y mantiene las tablas separadas', () => {
  const d: Diagram = { id: 'd', packageId: 'ventas & compras', relationships: [], connectors: [], nodes: Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, tableId: `t${i}`, owner: 'p', kind: 'local', name: i ? `tabla${i}` : '<unsafe>', columns: Array.from({ length: i + 1 }, (_, j) => `col${j}`), display: 'full' })) };
  const layout = layoutDiagram(d);
  expect(layout.boxes[2]!.y).toBeGreaterThanOrEqual(layout.boxes[0]!.y + layout.boxes[0]!.height);
  expect(renderSvg(d)).toContain('&lt;unsafe&gt;');
  expect(renderSvg(d)).toContain('ventas &amp; compras');
});
