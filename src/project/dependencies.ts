import type { CompiledProject } from './compiler';
import { findCycles } from './compiler';
import type { Diagram } from '../diagram/model';
import type { PackageId } from './diagnostics';

export interface PackageEdge { from: PackageId; to: PackageId; /** Archivos, relaciones o tablas que originan la dependencia. */ via: string[] }
/**
 * Tres grafos distintos entre paquetes. Que existan FKs en ambos sentidos NO es un ciclo inválido:
 * solo los ciclos de importación entre archivos (advertidos por el compilador) afectan la resolución.
 */
export interface DependencyGraph {
  /** `use` / `reuse` entre archivos de paquetes distintos. */
  imports: PackageEdge[];
  /** El paquete que guarda la FK depende del que define la tabla referenciada. */
  foreignKeys: PackageEdge[];
  /** Un diagrama muestra tablas de otro paquete (vistas externas y conectores). */
  visual: PackageEdge[];
  /** Orden de resolución de importaciones (dependencias primero); los paquetes en ciclo se agrupan al final. */
  order: PackageId[];
  /** Ciclos de importación a nivel de paquete, solo informativos. */
  importCycles: PackageId[][];
}

function addEdge(map: Map<string, PackageEdge>, from: PackageId, to: PackageId, via: string) {
  if (from === to) return;
  const key = `${from}\u0000${to}`;
  const edge = map.get(key) ?? { from, to, via: [] };
  if (!edge.via.includes(via)) edge.via.push(via);
  map.set(key, edge);
}
const sorted = (map: Map<string, PackageEdge>) => [...map.values()].sort((a, b) => a.from.localeCompare(b.from, 'en') || a.to.localeCompare(b.to, 'en'));

export function buildDependencyGraph(compiled: Pick<CompiledProject, 'imports' | 'owners'>, diagrams: Diagram[], packages: PackageId[] = diagrams.map(d => d.packageId)): DependencyGraph {
  const imports = new Map<string, PackageEdge>(), foreignKeys = new Map<string, PackageEdge>(), visual = new Map<string, PackageEdge>();
  for (const edge of compiled.imports) if (edge.toPackage) addEdge(imports, edge.fromPackage, edge.toPackage, `${edge.from} → ${edge.to}`);
  for (const diagram of diagrams) {
    for (const node of diagram.nodes) if (node.kind === 'external') addEdge(visual, diagram.packageId, node.owner, node.tableId);
    for (const relation of diagram.relationships) {
      if (!relation.foreignKey || !relation.references) continue;
      const from = compiled.owners.get(relation.foreignKey.tableId), to = compiled.owners.get(relation.references.tableId);
      if (from && to) addEdge(foreignKeys, from, to, `${relation.foreignKey.tableId}.${relation.foreignKey.columns.join(',')} → ${relation.references.tableId}`);
    }
  }
  const importEdges = sorted(imports);
  const adjacency = new Map<PackageId, PackageId[]>();
  for (const edge of importEdges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const importCycles = findCycles(packages, adjacency);
  // Orden topológico de Kahn sobre los paquetes: primero los que no dependen de nadie.
  const remaining = new Map(packages.map(p => [p, new Set(adjacency.get(p) ?? [])] as const));
  const order: PackageId[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => ![...deps].some(d => remaining.has(d))).map(([p]) => p).sort();
    if (!ready.length) { order.push(...[...remaining.keys()].sort()); break; }
    for (const p of ready) { order.push(p); remaining.delete(p); }
  }
  return { imports: importEdges, foreignKeys: sorted(foreignKeys), visual: sorted(visual), order, importCycles };
}
