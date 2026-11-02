import { AlertTriangle, XCircle } from 'lucide-react';
import type { Diagnostic } from '../project/diagnostics';

/** Lista de diagnósticos con archivo, línea, código y sugerencia. */
export function Problems({ diagnostics, packageId, onOpen, onClose }: { diagnostics: Diagnostic[]; packageId?: string; onOpen(d: Diagnostic): void; onClose(): void }) {
  const shown = packageId ? diagnostics.filter(d => d.packageId === packageId || !d.packageId) : diagnostics;
  return <section className="problems" aria-label="Problemas">
    <header><strong>Problemas</strong><span>{shown.length} {packageId ? `en ${packageId} y generales` : 'en el proyecto'}</span><button className="mini" onClick={onClose} aria-label="Cerrar problemas">Cerrar</button></header>
    {shown.length === 0 ? <p className="empty">No hay problemas.</p> : <ul>
      {shown.map((d, i) => <li key={i} className={d.severity === 'warning' ? 'warning' : 'error'}>
        <button onClick={() => onOpen(d)}>
          {d.severity === 'warning' ? <AlertTriangle size={15}/> : <XCircle size={15}/>}
          <span className="problem-text"><b>{d.message}</b>{d.suggestion && <small>Sugerencia: {d.suggestion}</small>}</span>
          <span className="problem-where">{d.filepath ?? 'proyecto'}{d.location?.start?.line ? `:${d.location.start.line}${d.location.start.column ? `:${d.location.start.column}` : ''}` : ''} · {d.code ?? 'DBML'}</span>
        </button>
      </li>)}
    </ul>}
  </section>;
}
