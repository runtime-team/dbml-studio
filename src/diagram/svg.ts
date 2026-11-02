import type { Diagram } from './model';
import { layoutDiagram, relationshipEnds, routeEdge, ROW_HEIGHT, type Box } from './layout';

export { layoutDiagram } from './layout';

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const fit = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export interface RenderOptions {
  /** Posiciones temporales (p. ej. mientras se arrastra) que prevalecen sobre `diagram.layout`. */
  positions?: Record<string, { x: number; y: number }>;
  /** Página inicial del diagrama de cada paquete en la exportación final. Se imprime en los conectores; no forma parte de su identidad. */
  pages?: Record<string, number>;
  /** Nodo resaltado (p. ej. tras navegar a una tabla). */
  highlight?: string;
  /** Tabla seleccionada: todos sus nodos se marcan con `data-selected`. */
  selectedTable?: string;
  /** Relación seleccionada. */
  selectedRelationship?: string;
}

function renderEdges(diagram: Diagram, boxes: Box[], options: RenderOptions): string {
  return diagram.relationships.flatMap(relation => {
    const ends = relationshipEnds(diagram, relation, boxes);
    if (!ends) return [];
    const { a, b, aColumn, bColumn, aSlot, bSlot } = ends;
    const geometry = routeEdge(a, b, aColumn, bColumn, aSlot, bSlot);
    const [ea, eb] = relation.endpoints as [typeof relation.endpoints[number], typeof relation.endpoints[number]];
    const title = `${ea.tableId}.${ea.columns.join(',')} ${ea.cardinality}:${eb.cardinality} ${eb.tableId}.${eb.columns.join(',')}${relation.name ? ` (${relation.name})` : ''}`;
    return [`<g data-relationship="${escape(relation.id)}" class="edge"${options.selectedRelationship === relation.id ? ' data-selected="true"' : ''}><title>${escape(title)}</title><path d="${geometry.path}" stroke="transparent" stroke-width="12" fill="none"/><path d="${geometry.path}" stroke="#94a3b8" stroke-width="2" fill="none"/><text x="${geometry.start.x}" y="${geometry.start.y}" text-anchor="${geometry.start.anchor}" class="edge-label">${escape(ea.cardinality)}</text><text x="${geometry.end.x}" y="${geometry.end.y}" text-anchor="${geometry.end.anchor}" class="edge-label">${escape(eb.cardinality)}</text></g>`];
  }).join('');
}

function renderNode(diagram: Diagram, box: Box, options: RenderOptions): string {
  const { node: n, x, y, width: w, height: h } = box;
  const common = `data-node="${escape(n.id)}" data-table="${escape(n.tableId)}" data-owner="${escape(n.owner)}" data-display="${n.display}" tabindex="0" role="button"`;
  const title = `<text x="${x + 16}" y="${y + 30}" class="name">${escape(fit(n.name, 24))}</text>`;
  const highlight = (options.highlight === n.id ? ' data-highlight="true"' : '') + (options.selectedTable === n.tableId ? ' data-selected="true"' : '');
  if (n.display === 'connector') {
    const connectors = diagram.connectors.filter(c => c.nodeId === n.id);
    const first = connectors[0];
    const labels = [...new Set(connectors.map(c => c.label))];
    const label = (labels.join(', ') || n.owner) + (connectors.length > 1 ? ` · ${connectors.length} relaciones` : '');
    const page = options.pages?.[n.owner];
    const cardinality = first ? `${first.cardinality} · ${first.optional ? 'opcional' : 'obligatoria'}` : '';
    const lines = [
      `<text x="${x + 16}" y="${y + 54}" class="ref">${escape(fit(label, 30))}${page ? ` · p. ${page}` : ''}</text>`,
      `<text x="${x + 16}" y="${y + 74}" class="meta">Paquete: ${escape(fit(n.owner, 26))}</text>`,
      `<text x="${x + 16}" y="${y + 92}" class="meta">Tabla: ${escape(fit(n.name, 28))}</text>`,
      cardinality ? `<text x="${x + 16}" y="${y + 110}" class="meta">Cardinalidad: ${escape(cardinality)}</text>` : '',
    ].join('');
    return `<g ${common}${highlight} data-connectors="${escape(connectors.map(c => c.id).join(' '))}" aria-label="${escape(`Conector ${n.name}, paquete ${n.owner}${first ? `, referencia ${first.label}` : ''}`)}"><path d="M ${x} ${y} h ${w} v ${h - 20} l ${-w / 2} 20 l ${-w / 2} -20 Z" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>${title}${lines}</g>`;
  }
  const external = n.kind === 'external';
  const fields = n.columns.map((column, index) => {
    const info = n.columnInfo?.[index];
    const row = y + 72 + index * ROW_HEIGHT;
    const badge = info?.pk ? `<text x="${x + 16}" y="${row}" class="badge">PK</text>` : info?.fk ? `<text x="${x + 16}" y="${row}" class="badge fk">FK</text>` : '';
    return `${badge}<text x="${x + (info?.pk || info?.fk ? 44 : 16)}" y="${row}" class="column">${escape(fit(column, 20))}</text>${info ? `<text x="${x + w - 14}" y="${row}" text-anchor="end" class="type">${escape(fit(info.type, 14))}</text>` : ''}`;
  }).join('');
  // Indicador de navegación para tablas externas: una flecha diagonal dibujada con trazos (sin depender de glifos).
  const arrow = external ? `<path d="M ${x + w - 20} ${y + 36} l 9 -9 m -6 0 h 6 v 6" stroke="#2563eb" stroke-width="1.6" fill="none" class="nav"/>` : '';
  const owner = external ? `<text x="${x + w - 28}" y="${y + 30}" text-anchor="end" class="meta">${escape(fit(n.owner, 16))}</text>` : `<text x="${x + w - 12}" y="${y + 30}" text-anchor="end" class="meta">local</text>`;
  const modeNote = external && n.display === 'compact' ? `<text x="${x + 16}" y="${y + h - 8}" class="meta">compacta</text>` : '';
  return `<g ${common}${highlight} aria-label="${escape(`Tabla ${n.name}, paquete ${n.owner}`)}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#fff" stroke="${external ? '#2563eb' : '#94a3b8'}"${external ? ' stroke-dasharray="6 4"' : ''}/><path d="M ${x} ${y + 46} h ${w}" stroke="#e2e8f0"/>${title}${owner}${arrow}${fields}${modeNote}</g>`;
}

export function renderSvg(diagram: Diagram, options: RenderOptions = {}): string {
  const { width, height, boxes } = layoutDiagram(diagram, { positions: options.positions });
  const edges = renderEdges(diagram, boxes, options);
  const nodes = boxes.map(box => renderNode(diagram, box, options)).join('');
  const style = `text{font-family:'Trebuchet MS',sans-serif;fill:#0f172a}.title{font-size:20px;font-weight:700}.name{font-size:15px;font-weight:700}.meta,.edge-label{font-size:11px;fill:#475569}.ref{font-size:13px;font-weight:700;fill:#1d4ed8}.column{font-size:13px}.type{font-size:11px;fill:#64748b}.badge{font-size:10px;font-weight:700;fill:#b45309}.badge.fk{fill:#2563eb}[data-highlight] rect,[data-highlight] path{stroke:#168a6b;stroke-width:3}[data-selected] > rect{stroke:#168a6b;stroke-width:2.5}.edge[data-selected] path{stroke:#168a6b}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(`Diagrama ${diagram.packageId}`)}"><style>${style}</style><rect width="100%" height="100%" fill="#f8fafc"/><text x="48" y="42" class="title">${escape(diagram.packageId)}</text>${edges}${nodes}</svg>`;
}
