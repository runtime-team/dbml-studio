import { useCallback, useEffect, useState } from 'react';
import { History as HistoryIcon, RotateCcw, Save } from 'lucide-react';
import { SharedClient, type RevisionDiff, type RevisionRow } from './shared-api';
import { timeAgo } from './logic';

const KIND: Record<RevisionRow['kind'], string> = { edit: 'Automática', manual: 'Guardada', restore: 'Restauración' };

interface Props { client: SharedClient; projectId: string; canEdit: boolean; revision: number; onRestored(): void; onError(message: string): void; onNavigatePackage(packageId: string): void }

/** Historial de versiones: consulta, comparación con el estado actual o con otra versión, y restauración auditable. */
export function HistoryPanel({ client, projectId, canEdit, revision, onRestored, onError, onNavigatePackage }: Props) {
  const [rows, setRows] = useState<RevisionRow[]>([]);
  const [selected, setSelected] = useState<string>();
  const [against, setAgainst] = useState('current');
  const [diff, setDiff] = useState<RevisionDiff>();
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `${client.project(projectId)}/revisions`;

  const load = useCallback(async () => {
    try { setRows((await client.request<{ revisions: RevisionRow[] }>(base)).revisions); } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }, [client, base]);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => {
    setDiff(undefined); setConfirming(false);
    if (!selected) return;
    let cancelled = false;
    client.request<RevisionDiff>(`${base}/${selected}/diff?against=${encodeURIComponent(against)}`).then(d => { if (!cancelled) setDiff(d); }).catch(e => onError(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; };
  }, [selected, against, revision]);

  const save = async () => {
    setBusy(true);
    try {
      const result = await client.request<{ unchanged: boolean }>(base, { message });
      setMessage(''); await load();
      if (result.unchanged) onError('No hay cambios desde la última versión.');
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    try { await client.request(`${base}/${selected}/restore`, {}); setConfirming(false); setSelected(undefined); await load(); onRestored(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const current = rows.find(r => r.id === selected);

  return <section className="history-panel" aria-label="Historial de versiones">
    <header><h3><HistoryIcon size={14}/> Versiones</h3></header>
    {canEdit && <div className="compose row">
      <input value={message} onChange={e => setMessage(e.target.value)} placeholder="Descripción de la versión (opcional)" maxLength={300} aria-label="Descripción de la versión"/>
      <button className="primary" onClick={() => void save()} disabled={busy}><Save size={13}/> Guardar versión</button>
    </div>}
    {rows.length === 0 ? <p className="empty small">Aún no hay versiones. Se registran automáticamente al dejar de editar.</p> : <ol className="revisions">
      {rows.map(r => <li key={r.id} className={r.id === selected ? 'selected' : ''}>
        <button onClick={() => setSelected(r.id === selected ? undefined : r.id)} aria-pressed={r.id === selected}>
          <span className="rev-head"><b>#{r.seq}</b><span className={`kind ${r.kind}`}>{KIND[r.kind]}</span><time title={new Date(r.createdAt).toLocaleString('es')}>{timeAgo(r.createdAt)}</time></span>
          <span className="rev-message">{r.message}</span>
          <span className="rev-meta">{(r.authorNames?.length ? r.authorNames : [r.authorName ?? 'Sistema']).join(', ')}</span>
        </button>
        <div className="rev-packages">{r.affectedPackages.map(p => <button key={p} className="chip" onClick={() => onNavigatePackage(p)} title={`Paquete afectado: ${p}`}>{p}</button>)}</div>
      </li>)}
    </ol>}
    {current && <div className="diff-view">
      <div className="diff-head">
        <strong>Versión #{current.seq}</strong>
        <label>Comparar con <select value={against} onChange={e => setAgainst(e.target.value)}><option value="current">Estado actual</option>{rows.filter(r => r.id !== current.id).map(r => <option key={r.id} value={r.id}>Versión #{r.seq}</option>)}</select></label>
      </div>
      {!diff ? <p className="empty small">Calculando diferencias…</p> : diff.files.length === 0 && diff.diagrams.length === 0 ? <p className="empty small">Sin diferencias con {against === 'current' ? 'el estado actual' : 'la versión elegida'}.</p> : <>
        <p className="empty small">Paquetes con diferencias: {diff.affectedPackages.join(', ') || '—'}</p>
        {diff.files.map(f => <details key={`${f.packageId}/${f.name}`} open><summary><code>{f.packageId}/{f.name}</code> <span className={`status ${f.status}`}>{f.status === 'added' ? 'añadido' : f.status === 'removed' ? 'eliminado' : 'modificado'}</span> <small>+{f.added} −{f.removed}</small></summary>
          {f.hunks.map((h, i) => <pre key={i} className="hunk" aria-label={`Cambios desde la línea ${h.oldStart}`}>{h.lines.map((l, k) => <span key={k} className={`line ${l.type}`}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}{l.text}{'\n'}</span>)}</pre>)}
        </details>)}
        {diff.diagrams.map(d => <p key={d.packageId} className="diagram-diff">Diagrama {d.packageId}: {d.movedNodes ? `${d.movedNodes} tabla(s) movida(s)` : ''}{d.movedNodes && d.viewsChanged ? ' · ' : ''}{d.viewsChanged ? 'vistas externas modificadas' : ''}</p>)}
      </>}
      {canEdit && (confirming
        ? <div className="confirm" role="alertdialog" aria-label="Confirmar restauración"><p>Se restaurarán los archivos y diagramas de la versión #{current.seq}. El estado actual se conserva en el historial y se crea una versión nueva.</p><div className="dialog-actions"><button onClick={() => setConfirming(false)}>Cancelar</button><button className="primary danger" disabled={busy} onClick={() => void restore()}>Restaurar versión #{current.seq}</button></div></div>
        : <button onClick={() => setConfirming(true)}><RotateCcw size={13}/> Restaurar esta versión…</button>)}
    </div>}
  </section>;
}
