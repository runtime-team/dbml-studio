import { useEffect, useRef, useState } from 'react';

/** Diálogo para elegir las columnas visibles de una tabla externa en modo compacto. */
export function ColumnPicker({ table, columns, selected, onApply, onClose }: { table: string; columns: string[]; selected: string[]; onApply(columns: string[]): void; onClose(): void }) {
  const [picked, setPicked] = useState(new Set(selected));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const toggle = (c: string) => setPicked(p => { const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n; });
  return <div className="overlay" onMouseDown={onClose}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label={`Columnas visibles de ${table}`} onMouseDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <h2>Columnas visibles</h2><p className="empty small">{table}</p>
      <ul className="picker">{columns.map((c, i) => <li key={c}><label><input ref={i === 0 ? first : undefined} type="checkbox" checked={picked.has(c)} onChange={() => toggle(c)}/> {c}</label></li>)}</ul>
      <div className="dialog-actions"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!picked.size} onClick={() => onApply(columns.filter(c => picked.has(c)))}>Aplicar</button></div>
    </div>
  </div>;
}
