import type { Diagram, TableNode } from '../diagram/model';
import { layoutDiagram } from '../diagram/layout';
import type { DiagramPatch } from '../project/diagram-config';
import type { Diagnostic } from '../project/diagnostics';
import type { DisplayMode } from '../diagram/model';

export const GRID = 8;
const snap = (value: number) => Math.max(0, Math.round(value / GRID) * GRID);

export interface SourceFileRef { packageId: string; filename: string }
/** Mantiene el ultimo archivo elegido de un paquete y usa el primero disponible como alternativa. */
export function sourceFileForPackage<T extends SourceFileRef>(files: T[], packageId: string, rememberedKey?: string): T | undefined {
  return files.find(file => `${file.packageId}/${file.filename}` === rememberedKey) ?? files.find(file => file.packageId === packageId);
}

export function isSaveShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean }): boolean {
  return !event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
}

/**
 * Parche de posiciones al mover nodos. La primera vez se «congela» la disposición automática de todos los
 * nodos, de modo que añadir o quitar tablas después no redistribuye el diagrama completo.
 */
export function movePatch(diagram: Diagram, moved: Record<string, { x: number; y: number }>): DiagramPatch {
  const layout: Record<string, { x: number; y: number }> = {};
  for (const box of layoutDiagram(diagram).boxes) layout[box.node.id] = { x: box.x, y: box.y };
  for (const [id, position] of Object.entries(moved)) layout[id] = { x: snap(position.x), y: snap(position.y) };
  // Solo se envían los nodos que cambian respecto a lo ya guardado.
  const changed = Object.fromEntries(Object.entries(layout).filter(([id, p]) => diagram.layout?.[id]?.x !== p.x || diagram.layout?.[id]?.y !== p.y));
  return { layout: changed };
}

/** Columnas de una tabla externa en modo compacto: claves y columnas que participan en relaciones del diagrama. */
export function defaultCompactColumns(diagram: Diagram, node: TableNode, all: string[]): string[] {
  const involved = new Set<string>();
  for (const relation of diagram.relationships) for (const endpoint of relation.endpoints) if (endpoint.tableId === node.tableId) endpoint.columns.forEach(c => involved.add(c));
  const pks = node.columnInfo?.filter(c => c.pk).map(c => c.name) ?? [];
  const picked = all.filter(c => involved.has(c) || pks.includes(c));
  return picked.length ? picked : all.slice(0, 2);
}

/** Todas las columnas de la tabla lógica, tomadas de su nodo local en algún diagrama. */
export function allColumnsOf(diagrams: Diagram[], tableId: string): string[] {
  for (const diagram of diagrams) { const node = diagram.nodes.find(n => n.tableId === tableId && n.kind === 'local'); if (node) return node.columns; }
  return diagrams.flatMap(d => d.nodes).find(n => n.tableId === tableId)?.columns ?? [];
}

/** Id de la vista externa a la que corresponde un nodo (`node:pkg:tabla:id`) o `main` si aún no tiene configuración. */
export function viewIdOf(node: TableNode, packageId: string): string {
  const prefix = `node:${packageId}:${node.tableId}`;
  const suffix = node.id.startsWith(`${prefix}:`) ? node.id.slice(prefix.length + 1) : '';
  return /^[\w-]{1,40}$/.test(suffix) && !/^\d+$/.test(suffix) ? suffix : 'main';
}

/** Parche para cambiar el modo de una tabla externa conservando su posición aunque cambie el id del nodo. */
export function displayPatch(diagram: Diagram, node: TableNode, display: DisplayMode, allColumns: string[], show?: string[]): { patch: DiagramPatch; nodeId: string } {
  const id = viewIdOf(node, diagram.packageId);
  const nodeId = `node:${diagram.packageId}:${node.tableId}:${id}`;
  const view: { table: string; display: DisplayMode; id: string; show?: string[]; label?: string } = { table: node.tableId, display, id };
  if (display === 'compact') view.show = show?.length ? show : defaultCompactColumns(diagram, node, allColumns);
  const existing = diagram.connectors.find(c => c.nodeId === node.id);
  if (display === 'connector' && existing) view.label = existing.label;
  const patch: DiagramPatch = { views: { upsert: [view] } };
  if (nodeId !== node.id) patch.renameNodes = { [node.id]: nodeId };
  return { patch, nodeId };
}

export interface PackageProblems { errors: number; warnings: number }
export function problemsByPackage(diagnostics: Diagnostic[]): Map<string, PackageProblems> {
  const result = new Map<string, PackageProblems>();
  for (const d of diagnostics) {
    if (!d.packageId) continue;
    const entry = result.get(d.packageId) ?? { errors: 0, warnings: 0 };
    if (d.severity === 'warning') entry.warnings++; else entry.errors++;
    result.set(d.packageId, entry);
  }
  return result;
}

/** Coordenadas del centro de un nodo para centrar el visor. */
export function centerOf(diagram: Diagram, nodeId: string): { x: number; y: number } | undefined {
  const box = layoutDiagram(diagram).boxes.find(b => b.node.id === nodeId);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
}

export const USER_COLORS = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#1d4ed8', '#4d7c0f', '#c2410c', '#0e7490'];
export function colorFor(id: string | null | undefined): string {
  let h = 0; for (const ch of id ?? 'anon') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length]!;
}
export const initials = (name: string | null | undefined) => (name ?? '?').trim().slice(0, 2).toUpperCase();
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'hace unos segundos';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(at).toLocaleString('es');
}
