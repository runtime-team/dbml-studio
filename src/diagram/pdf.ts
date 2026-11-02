import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import type { Diagram } from './model';
import { layoutDiagram, MARGIN, TOP } from './layout';
import { renderSvg } from './svg';

export interface PdfOptions { size?: 'A4' | 'A3'; orientation?: 'portrait' | 'landscape' }

/** Escala mínima aceptable antes de repartir un diagrama en varias páginas. */
const MIN_SCALE = 0.58;

/**
 * Reparte nodos completos en páginas conservando su disposición relativa (las posiciones del layout completo
 * se trasladan, no se recalculan) para que las tablas nunca se corten.
 */
export function paginateDiagram(diagram: Diagram, availableWidth: number, availableHeight: number): Diagram[] {
  const full = layoutDiagram(diagram);
  const fits = (width: number, height: number) => Math.min(availableWidth / width, (availableHeight - 80) / height) >= MIN_SCALE;
  const finish = (nodes: Diagram['nodes'], index: number, positions?: Record<string, { x: number; y: number }>): Diagram => {
    const ids = new Set(nodes.map(n => n.tableId));
    const nodeIds = new Set(nodes.map(n => n.id));
    return { ...diagram, id: `${diagram.id}:page:${index + 1}`, nodes, layout: positions ?? diagram.layout, relationships: diagram.relationships.filter(r => r.endpoints.every(e => ids.has(e.tableId))), connectors: diagram.connectors.filter(c => nodeIds.has(c.nodeId)) };
  };
  if (fits(full.width, full.height) || full.boxes.length <= 1) return [finish(diagram.nodes, 0)];

  const ordered = [...full.boxes].sort((a, b) => a.x - b.x || a.y - b.y || a.node.id.localeCompare(b.node.id, 'en'));
  const bounds = (boxes: typeof ordered) => {
    const minX = Math.min(...boxes.map(b => b.x)), minY = Math.min(...boxes.map(b => b.y));
    return { minX, minY, width: Math.max(...boxes.map(b => b.x + b.width)) - minX + MARGIN * 2, height: Math.max(...boxes.map(b => b.y + b.height)) - minY + TOP + MARGIN };
  };
  const groups: typeof ordered[] = [];
  let group: typeof ordered = [];
  for (const box of ordered) {
    if (group.length) { const b = bounds([...group, box]); if (!fits(b.width, b.height)) { groups.push(group); group = []; } }
    group.push(box);
  }
  if (group.length) groups.push(group);
  return groups.map((boxes, i) => {
    const { minX, minY } = bounds(boxes);
    const positions = Object.fromEntries(boxes.map(b => [b.node.id, { x: b.x - minX + MARGIN, y: b.y - minY + TOP }]));
    const wanted = new Set(boxes.map(b => b.node.id));
    return finish(diagram.nodes.filter(n => wanted.has(n.id)), i, positions);
  });
}

interface Rendered { bytes: Uint8Array; starts: Record<string, number> }

async function build(diagrams: Diagram[], options: PdfOptions, pages: Record<string, number>): Promise<Rendered> {
  const doc = new PDFDocument({ autoFirstPage: false, compress: false, info: { Title: 'DBML Studio' } });
  const chunks: Uint8Array[] = [];
  const finished = new Promise<Uint8Array>((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const page = (margin = 24) => doc.addPage({ size: options.size ?? 'A4', layout: options.orientation ?? 'landscape', margin });
  const starts: Record<string, number> = {};
  let absolutePage = 0;
  for (const diagram of diagrams) {
    page();
    const availableWidth = doc.page.width - 48, availableHeight = doc.page.height - 48;
    const parts = paginateDiagram(diagram, availableWidth, availableHeight);
    const firstPage = absolutePage + 1;
    starts[diagram.packageId] = firstPage;
    doc.outline.addItem(diagram.packageId);
    const tablePages = new Map<string, number>();
    parts.forEach((part, index) => part.nodes.forEach(node => { if (!tablePages.has(node.tableId)) tablePages.set(node.tableId, firstPage + index); }));
    for (let i = 0; i < parts.length; i++) {
      if (i) page();
      absolutePage++;
      const part = parts[i]!, { width, height } = layoutDiagram(part);
      const scale = Math.min(availableWidth / width, (availableHeight - 80) / height);
      SVGtoPDF(doc, renderSvg(part, { pages }), 24 + (availableWidth - width * scale) / 2, 24, { width: width * scale, height: height * scale, assumePt: true });
      doc.font('Helvetica').fontSize(8).fillColor('#334155').text(`Página ${absolutePage} · ${diagram.packageId}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ''}`, 28, doc.page.height - 38, { width: availableWidth - 8, lineBreak: false });
    }
    const crossPage = diagram.relationships.filter(r => new Set(r.endpoints.map(e => tablePages.get(e.tableId))).size > 1);
    const connectors = diagram.connectors;
    if (crossPage.length || (connectors.length && parts.length > 1)) {
      page(36);
      absolutePage++;
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text(`Referencias · ${diagram.packageId}`);
      doc.moveDown(); doc.font('Helvetica').fontSize(9);
      const write = (line: string) => {
        const lineHeight = doc.heightOfString(line, { width: doc.page.width - 72 });
        if (doc.y + lineHeight > doc.page.height - 50) { page(36); absolutePage++; }
        doc.text(line, { width: doc.page.width - 72 }); doc.moveDown(0.4);
      };
      for (const relation of crossPage) write(relation.endpoints.map(e => `${e.tableId} (${e.columns.join(', ')}, p. ${tablePages.get(e.tableId) ?? '?'}, ${e.cardinality})`).join(' -> '));
      for (const connector of connectors) {
        const target = pages[connector.targetPackageId];
        write(`${connector.label}: ${connector.sourceTableId} -> Paquete ${connector.targetPackageId}, tabla ${connector.targetTableId} (${connector.cardinality})${target ? `, p. ${target}` : ''}`);
      }
    }
  }
  doc.end();
  return { bytes: await finished, starts };
}

/**
 * Los números de página se calculan durante la exportación: una primera pasada mide dónde empieza cada
 * paquete y la segunda imprime esas referencias en los conectores. No forman parte de la identidad lógica.
 */
export async function renderPdf(diagrams: Diagram[], options: PdfOptions = {}): Promise<Uint8Array> {
  if (!diagrams.length) throw new Error('No hay diagramas para exportar.');
  const first = await build(diagrams, options, {});
  if (!diagrams.some(d => d.connectors.length)) return first.bytes;
  return (await build(diagrams, options, first.starts)).bytes;
}

