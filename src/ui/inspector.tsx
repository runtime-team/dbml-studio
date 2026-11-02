import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUpRight, Link2, Table2, ArrowDownLeft, PanelRightClose } from 'lucide-react';
import type { Connector, Diagram, DiagramRelationship, TableNode } from '../diagram/model';
import { describeRelation, type NavigationTarget, type ReferenceIndexEntry } from '../diagram/navigation';

export type InspectorSection = 'relations' | 'incoming' | undefined;
export interface Definition { tableId: string; packageId: string; file: string; line: number; endLine: number; source: string }

interface Props {
  diagram: Diagram;
  index: Map<string, ReferenceIndexEntry>;
  node?: TableNode;
  relationship?: DiagramRelationship;
  /** Sección que debe mostrarse abierta (p. ej. tras «Ver referencias entrantes»). */
  section?: InspectorSection;
  sectionNonce?: number;
  definition?: Definition | 'loading' | 'missing';
  onNavigate(target: NavigationTarget): void;
  onSelectRelationship(id: string): void;
  onShowDefinition(tableId: string): void;
  onCopyLink?(target: { tableId?: string; connectorId?: string }): void;
  onCollapse?(): void;
  /** Contenido adicional (comentarios en modo colaborativo). */
  extra?: ReactNode;
}

const cardinalityText = (c: string) => {
  const [a, b] = c.split(':');
  const word = (x?: string) => x === '*' ? 'muchos' : x === '1' ? 'uno' : x ?? '?';
  return `${word(a)} → ${word(b)}`;
};

export function Inspector(props: Props) {
  const { diagram, index, node, relationship } = props;
  const entry = node ? index.get(node.tableId) : undefined;
  const relations = useRef<HTMLDetailsElement>(null), incoming = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const target = props.section === 'incoming' ? incoming.current : props.section === 'relations' ? relations.current : null;
    if (target) { target.open = true; target.scrollIntoView?.({ block: 'nearest' }); target.querySelector<HTMLElement>('button')?.focus(); }
  }, [props.section, props.sectionNonce]);
  const connectors: Connector[] = node ? diagram.connectors.filter(c => c.nodeId === node.id) : [];
  const header = (kind: string) => <div className="inspector-title"><strong>Inspector</strong><span>{kind}</span>{props.onCollapse && <button className="panel-toggle" type="button" aria-label="Ocultar inspector" aria-expanded="true" title="Ocultar inspector" onClick={props.onCollapse}><PanelRightClose size={16}/></button>}</div>;

  const relationRow = (relation: DiagramRelationship, tableId: string) => {
    const view = describeRelation(index, tableId, relation);
    return <li key={relation.id}>
      <button className="link-row" onClick={() => view.otherPackage ? props.onNavigate({ packageId: view.otherPackage, tableId: view.otherTableId }) : props.onSelectRelationship(relation.id)} title={`Ir a ${view.otherTableId}${view.otherPackage ? ` en el paquete ${view.otherPackage}` : ''}`}>
        <span className="link-main">{view.otherTableId.replace(/^public\./, '')}<small> · {view.columns.join(', ')} → {view.otherColumns.join(', ')}</small></span>
        <span className="link-meta">{view.otherPackage ?? '—'} · {cardinalityText(view.cardinality)}</span>
      </button>
      <button className="mini" onClick={() => props.onSelectRelationship(relation.id)} aria-label={`Ver detalle de la relación con ${view.otherTableId}`}>Detalle</button>
    </li>;
  };

  if (relationship && !node) {
    const [a, b] = relationship.endpoints;
    return <aside className="inspector" aria-label="Inspector">
      {header('RELACIÓN')}
      <div className="detail-head"><div className="detail-icon"><Link2 size={19}/></div><div><h2>{relationship.name ?? 'Relación'}</h2><p>{a?.cardinality}:{b?.cardinality}</p></div></div>
      <dl className="facts">
        {relationship.endpoints.map((e, i) => <div key={i}><dt>{relationship.foreignKey === e ? 'Guarda la FK' : relationship.references === e ? 'Referenciada' : `Extremo ${i + 1}`}</dt><dd>{e.tableId}.{e.columns.join(', ')} <small>({e.cardinality})</small></dd></div>)}
        <div><dt>Identificador</dt><dd className="mono">{relationship.id.length > 60 ? `${relationship.id.slice(0, 57)}…` : relationship.id}</dd></div>
      </dl>
      <div className="inspector-actions">{relationship.endpoints.map((e, i) => { const owner = index.get(e.tableId)?.owner; return owner ? <button key={i} onClick={() => props.onNavigate({ packageId: owner, tableId: e.tableId })}><ArrowUpRight size={14}/> {e.tableId.replace(/^public\./, '')} ({owner})</button> : null; })}</div>
      {props.extra}
    </aside>;
  }

  if (!node) return <aside className="inspector" aria-label="Inspector">
    {header('DETALLES')}
    <p className="empty">Selecciona una tabla o una relación para ver sus detalles, referencias entrantes y salientes.</p>
    <p className="empty small">Clic derecho o la tecla Menú abren las acciones de cada elemento.</p>
    {props.extra}
  </aside>;

  return <aside className="inspector" aria-label="Inspector">
    {header('TABLA')}
    <div className="detail-head"><div className="detail-icon"><Table2 size={19}/></div><div><h2>{node.name}</h2><p>{node.kind === 'external' ? `Tabla externa · ${node.owner}` : 'Tabla local'} · {node.display}</p></div></div>
    <dl className="facts">
      <div><dt>Identificador</dt><dd className="mono">{node.tableId}</dd></div>
      <div><dt>Propietario</dt><dd><button className="inline-link" onClick={() => props.onNavigate({ packageId: node.owner, tableId: node.tableId })}>{node.owner}</button></dd></div>
      {entry && <div><dt>Aparece en</dt><dd>{entry.packages.map(p => <button key={p} className="chip" onClick={() => props.onNavigate({ packageId: p, tableId: node.tableId })}>{p}</button>)}</dd></div>}
    </dl>
    <h3>Columnas</h3>
    <ul className="columns" aria-label="Columnas">{node.columns.map((c, i) => { const info = node.columnInfo?.[i]; return <li key={c}><span>{c}</span>{info?.pk && <b className="badge pk">PK</b>}{info?.fk && <b className="badge fk">FK</b>}{info?.notNull && !info.pk && <b className="badge nn">NN</b>}<small>{info?.type}</small></li>; })}</ul>
    <div className="inspector-actions">
      <button onClick={() => props.onShowDefinition(node.tableId)}>Ver definición</button>
      <button onClick={() => props.onCopyLink?.({ tableId: node.tableId })} disabled={!props.onCopyLink}>Copiar enlace</button>
    </div>
    {props.definition && <div className="definition">
      {props.definition === 'loading' ? <p>Cargando definición…</p> : props.definition === 'missing' ? <p>No se encontró la definición.</p> : <><p className="mono">{props.definition.file}:{props.definition.line}–{props.definition.endLine}</p><pre>{props.definition.source}</pre></>}
    </div>}
    <details ref={relations} open><summary>Relaciones salientes <b>{entry?.outgoing.length ?? 0}</b></summary>{entry?.outgoing.length ? <ul className="links">{entry.outgoing.map(r => relationRow(r, node.tableId))}</ul> : <p className="empty small">Esta tabla no referencia a otras.</p>}</details>
    <details ref={incoming} open><summary>Referencias entrantes <b>{entry?.incoming.length ?? 0}</b></summary>{entry?.incoming.length ? <ul className="links">{entry.incoming.map(r => relationRow(r, node.tableId))}</ul> : <p className="empty small">Ninguna tabla referencia a esta.</p>}</details>
    {entry && entry.externalIn.length > 0 && <details open><summary>Referencias externas <b>{entry.externalIn.length}</b></summary><ul className="links">{entry.externalIn.map(p => <li key={p}><button className="link-row" onClick={() => props.onNavigate({ packageId: p, tableId: node.tableId })}><span className="link-main">{p}</span><span className="link-meta">muestra esta tabla como externa</span></button></li>)}</ul></details>}
    {connectors.length > 0 && <details open><summary>Conectores <b>{connectors.length}</b></summary><ul className="links">{connectors.map(c => <li key={c.id}>
      <button className="link-row" onClick={() => props.onNavigate({ packageId: c.targetPackageId, tableId: c.targetTableId, connectorId: c.id })}><span className="link-main"><ArrowDownLeft size={13}/> {c.label}<small> · {c.sourceTableId} → {c.targetTableId}</small></span><span className="link-meta">Paquete {c.targetPackageId} · {cardinalityText(c.cardinality)} · {c.optional ? 'opcional' : 'obligatoria'}</span></button>
      <button className="mini" onClick={() => props.onSelectRelationship(c.relationshipId)}>Relación</button>
    </li>)}</ul></details>}
    {props.extra}
  </aside>;
}
