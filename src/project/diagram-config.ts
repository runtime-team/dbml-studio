import { stringify } from 'yaml';
import { Codes, StudioError } from './diagnostics';
import type { DiagramConfig, ExternalView, NodePosition } from './loader';

/**
 * Modificación incremental de la configuración visual de un paquete. Se aplica igual al archivo
 * `diagram.yaml` (modo local) y al estado compartido (modo colaborativo).
 */
export interface DiagramPatch {
  /** Posiciones por nodo; `null` elimina la posición guardada. */
  layout?: Record<string, NodePosition | null>;
  /** Migra posiciones cuando cambia el identificador de un nodo (`antiguo → nuevo`). */
  renameNodes?: Record<string, string>;
  views?: {
    /** Inserta o reemplaza vistas externas, identificadas por `table` + `id`. */
    upsert?: ExternalView[];
    /** Elimina vistas por `id`. */
    remove?: string[];
  };
}

export const LIMITS = { nodes: 5000, views: 500, show: 200, string: 200 } as const;
const NODE_ID = /^node:[\w.$-]{1,80}:[^\s]{1,300}$/;
const VIEW_ID = /^[\w-]{1,40}$/;

const fail = (message: string, packageId?: string): never => { throw new StudioError([{ code: Codes.diagramConfig, severity: 'error', message, packageId, filepath: packageId ? `${packageId}/diagram.yaml` : undefined }]); };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function validatePatch(raw: unknown, packageId?: string): DiagramPatch {
  if (!isObject(raw)) return fail('El parche debe ser un objeto.', packageId);
  const patch: DiagramPatch = {};
  if (raw.layout !== undefined) {
    if (!isObject(raw.layout) || Object.keys(raw.layout).length > LIMITS.nodes) return fail('layout inválido o demasiado grande.', packageId);
    patch.layout = {};
    for (const [id, position] of Object.entries(raw.layout)) {
      if (!NODE_ID.test(id)) return fail(`Identificador de nodo inválido: ${id.slice(0, 60)}`, packageId);
      if (position === null) { patch.layout[id] = null; continue; }
      if (!isObject(position) || typeof position.x !== 'number' || typeof position.y !== 'number' || !Number.isFinite(position.x) || !Number.isFinite(position.y) || position.x < 0 || position.y < 0 || position.x > 1e6 || position.y > 1e6)
        return fail(`Posición inválida para ${id}.`, packageId);
      patch.layout[id] = { x: Math.round(position.x), y: Math.round(position.y) };
    }
  }
  if (raw.renameNodes !== undefined) {
    if (!isObject(raw.renameNodes) || Object.keys(raw.renameNodes).length > LIMITS.nodes) return fail('renameNodes inválido.', packageId);
    patch.renameNodes = {};
    for (const [from, to] of Object.entries(raw.renameNodes)) {
      if (!NODE_ID.test(from) || typeof to !== 'string' || !NODE_ID.test(to)) return fail('renameNodes contiene identificadores inválidos.', packageId);
      patch.renameNodes[from] = to;
    }
  }
  if (raw.views !== undefined) {
    if (!isObject(raw.views)) return fail('views inválido.', packageId);
    patch.views = {};
    if (raw.views.remove !== undefined) {
      if (!Array.isArray(raw.views.remove) || raw.views.remove.length > LIMITS.views || raw.views.remove.some(id => typeof id !== 'string' || !VIEW_ID.test(id))) return fail('views.remove inválido.', packageId);
      patch.views.remove = raw.views.remove as string[];
    }
    if (raw.views.upsert !== undefined) {
      if (!Array.isArray(raw.views.upsert) || raw.views.upsert.length > LIMITS.views) return fail('views.upsert inválido.', packageId);
      patch.views.upsert = raw.views.upsert.map(view => {
        if (!isObject(view) || typeof view.table !== 'string' || view.table.length > LIMITS.string || !['full', 'compact', 'connector'].includes(String(view.display))) return fail('Vista externa inválida: se requiere table y display.', packageId);
        if (typeof view.id !== 'string' || !VIEW_ID.test(view.id)) return fail('Vista externa inválida: se requiere un id (letras, números, _ o -).', packageId);
        if (view.show !== undefined && (!Array.isArray(view.show) || view.show.length > LIMITS.show || view.show.some(c => typeof c !== 'string' || c.length > 128))) return fail('Vista externa inválida: show.', packageId);
        if (view.label !== undefined && (typeof view.label !== 'string' || view.label.length > 60)) return fail('Vista externa inválida: label (máx. 60 caracteres).', packageId);
        if (view.relationship !== undefined && (typeof view.relationship !== 'string' || view.relationship.length > 2000)) return fail('Vista externa inválida: relationship.', packageId);
        const clean: ExternalView = { table: view.table, display: view.display as ExternalView['display'], id: view.id };
        if (view.show) clean.show = view.show as string[];
        if (view.label) clean.label = view.label as string;
        if (view.relationship) clean.relationship = view.relationship as string;
        return clean;
      });
    }
  }
  return patch;
}

/** Devuelve una nueva configuración con el parche aplicado; la original no se modifica. */
export function applyDiagramPatch(config: DiagramConfig | undefined, rawPatch: unknown, packageId?: string): DiagramConfig {
  const patch = validatePatch(rawPatch, packageId);
  const next: DiagramConfig = { ...(config ?? {}), ...(config?.external ? { external: config.external.map(v => ({ ...v })) } : {}), ...(config?.layout ? { layout: { ...config.layout } } : {}) };
  if (patch.renameNodes) {
    const layout = { ...(next.layout ?? {}) };
    for (const [from, to] of Object.entries(patch.renameNodes)) if (layout[from] && !layout[to]) { layout[to] = layout[from]!; delete layout[from]; }
    next.layout = layout;
  }
  if (patch.layout) {
    const layout = { ...(next.layout ?? {}) };
    for (const [id, position] of Object.entries(patch.layout)) { if (position === null) delete layout[id]; else layout[id] = position; }
    if (Object.keys(layout).length > LIMITS.nodes) fail('Demasiadas posiciones guardadas.', packageId);
    next.layout = layout;
  }
  if (patch.views) {
    let external = [...(next.external ?? [])];
    for (const id of patch.views.remove ?? []) external = external.filter(v => v.id !== id);
    for (const view of patch.views.upsert ?? []) {
      const sameTable = external.filter(v => v.table === view.table);
      // Una entrada sin id que sea la única de su tabla adopta el id nuevo (conserva su posición en la lista).
      const at = external.findIndex(v => v.table === view.table && (v.id === view.id || (v.id === undefined && sameTable.length === 1)));
      if (at >= 0) external[at] = view; else external.push(view);
    }
    if (external.length > LIMITS.views) fail('Demasiadas vistas externas.', packageId);
    next.external = external;
  }
  return next;
}

/** YAML estable (claves ordenadas) para minimizar diferencias en control de versiones. */
export function serializeDiagramConfig(config: DiagramConfig, packageId: string): string {
  const layout = config.layout ? Object.fromEntries(Object.entries(config.layout).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([id, p]) => [id, { x: p.x, y: p.y }])) : undefined;
  const document: Record<string, unknown> = { package: packageId };
  if (config.external?.length) document.external = config.external.map(v => Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined)));
  if (layout && Object.keys(layout).length) document.layout = layout;
  return stringify(document, { lineWidth: 0 });
}
