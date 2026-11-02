import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, MessageSquare, RotateCcw, Trash2 } from 'lucide-react';
import type { Diagram } from '../diagram/model';
import type { NavigationTarget } from '../diagram/navigation';
import { SharedClient, type ThreadView } from './shared-api';
import type { Selection } from './workspace';
import { timeAgo } from './logic';

export type TargetType = ThreadView['targetType'];
const LABELS: Record<TargetType, string> = { project: 'Proyecto', package: 'Paquete', table: 'Tabla', column: 'Columna', relationship: 'Relación', connector: 'Conector' };

/** Comprueba si la entidad comentada sigue existiendo; los comentarios sobreviven aunque cambie el layout o desaparezca el elemento. */
export function targetExists(diagrams: Diagram[], thread: Pick<ThreadView, 'targetType' | 'targetId'>): boolean {
  switch (thread.targetType) {
    case 'project': return true;
    case 'package': return diagrams.some(d => d.packageId === thread.targetId);
    case 'table': return diagrams.some(d => d.nodes.some(n => n.tableId === thread.targetId && n.kind === 'local'));
    case 'column': { const parts = thread.targetId.split('.'); const column = parts.pop() ?? ''; const table = parts.join('.'); return diagrams.some(d => d.nodes.some(n => n.tableId === table && n.kind === 'local' && n.columns.includes(column))); }
    case 'relationship': return diagrams.some(d => d.relationships.some(r => r.id === thread.targetId));
    case 'connector': return diagrams.some(d => d.connectors.some(c => c.id === thread.targetId));
  }
}
const prettyTarget = (thread: Pick<ThreadView, 'targetType' | 'targetId'>) => {
  if (thread.targetType === 'relationship') { try { const [, , endpoints] = JSON.parse(decodeURIComponent(thread.targetId.replace(/^relationship:/, ''))) as [string, string | null, [string, string[]][]]; return endpoints.map(([t, c]) => `${t}.${c.join(',')}`).join(' ↔ '); } catch { return 'relación'; } }
  if (thread.targetType === 'connector') return thread.targetId.replace(/^connector:node:/, '').replace(/:relationship:.*/, '');
  if (thread.targetType === 'project') return 'este proyecto';
  return thread.targetId;
};

interface Props {
  client: SharedClient; projectId: string; diagrams: Diagram[]; selection?: Selection; canComment: boolean; admin: boolean; meId?: string;
  /** Si es verdadero, se listan todas las discusiones del proyecto en vez de las de la selección. */
  all?: boolean; revision: number; onNavigate(target: NavigationTarget): void; onError(message: string): void;
}

/** Discusiones sobre el elemento seleccionado (o todo el proyecto): crear, responder, resolver y navegar al elemento. */
export function CommentsPanel({ client, projectId, diagrams, selection, canComment, admin, meId, all, revision, onNavigate, onError }: Props) {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [body, setBody] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const base = `${client.project(projectId)}/comments`;

  const targets = useMemo(() => {
    const list: { key: string; label: string; type: TargetType; id: string; packageId?: string }[] = [];
    const pkg = selection?.packageId;
    list.push({ key: 'project', label: 'Todo el proyecto', type: 'project', id: projectId });
    if (pkg) list.push({ key: `package|${pkg}`, label: `Paquete ${pkg}`, type: 'package', id: pkg, packageId: pkg });
    if (selection?.tableId) {
      list.push({ key: `table|${selection.tableId}`, label: `Tabla ${selection.tableId}`, type: 'table', id: selection.tableId, packageId: pkg });
      const node = diagrams.flatMap(d => d.nodes).find(n => n.tableId === selection.tableId && n.kind === 'local');
      for (const c of node?.columns ?? []) list.push({ key: `column|${selection.tableId}.${c}`, label: `Columna ${c}`, type: 'column', id: `${selection.tableId}.${c}`, packageId: pkg });
    }
    if (selection?.relationshipId) list.push({ key: `relationship|${selection.relationshipId}`, label: 'Relación seleccionada', type: 'relationship', id: selection.relationshipId, packageId: pkg });
    if (selection?.connectorId) list.push({ key: `connector|${selection.connectorId}`, label: 'Conector seleccionado', type: 'connector', id: selection.connectorId, packageId: pkg });
    return list;
  }, [selection, diagrams, projectId]);
  useEffect(() => { if (!targets.some(t => t.key === targetKey)) setTargetKey(targets[targets.length > 1 && selection?.tableId ? 2 : 0]?.key ?? 'project'); }, [targets]);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ status });
      const result = await client.request<{ threads: ThreadView[] }>(`${base}?${query}`);
      setThreads(result.threads);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }, [client, base, status]);
  useEffect(() => { void load(); }, [load, revision]);

  const visible = useMemo(() => {
    if (all || !selection) return threads;
    // En vista de selección: solo las discusiones del elemento seleccionado y de su paquete/proyecto.
    const keys = new Set(targets.map(t => `${t.type}|${t.id}`));
    return threads.filter(t => keys.has(`${t.targetType}|${t.targetId}`));
  }, [threads, targets, all, selection]);

  const run = async (operation: () => Promise<unknown>) => { try { await operation(); await load(); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } };
  const create = () => {
    const target = targets.find(t => t.key === targetKey); if (!target || !body.trim()) return;
    void run(async () => { await client.request(base, { targetType: target.type, targetId: target.id, packageId: target.packageId, body }); setBody(''); });
  };
  const navigateTo = (thread: ThreadView) => {
    const pkg = thread.packageId ?? (thread.targetType === 'package' ? thread.targetId : undefined) ?? diagrams[0]?.packageId;
    if (!pkg) return;
    if (thread.targetType === 'table') onNavigate({ packageId: diagrams.find(d => d.nodes.some(n => n.tableId === thread.targetId && n.kind === 'local'))?.packageId ?? pkg, tableId: thread.targetId });
    else if (thread.targetType === 'column') onNavigate({ packageId: pkg, tableId: thread.targetId.split('.').slice(0, 2).join('.') });
    else if (thread.targetType === 'connector') onNavigate({ packageId: pkg, connectorId: thread.targetId });
    else onNavigate({ packageId: pkg });
  };

  return <section className="comments" aria-label="Comentarios">
    <header><h3><MessageSquare size={14}/> {all ? 'Todas las discusiones' : 'Comentarios'}</h3>
      <select value={status} onChange={e => setStatus(e.target.value as typeof status)} aria-label="Estado de las discusiones"><option value="open">Abiertas</option><option value="resolved">Resueltas</option><option value="all">Todas</option></select>
    </header>
    {canComment ? <div className="compose">
      <label>Comentar sobre <select value={targetKey} onChange={e => setTargetKey(e.target.value)}>{targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
      <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Escribe un comentario…" maxLength={4000} aria-label="Nuevo comentario" rows={3}/>
      <button className="primary" disabled={!body.trim()} onClick={create}>Comentar</button>
    </div> : <p className="empty small">Inicia sesión con un rol de comentarista o superior para comentar.</p>}
    {visible.length === 0 ? <p className="empty small">No hay discusiones {status === 'open' ? 'abiertas' : status === 'resolved' ? 'resueltas' : ''}{all ? '' : ' para esta selección'}.</p> : <ul className="threads">
      {visible.map(thread => {
        const exists = targetExists(diagrams, thread);
        return <li key={thread.id} className={`thread ${thread.resolved ? 'resolved' : ''}`}>
          <button className="thread-target" onClick={() => navigateTo(thread)} title="Ir al elemento comentado"><b>{LABELS[thread.targetType]}</b> {prettyTarget(thread)}{!exists && <em> · ya no existe</em>}</button>
          {thread.comments.map(c => <div key={c.id} className="comment">
            <div className="comment-head"><strong>{c.authorName ?? 'Cuenta eliminada'}</strong><time dateTime={new Date(c.createdAt).toISOString()} title={new Date(c.createdAt).toLocaleString('es')}>{timeAgo(c.createdAt)}</time>{c.editedAt && <small>(editado)</small>}
              {(c.authorId === meId || admin) && <button className="icon" aria-label="Eliminar comentario" title="Eliminar" onClick={() => { if (confirm(c.id === thread.id && thread.comments.length > 1 ? 'Se eliminará la discusión completa. ¿Continuar?' : '¿Eliminar este comentario?')) void run(() => client.request(`${base}/${c.id}/delete`, {})); }}><Trash2 size={13}/></button>}
            </div>
            <p>{c.body}</p>
          </div>)}
          {thread.resolved && <p className="resolved-note"><Check size={13}/> Resuelta{thread.resolvedAt ? ` ${timeAgo(thread.resolvedAt)}` : ''}</p>}
          {canComment && <div className="reply">
            <input value={replies[thread.id] ?? ''} onChange={e => setReplies(r => ({ ...r, [thread.id]: e.target.value }))} placeholder="Responder…" aria-label="Responder" maxLength={4000}
              onKeyDown={e => { if (e.key === 'Enter' && (replies[thread.id] ?? '').trim()) void run(async () => { await client.request(base, { parentId: thread.id, body: replies[thread.id] }); setReplies(r => ({ ...r, [thread.id]: '' })); }); }}/>
            <button className="mini" onClick={() => void run(() => client.request(`${base}/${thread.id}/resolve`, { resolved: !thread.resolved }))}>{thread.resolved ? <><RotateCcw size={12}/> Reabrir</> : <><Check size={12}/> Resolver</>}</button>
          </div>}
        </li>;
      })}
    </ul>}
  </section>;
}
