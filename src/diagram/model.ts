import { createHash } from 'node:crypto';
import type { CompiledProject } from '../project/compiler';
import type { DiagramConfig, ExternalView, NodePosition, Project, SourcePackage } from '../project/loader';
import { Codes, StudioError, type ConnectorId, type Diagnostic, type DiagramId, type NodeId, type PackageId, type RelationshipId, type TableId } from '../project/diagnostics';

type Schema = CompiledProject['schema'];
type SchemaTable = Schema['schemas'][number]['tables'][number];
export type DisplayMode = 'full' | 'compact' | 'connector';

export interface ColumnInfo { name: string; type: string; pk: boolean; notNull: boolean; fk: boolean }
/** Instancia visual de una tabla. Una tabla lógica puede tener varios nodos, pero un solo `tableId`. */
export interface TableNode {
  id: NodeId; tableId: TableId; owner: PackageId; kind: 'local' | 'external';
  name: string; columns: string[]; display: DisplayMode;
  /** Metadatos de las columnas visibles, en el mismo orden que `columns`. */
  columnInfo?: ColumnInfo[];
}
export interface RelationshipEndpoint { tableId: TableId; columns: string[]; cardinality: string }
export interface DiagramRelationship {
  id: RelationshipId; endpoints: RelationshipEndpoint[];
  /** Nombre declarado en el DBML (`Ref nombre: …`), si existe. */
  name?: string;
  /** Extremo que guarda la clave foránea, cuando se puede determinar (no existe en relaciones n:m). */
  foreignKey?: RelationshipEndpoint;
  /** Extremo referenciado. */
  references?: RelationshipEndpoint;
}
export interface Connector {
  id: ConnectorId; nodeId: NodeId; relationshipId: RelationshipId;
  sourceTableId: TableId; targetTableId: TableId;
  sourcePackageId: PackageId; targetPackageId: PackageId;
  /** Etiqueta impresa estable, p. ej. `CAT-01`. No contiene números de página. */
  label: string;
  /** Cardinalidad original vista desde la tabla local, p. ej. `*:1`. */
  cardinality: string;
  /** `true` si la columna local de la clave foránea admite nulos. */
  optional: boolean;
  endpoints: DiagramRelationship['endpoints'];
}
export interface Diagram {
  id: DiagramId; packageId: PackageId; nodes: TableNode[]; relationships: DiagramRelationship[]; connectors: Connector[];
  /** Posiciones persistidas (`diagram.yaml` o estado compartido). */
  layout?: Record<NodeId, NodePosition>;
  /** Problemas de configuración de este diagrama; el resto del diagrama se genera igualmente. */
  diagnostics?: Diagnostic[];
  /** Huella determinista del contenido; permite refrescar solo los diagramas que cambiaron. */
  hash?: string;
}

function relationshipsOf(schema: Schema, tables: Map<TableId, SchemaTable>): DiagramRelationship[] {
  const relations = schema.schemas.flatMap(s => s.refs.map(ref => {
    const endpoints = ref.endpoints.map(e => ({ tableId: `${e.schemaName || 'public'}.${e.tableName}`, columns: e.fieldNames, cardinality: String(e.relation) }));
    const key = JSON.stringify([s.name, ref.name ?? null, endpoints.map(e => [e.tableId, e.columns])]);
    const relation: DiagramRelationship = { id: `relationship:${encodeURIComponent(key)}`, endpoints };
    if (ref.name) relation.name = ref.name;
    const holder = foreignKeyHolder(endpoints, tables);
    if (holder != null) { relation.foreignKey = endpoints[holder]!; relation.references = endpoints[1 - holder]!; }
    return relation;
  }));
  const ids = new Set<string>();
  for (const relation of relations) {
    if (ids.has(relation.id)) throw new StudioError([{ code: Codes.connectorRelation, severity: 'error', message: `Relación duplicada o ambigua: ${relation.id}`, suggestion: 'Dos relaciones idénticas entre las mismas columnas; elimina una.' }]);
    ids.add(relation.id);
  }
  return relations;
}

/** Índice del extremo que guarda la FK: el lado «muchos»; en 1:1, el lado que no es clave primaria. */
export function foreignKeyHolder(endpoints: RelationshipEndpoint[], tables: Map<TableId, SchemaTable>): 0 | 1 | undefined {
  if (endpoints.length !== 2) return undefined;
  const [a, b] = endpoints as [RelationshipEndpoint, RelationshipEndpoint];
  if (a.cardinality === '*' && b.cardinality !== '*') return 0;
  if (b.cardinality === '*' && a.cardinality !== '*') return 1;
  if (a.cardinality === '*' && b.cardinality === '*') return undefined;
  const isPk = (e: RelationshipEndpoint) => { const t = tables.get(e.tableId); return !!t && e.columns.every(c => t.fields.find(f => f.name === c)?.pk); };
  if (isPk(a) && !isPk(b)) return 1;
  if (isPk(b) && !isPk(a)) return 0;
  return 1;
}

const fail = (diag: Diagnostic): never => { throw new StudioError([diag]); };

interface Context {
  project: Project; compiled: CompiledProject; tables: Map<TableId, SchemaTable>; relations: DiagramRelationship[];
}

function buildDiagram(pkg: SourcePackage, ctx: Context, report: (d: Diagnostic) => void, configOverride?: DiagramConfig): Diagram {
  const { compiled, tables, relations } = ctx;
  const config = configOverride ?? pkg.diagram;
  const where = { packageId: pkg.id, filepath: `${pkg.id}/diagram.yaml` };
  const locals = [...tables.keys()].filter(id => compiled.owners.get(id) === pkg.id);
  const localSet = new Set(locals);
  const relevant = relations.filter(r => r.endpoints.some(e => localSet.has(e.tableId)));
  // Se dibujan las tablas locales y las que ellas referencian. Quien referencia a una tabla local desde otro paquete
  // se consulta como referencia entrante en el inspector (o se añade a propósito con una vista externa); así un
  // catálogo usado por muchos paquetes no inunda su propio diagrama.
  const nodeIds = new Set([...locals, ...relevant.flatMap(r => {
    const holder = r.foreignKey?.tableId;
    return r.endpoints.filter(e => localSet.has(e.tableId) || !holder || localSet.has(holder)).map(e => e.tableId);
  })]);
  const views: ExternalView[] = [];
  for (const [position, view] of (config?.external ?? []).entries()) {
    const at = `external[${position}]`;
    const bad = (code: string, message: string, suggestion?: string) => report({ ...where, severity: 'error', code, message: `${message} (${at})`, suggestion });
    if (!view || typeof view.table !== 'string' || !['full', 'compact', 'connector'].includes(view.display)) { bad(Codes.externalInvalid, `Representación externa inválida en ${pkg.id}`, 'Cada entrada requiere table y display: full | compact | connector.'); continue; }
    const table = tables.get(view.table);
    if (!table || !compiled.owners.has(view.table)) { bad(Codes.externalMissingTable, `Tabla externa inexistente: ${view.table}`, `Usa el nombre lógico esquema.tabla. Tablas disponibles: ${[...compiled.owners.keys()].slice(0, 8).join(', ')}${compiled.owners.size > 8 ? '…' : ''}`); continue; }
    if (compiled.owners.get(view.table) === pkg.id) { bad(Codes.externalLocalTable, `La tabla ${view.table} pertenece al paquete ${pkg.id}`, 'Las vistas externas solo se definen para tablas de otros paquetes.'); continue; }
    if (view.show && (!Array.isArray(view.show) || view.show.some(column => !table.fields.some(field => field.name === column)))) { bad(Codes.externalColumn, `Columnas inválidas para ${view.table}`, `Columnas disponibles: ${table.fields.map(f => f.name).join(', ')}`); continue; }
    if (view.display === 'compact' && !view.show?.length) { bad(Codes.compactColumns, `La representación compacta de ${view.table} requiere columnas`, 'Añade show: [col1, col2].'); continue; }
    if (view.relationship && (view.display !== 'connector' || !relevant.some(r => r.id === view.relationship && r.endpoints.some(e => e.tableId === view.table)))) { bad(Codes.connectorRelation, `Relación de conector inválida: ${view.relationship}`, 'El identificador debe pertenecer a una relación entre este paquete y la tabla externa.'); continue; }
    if (view.display === 'connector' && !relevant.some(r => r.endpoints.some(e => e.tableId === view.table))) { bad(Codes.connectorNoRelation, `El conector ${view.table} no tiene relación con una tabla local`, 'Un conector representa una relación que continúa en otro diagrama; declara primero la relación.'); continue; }
    views.push(view);
    nodeIds.add(view.table);
  }

  const fkColumns = (tableId: TableId) => new Set(relations.flatMap(r => r.foreignKey?.tableId === tableId ? r.foreignKey.columns : []));
  const info = (tableId: TableId, names: string[]): ColumnInfo[] => {
    const table = tables.get(tableId)!, fks = fkColumns(tableId);
    return names.map(name => { const field = table.fields.find(f => f.name === name)!; return { name, type: field.type.type_name, pk: !!field.pk, notNull: !!field.not_null, fk: fks.has(name) }; });
  };
  const nodes: TableNode[] = [...nodeIds].sort().flatMap(tableId => {
    const table = tables.get(tableId); const owner = compiled.owners.get(tableId);
    if (!table || !owner) return [];
    const kind: TableNode['kind'] = owner === pkg.id ? 'local' : 'external';
    const configs = views.filter(view => view.table === tableId);
    const all = table.fields.map(f => f.name);
    if (!configs.length) return [{ id: `node:${pkg.id}:${tableId}`, tableId, owner, kind, name: table.name, columns: all, display: 'full' as const, columnInfo: info(tableId, all) }];
    return configs.map((view, index) => {
      const columns = view.display === 'compact' ? view.show! : all;
      return { id: `node:${pkg.id}:${tableId}:${view.id ?? index}`, tableId, owner, kind, name: table.name, columns, display: view.display, columnInfo: info(tableId, columns) };
    });
  });
  const ids = new Set<string>();
  const unique = nodes.filter(node => { if (ids.has(node.id)) { report({ ...where, severity: 'error', code: Codes.externalInvalid, message: `Identificador de nodo duplicado: ${node.id}`, suggestion: 'Asigna un id distinto a cada vista de la misma tabla.' }); return false; } ids.add(node.id); return true; });

  const connectors: Connector[] = unique.filter(node => node.display === 'connector').flatMap(node => {
    const config = views.find(v => v.table === node.tableId && node.id.endsWith(`:${v.id ?? views.filter(x => x.table === v.table).indexOf(v)}`));
    return relevant.filter(r => r.endpoints.some(e => e.tableId === node.tableId) && (!config?.relationship || config.relationship === r.id)).flatMap(r => {
      const local = r.endpoints.find(e => localSet.has(e.tableId));
      const remote = r.endpoints.find(e => e.tableId === node.tableId);
      if (!local || !remote) return [];
      const localTable = tables.get(local.tableId)!;
      const holdsKey = r.foreignKey === local;
      // Opcional si la columna local de la FK admite nulos; si la tabla local es la referenciada, un registro puede no tener hijos.
      const optional = holdsKey ? local.columns.some(c => !localTable.fields.find(f => f.name === c)?.not_null) : true;
      return [{ id: `connector:${node.id}:${r.id}`, nodeId: node.id, relationshipId: r.id, sourceTableId: local.tableId, targetTableId: node.tableId, sourcePackageId: pkg.id, targetPackageId: node.owner, label: config?.label ?? `${node.owner}:${node.name}`, cardinality: `${local.cardinality}:${remote.cardinality}`, optional, endpoints: r.endpoints }];
    });
  });
  const layout = config?.layout ? Object.fromEntries(Object.entries(config.layout).filter(([id]) => ids.has(id))) : undefined;
  const diagram: Diagram = { id: `diagram:${pkg.id}`, packageId: pkg.id, nodes: unique, relationships: relevant, connectors };
  if (layout && Object.keys(layout).length) diagram.layout = layout;
  return diagram;
}

function contextOf(project: Project, compiled: CompiledProject): Context {
  const tables = new Map<TableId, SchemaTable>(compiled.schema.schemas.flatMap(s => s.tables.map(t => [`${s.name}.${t.name}`, t] as const)));
  return { project, compiled, tables, relations: relationshipsOf(compiled.schema, tables) };
}

export const diagramHash = (diagram: Omit<Diagram, 'hash'>) => createHash('sha1').update(JSON.stringify(diagram)).digest('hex').slice(0, 16);

/** Visual nodes reference the logical table ID; external nodes do not create schema entities. Estricto: cualquier error de configuración lanza `StudioError`. */
export function compileDiagrams(project: Project, compiled: CompiledProject): Diagram[] {
  const ctx = contextOf(project, compiled);
  return project.packages.map(pkg => buildDiagram(pkg, ctx, fail));
}

/**
 * Variante tolerante: una configuración errónea de un paquete se informa como diagnóstico de ese paquete
 * y su diagrama se genera sin las vistas defectuosas. `overrides` permite usar configuraciones compartidas.
 */
export function compileDiagramSet(project: Project, compiled: CompiledProject, overrides: Record<PackageId, DiagramConfig | undefined> = {}): { diagrams: Diagram[]; diagnostics: Diagnostic[] } {
  const ctx = contextOf(project, compiled);
  const diagnostics: Diagnostic[] = [];
  const diagrams = project.packages.map(pkg => {
    const own: Diagnostic[] = [];
    const diagram = buildDiagram(pkg, ctx, d => own.push(d), overrides[pkg.id]);
    diagnostics.push(...own);
    if (own.length) diagram.diagnostics = own;
    diagram.hash = diagramHash(diagram);
    return diagram;
  });
  return { diagrams, diagnostics };
}
