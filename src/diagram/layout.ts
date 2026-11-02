import type { Diagram, DiagramRelationship, TableNode } from './model';
import type { NodePosition } from '../project/loader';

export const NODE_WIDTH = 260;
export const MARGIN = 48;
export const TOP = 90;
const GAP_X = 96;
const GAP_Y = 40;
/** Altura máxima de una columna de capa antes de abrir otra a su derecha. */
const MAX_COLUMN_HEIGHT = 1500;
export const ROW_HEIGHT = 24;

export interface Box { node: TableNode; x: number; y: number; width: number; height: number }
export interface Layout { width: number; height: number; boxes: Box[] }

export const nodeHeight = (node: TableNode) => node.display === 'connector' ? 140 : 76 + node.columns.length * ROW_HEIGHT;

/** Nodo al que se conectan las aristas de una tabla: el local o el externo completo antes que un conector. */
export function preferredNodes(diagram: Pick<Diagram, 'nodes'>): Map<string, TableNode> {
  const result = new Map<string, TableNode>();
  for (const node of diagram.nodes) {
    const current = result.get(node.tableId);
    const score = (n: TableNode) => (n.kind === 'local' ? 2 : 0) + (n.display === 'connector' ? 0 : 1);
    if (!current || score(node) > score(current)) result.set(node.tableId, node);
  }
  return result;
}

/** Aristas padre → hijo (referenciada → que guarda la FK) entre índices de nodo. */
function graphEdges(diagram: Diagram, index: Map<string, number>): [number, number][] {
  const preferred = preferredNodes(diagram);
  const edges = new Map<string, [number, number]>();
  for (const relation of diagram.relationships) {
    if (relation.endpoints.length !== 2) continue;
    const parentTable = (relation.references ?? relation.endpoints[0]!).tableId;
    const childTable = (relation.foreignKey ?? relation.endpoints[1]!).tableId;
    const a = preferred.get(parentTable), b = preferred.get(childTable);
    if (!a || !b || a === b) continue;
    const pair: [number, number] = [index.get(a.id)!, index.get(b.id)!];
    edges.set(pair.join(':'), pair);
  }
  return [...edges.values()];
}

/** Capas por camino más largo (los ciclos se rompen con las aristas de retroceso del DFS) y barycenter para reducir cruces. */
function layered(count: number, edges: [number, number][], ids: string[]): { layer: number[]; order: number[][] } {
  const children: number[][] = Array.from({ length: count }, () => []);
  for (const [p, c] of edges) children[p]!.push(c);
  for (const list of children) list.sort((x, y) => ids[x]!.localeCompare(ids[y]!, 'en'));
  // DFS iterativo: marca aristas de retroceso para obtener un DAG.
  const state = new Uint8Array(count), back = new Set<string>();
  const start = [...Array(count).keys()].sort((x, y) => ids[x]!.localeCompare(ids[y]!, 'en'));
  for (const root of start) {
    if (state[root]) continue;
    const stack: [number, number][] = [[root, 0]]; state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = children[top[0]]![top[1]++];
      if (next === undefined) { state[top[0]] = 2; stack.pop(); continue; }
      if (state[next] === 1) back.add(`${top[0]}:${next}`);
      else if (!state[next]) { state[next] = 1; stack.push([next, 0]); }
    }
  }
  const dag: number[][] = children.map((list, p) => list.filter(c => !back.has(`${p}:${c}`)));
  const parents: number[][] = Array.from({ length: count }, () => []);
  const indegree = new Array<number>(count).fill(0);
  dag.forEach((list, p) => list.forEach(c => { parents[c]!.push(p); indegree[c]!++; }));
  const layer = new Array<number>(count).fill(0);
  const queue = start.filter(n => indegree[n] === 0);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const c of dag[node]!) { layer[c] = Math.max(layer[c]!, layer[node]! + 1); if (--indegree[c]! === 0) queue.push(c); }
  }
  const depth = Math.max(0, ...layer);
  const order: number[][] = Array.from({ length: depth + 1 }, () => []);
  for (const n of start) order[layer[n]!]!.push(n);
  const rank = new Array<number>(count).fill(0);
  const refresh = () => order.forEach(list => list.forEach((n, i) => { rank[n] = list.length > 1 ? i / (list.length - 1) : 0.5; }));
  refresh();
  const sweep = (neighbours: number[][], layers: number[]) => {
    for (const l of layers) {
      const list = order[l]!;
      const score = new Map(list.map(n => [n, neighbours[n]!.length ? neighbours[n]!.reduce((s, m) => s + rank[m]!, 0) / neighbours[n]!.length : rank[n]!] as const));
      list.sort((x, y) => score.get(x)! - score.get(y)! || ids[x]!.localeCompare(ids[y]!, 'en'));
      list.forEach((n, i) => { rank[n] = list.length > 1 ? i / (list.length - 1) : 0.5; });
    }
  };
  const down = [...Array(depth).keys()].map(i => i + 1), up = [...down].reverse().map(i => i - 1);
  for (let pass = 0; pass < 4; pass++) { sweep(parents, down); sweep(dag, up); }
  return { layer, order };
}

/** Coloca los nodos sin posición. Devuelve posiciones relativas al origen del diagrama. */
function autoPlace(nodes: TableNode[], edges: [number, number][], heights: number[]): Map<number, NodePosition> {
  const result = new Map<number, NodePosition>();
  const connected = new Set<number>();
  for (const [a, b] of edges) { connected.add(a); connected.add(b); }
  const members = [...connected];
  let bottom = TOP;
  if (members.length) {
    const local = new Map(members.map((n, i) => [n, i] as const));
    const { order } = layered(members.length, edges.map(([a, b]) => [local.get(a)!, local.get(b)!]), members.map(n => nodes[n]!.id));
    let x = MARGIN;
    for (const list of order) {
      let y = TOP, columnHeight = 0;
      for (const index of list) {
        const original = members[index]!, height = heights[original]!;
        if (columnHeight > 0 && columnHeight + height > MAX_COLUMN_HEIGHT) { x += NODE_WIDTH + GAP_X; y = TOP; columnHeight = 0; }
        result.set(original, { x, y });
        y += height + GAP_Y; columnHeight += height + GAP_Y; bottom = Math.max(bottom, y);
      }
      x += NODE_WIDTH + GAP_X;
    }
  }
  const isolated = nodes.map((_, i) => i).filter(i => !connected.has(i));
  if (isolated.length) {
    const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(isolated.length))));
    let y = members.length ? bottom + GAP_Y : TOP;
    for (let row = 0; row * columns < isolated.length; row++) {
      const slice = isolated.slice(row * columns, (row + 1) * columns);
      slice.forEach((n, col) => result.set(n, { x: MARGIN + col * (NODE_WIDTH + GAP_X), y }));
      y += Math.max(...slice.map(n => heights[n]!)) + GAP_Y * 2;
    }
  }
  return result;
}

/**
 * Layout determinista. Los nodos con posición persistida (`diagram.layout` u `options.positions`) no se mueven;
 * el resto se coloca por capas debajo de ellos, de modo que un cambio menor no redistribuye todo el diagrama.
 */
export function layoutDiagram(diagram: Diagram, options: { positions?: Record<string, NodePosition> } = {}): Layout {
  const fixed = { ...(diagram.layout ?? {}), ...(options.positions ?? {}) };
  const heights = diagram.nodes.map(nodeHeight);
  const index = new Map(diagram.nodes.map((n, i) => [n.id, i] as const));
  const auto = diagram.nodes.map((_, i) => i).filter(i => !fixed[diagram.nodes[i]!.id]);
  const positions = new Map<number, NodePosition>();
  diagram.nodes.forEach((n, i) => { const p = fixed[n.id]; if (p) positions.set(i, p); });
  let pending = auto;
  if (auto.length && positions.size) {
    // Los nodos nuevos con un vecino ya fijado se colocan a su lado (referenciada a la izquierda, referencia a la derecha),
    // en el primer hueco libre, para no moverlo ni dejar el nodo lejos de su relación.
    const taken = (x: number, y: number, h: number) => [...positions].some(([i, p]) => x < p.x + NODE_WIDTH + GAP_X / 2 && p.x < x + NODE_WIDTH + GAP_X / 2 && y < p.y + heights[i]! + GAP_Y / 2 && p.y < y + h + GAP_Y / 2);
    const links = graphEdges(diagram, index);
    const near = new Set<number>();
    for (const i of [...auto].sort((x, y) => diagram.nodes[x]!.id.localeCompare(diagram.nodes[y]!.id, 'en'))) {
      const link = links.find(([p, c]) => (p === i && positions.has(c)) || (c === i && positions.has(p)));
      if (!link) continue;
      const parent = link[0] === i, anchor = positions.get(parent ? link[1] : link[0])!;
      let x = parent ? anchor.x - NODE_WIDTH - GAP_X : anchor.x + NODE_WIDTH + GAP_X;
      if (x < MARGIN) x = anchor.x + NODE_WIDTH + GAP_X;
      let y = anchor.y;
      for (let guard = 0; taken(x, y, heights[i]!) && guard < 2000; guard++) y += 24;
      positions.set(i, { x, y }); near.add(i);
    }
    pending = auto.filter(i => !near.has(i));
  }
  if (pending.length) {
    const auto = pending;
    const subset = auto.map(i => diagram.nodes[i]!);
    const subIndex = new Map(subset.map((n, i) => [n.id, i] as const));
    const edges = graphEdges(diagram, index).filter(([a, b]) => subIndex.has(diagram.nodes[a]!.id) && subIndex.has(diagram.nodes[b]!.id)).map(([a, b]) => [subIndex.get(diagram.nodes[a]!.id)!, subIndex.get(diagram.nodes[b]!.id)!] as [number, number]);
    const placed = autoPlace(subset, edges, auto.map(i => heights[i]!));
    let shift = 0;
    if (positions.size) shift = Math.max(...[...positions].map(([i, p]) => p.y + heights[i]!)) + GAP_Y * 2 - TOP;
    auto.forEach((original, i) => { const p = placed.get(i)!; positions.set(original, { x: p.x, y: p.y + shift }); });
  }
  const boxes: Box[] = diagram.nodes.map((node, i) => ({ node, x: positions.get(i)!.x, y: positions.get(i)!.y, width: NODE_WIDTH, height: heights[i]! }));
  const width = Math.max(320, ...boxes.map(b => b.x + b.width + MARGIN));
  const height = Math.max(180, ...boxes.map(b => b.y + b.height + MARGIN));
  return { width, height, boxes };
}

export interface EdgeGeometry {
  path: string;
  start: { x: number; y: number; anchor: 'start' | 'end' };
  end: { x: number; y: number; anchor: 'start' | 'end' };
  mid: { x: number; y: number };
}

/** Ordenada del centro de la fila de una columna visible (o del centro del nodo si no es visible o es un conector). */
export function anchorY(box: Box, column?: string): number {
  const row = column && box.node.display !== 'connector' ? box.node.columns.indexOf(column) : -1;
  if (row >= 0) return box.y + 67 + row * ROW_HEIGHT;
  return box.y + (box.node.display === 'connector' ? (box.height - 20) / 2 : box.height / 2);
}

/** Curva de Bézier entre los bordes de dos nodos, anclada en la fila de la clave. Las relaciones paralelas usan filas distintas. */
export function routeEdge(a: Box, b: Box, aColumn?: string, bColumn?: string, aSlot = 0, bSlot = 0): EdgeGeometry {
  const ay = anchorY(a, aColumn) + aSlot, by = anchorY(b, bColumn) + bSlot;
  if (a === b || (a.x < b.x + b.width && b.x < a.x + a.width)) {
    // Mismo nodo o nodos apilados: la arista sale por la derecha y vuelve.
    const x = Math.max(a.x + a.width, b.x + b.width), out = 48 + (a === b ? 12 : 0);
    const y2 = a === b && Math.abs(ay - by) < 10 ? by + 18 : by;
    return { path: `M ${a.x + a.width} ${ay} C ${x + out} ${ay}, ${x + out} ${y2}, ${b.x + b.width} ${y2}`, start: { x: a.x + a.width + 8, y: ay - 6, anchor: 'start' }, end: { x: b.x + b.width + 8, y: y2 - 6, anchor: 'start' }, mid: { x: x + out * 0.75, y: (ay + y2) / 2 } };
  }
  const rightward = a.x + a.width <= b.x;
  const sx = rightward ? a.x + a.width : a.x, ex = rightward ? b.x : b.x + b.width;
  const control = Math.min(160, Math.max(40, Math.abs(ex - sx) / 2)) * (rightward ? 1 : -1);
  return {
    path: `M ${sx} ${ay} C ${sx + control} ${ay}, ${ex - control} ${by}, ${ex} ${by}`,
    start: { x: sx + (rightward ? 8 : -8), y: ay - 6, anchor: rightward ? 'start' : 'end' },
    end: { x: ex + (rightward ? -8 : 8), y: by - 6, anchor: rightward ? 'end' : 'start' },
    mid: { x: (sx + ex) / 2, y: (ay + by) / 2 },
  };
}

export function relationshipEnds(diagram: Diagram, relation: DiagramRelationship, boxes: Box[]): { a: Box; b: Box; aColumn?: string; bColumn?: string; aSlot: number; bSlot: number } | undefined {
  if (relation.endpoints.length !== 2) return undefined;
  const preferred = preferredNodes(diagram);
  const [ea, eb] = relation.endpoints as [DiagramRelationship['endpoints'][number], DiagramRelationship['endpoints'][number]];
  const na = preferred.get(ea.tableId), nb = preferred.get(eb.tableId);
  const a = na && boxes.find(b => b.node.id === na.id), b = nb && boxes.find(box => box.node.id === nb.id);
  if (!a || !b) return undefined;
  // Un conector no tiene filas: las relaciones que comparten uno se reparten a lo alto para poder distinguirlas.
  const slot = (box: Box) => {
    if (box.node.display !== 'connector') return 0;
    const siblings = diagram.relationships.filter(r => r.endpoints.some(e => e.tableId === box.node.tableId) && relationshipEndsExist(diagram, r, boxes));
    const at = siblings.findIndex(r => r.id === relation.id);
    return siblings.length > 1 && at >= 0 ? (at - (siblings.length - 1) / 2) * 16 : 0;
  };
  return { a, b, aColumn: ea.columns[0], bColumn: eb.columns[0], aSlot: slot(a), bSlot: slot(b) };
}

function relationshipEndsExist(diagram: Diagram, relation: DiagramRelationship, boxes: Box[]): boolean {
  if (relation.endpoints.length !== 2) return false;
  const preferred = preferredNodes(diagram);
  return relation.endpoints.every(e => { const node = preferred.get(e.tableId); return !!node && boxes.some(b => b.node.id === node.id); });
}
