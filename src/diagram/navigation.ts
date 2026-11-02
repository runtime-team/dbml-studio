import type { Connector, Diagram, DiagramRelationship, TableNode } from './model';

export interface ReferenceIndexEntry {
  tableId: string;
  /** Paquete propietario (el que define la tabla), si algún diagrama la muestra. */
  owner?: string;
  relations: DiagramRelationship[];
  /** Relaciones en las que esta tabla es la referenciada (otras tablas apuntan a ella). */
  incoming: DiagramRelationship[];
  /** Relaciones en las que esta tabla guarda la clave foránea. En relaciones n:m el primer extremo es el saliente. */
  outgoing: DiagramRelationship[];
  diagrams: string[];
  packages: string[];
  /** Paquetes cuyo diagrama muestra la tabla como referencia externa (no el propietario). */
  externalIn: string[];
  /** Paquetes de las tablas del otro extremo de cada relación. */
  relatedPackages: string[];
}

/** Index logical relations once, even if they appear in several diagrams. Navegación inversa: no implica relaciones SQL bidireccionales. */
export function buildReferenceIndex(diagrams: Diagram[]): Map<string, ReferenceIndexEntry> {
  const index = new Map<string, ReferenceIndexEntry>();
  const seen = new Map<string, Set<string>>();
  const owners = new Map<string, string>();
  for (const diagram of diagrams) for (const node of diagram.nodes) owners.set(node.tableId, node.owner);
  const ensure = (tableId: string) => {
    let entry = index.get(tableId);
    if (!entry) { entry = { tableId, owner: owners.get(tableId), relations: [], incoming: [], outgoing: [], diagrams: [], packages: [], externalIn: [], relatedPackages: [] }; index.set(tableId, entry); seen.set(tableId, new Set()); }
    return entry;
  };
  for (const diagram of diagrams) {
    for (const node of diagram.nodes) {
      const entry = ensure(node.tableId);
      if (!entry.diagrams.includes(diagram.id)) entry.diagrams.push(diagram.id);
      if (!entry.packages.includes(diagram.packageId)) entry.packages.push(diagram.packageId);
      if (node.kind === 'external' && !entry.externalIn.includes(diagram.packageId)) entry.externalIn.push(diagram.packageId);
    }
    for (const relation of diagram.relationships) for (const endpoint of relation.endpoints) {
      const entry = ensure(endpoint.tableId);
      if (seen.get(endpoint.tableId)!.has(relation.id)) continue;
      seen.get(endpoint.tableId)!.add(relation.id);
      entry.relations.push(relation);
      const holder = relation.foreignKey?.tableId, referenced = relation.references?.tableId;
      const isFirst = relation.endpoints[0]?.tableId === endpoint.tableId;
      if (holder === endpoint.tableId || (!relation.foreignKey && isFirst)) entry.outgoing.push(relation);
      if (referenced === endpoint.tableId || (!relation.foreignKey && !isFirst)) entry.incoming.push(relation);
      // Autorrelaciones: ambos roles sobre la misma tabla.
      if (holder === endpoint.tableId && referenced === endpoint.tableId && !entry.incoming.includes(relation)) entry.incoming.push(relation);
      for (const other of relation.endpoints) {
        const pkg = owners.get(other.tableId);
        if (other.tableId !== endpoint.tableId && pkg && !entry.relatedPackages.includes(pkg)) entry.relatedPackages.push(pkg);
      }
    }
  }
  return index;
}

export interface RelationView { relation: DiagramRelationship; direction: 'incoming' | 'outgoing'; otherTableId: string; otherPackage?: string; columns: string[]; otherColumns: string[]; cardinality: string }

/** Describe una relación desde la tabla consultada: contraparte, paquete a donde navegar y columnas. */
export function describeRelation(index: Map<string, ReferenceIndexEntry>, tableId: string, relation: DiagramRelationship): RelationView {
  const mine = relation.endpoints.find(e => e.tableId === tableId) ?? relation.endpoints[0]!;
  const other = relation.endpoints.find(e => e !== mine) ?? mine;
  const direction = relation.foreignKey ? (relation.foreignKey.tableId === tableId ? 'outgoing' : 'incoming') : (relation.endpoints[0]?.tableId === tableId ? 'outgoing' : 'incoming');
  return { relation, direction, otherTableId: other.tableId, otherPackage: index.get(other.tableId)?.owner, columns: mine.columns, otherColumns: other.columns, cardinality: `${mine.cardinality}:${other.cardinality}` };
}

export interface NavigationTarget { packageId: string; tableId?: string; connectorId?: string }
export interface NavigationState { current: NavigationTarget; back: NavigationTarget[]; forward: NavigationTarget[] }
const HISTORY_LIMIT = 100;
const same = (a: NavigationTarget, b: NavigationTarget) => a.packageId === b.packageId && a.tableId === b.tableId && a.connectorId === b.connectorId;

export function navigate(state: NavigationState, target: NavigationTarget): NavigationState {
  if (same(state.current, target)) return state;
  return { current: target, back: [...state.back, state.current].slice(-HISTORY_LIMIT), forward: [] };
}
export function goBack(state: NavigationState): NavigationState {
  const target = state.back.at(-1);
  return target ? { current: target, back: state.back.slice(0, -1), forward: [...state.forward, state.current] } : state;
}
export function goForward(state: NavigationState): NavigationState {
  const target = state.forward.at(-1);
  return target ? { current: target, back: [...state.back, state.current], forward: state.forward.slice(0, -1) } : state;
}

/** Paquete propietario de una tabla y destino de navegación (el diagrama donde es local). */
export function resolveOwnerTarget(diagrams: Diagram[], tableId: string): NavigationTarget | undefined {
  for (const diagram of diagrams) {
    const node = diagram.nodes.find(n => n.tableId === tableId);
    if (node) return { packageId: node.owner, tableId };
  }
  return undefined;
}

/** Destino de un conector: el diagrama del paquete propietario de la tabla, centrado en ella. */
export const connectorTarget = (connector: Connector): NavigationTarget => ({ packageId: connector.targetPackageId, tableId: connector.targetTableId });

/** Nodo del diagrama que debe centrarse al navegar a una tabla: el local si existe. */
export function focusNode(diagram: Diagram | undefined, tableId: string | undefined): TableNode | undefined {
  if (!diagram || !tableId) return undefined;
  const matches = diagram.nodes.filter(n => n.tableId === tableId);
  return matches.find(n => n.kind === 'local') ?? matches.find(n => n.display !== 'connector') ?? matches[0];
}

export interface RankedItem<T> { item: T; score: number }
/** Búsqueda difusa del selector rápido: prefijo > subcadena > subsecuencia. Desempata por orden original. */
export function rankItems<T>(query: string, items: T[], label: (item: T) => string): RankedItem<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.map(item => ({ item, score: 0 }));
  return items.flatMap(item => {
    const text = label(item).toLowerCase();
    let score = -1;
    if (text === q) score = 100;
    else if (text.startsWith(q)) score = 80;
    else if (text.includes(q)) score = 60 - Math.min(20, text.indexOf(q));
    else { let i = 0; for (const ch of text) if (ch === q[i]) i++; if (i === q.length) score = 20; }
    return score < 0 ? [] : [{ item, score }];
  }).map((entry, order) => ({ ...entry, order })).sort((a, b) => b.score - a.score || a.order - b.order).map(({ item, score }) => ({ item, score }));
}
