import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Table2, Package } from 'lucide-react';
import type { Diagram } from '../diagram/model';
import { rankItems, type NavigationTarget } from '../diagram/navigation';
import type { PackageProblems } from './logic';

interface Item { kind: 'package' | 'table'; key: string; label: string; detail: string; target: NavigationTarget }

/**
 * Selector rápido (Ctrl/Cmd+K): busca paquetes y tablas, se recorre con ↑/↓, Enter abre y Escape cierra.
 * El paquete activo está marcado; los paquetes con errores muestran un indicador.
 */
export function Switcher({ diagrams, active, problems, onOpen, onClose }: { diagrams: Diagram[]; active: string; problems: Map<string, PackageProblems>; onOpen(target: NavigationTarget): void; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => { input.current?.focus(); const restore = opener.current as HTMLElement | null; return () => { if (restore && document.contains(restore)) restore.focus?.(); }; }, []);

  const results = useMemo(() => {
    const packages: Item[] = diagrams.map(d => ({ kind: 'package', key: `p:${d.packageId}`, label: d.packageId, detail: ((n: number) => `${n} ${n === 1 ? 'tabla' : 'tablas'}`)(d.nodes.filter(n => n.kind === 'local').length), target: { packageId: d.packageId } }));
    const tables: Item[] = diagrams.flatMap(d => d.nodes.filter(n => n.kind === 'local').map(n => ({ kind: 'table' as const, key: `t:${n.tableId}`, label: n.name, detail: `${d.packageId} · ${n.tableId}`, target: { packageId: d.packageId, tableId: n.tableId } })));
    const rankedPackages = rankItems(query, packages, i => i.label).map(r => r.item);
    // Las tablas solo aparecen al escribir; así el listado inicial son los paquetes.
    const rankedTables = query.trim() ? rankItems(query, tables, i => i.label).slice(0, 8).map(r => r.item) : [];
    return [...rankedPackages, ...rankedTables];
  }, [diagrams, query]);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => { list.current?.children[selected]?.scrollIntoView?.({ block: 'nearest' }); }, [selected]);

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(s => Math.min(results.length - 1, s + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(s => Math.max(0, s - 1)); }
    else if (event.key === 'Home') { event.preventDefault(); setSelected(0); }
    else if (event.key === 'End') { event.preventDefault(); setSelected(Math.max(0, results.length - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); const item = results[selected]; if (item) onOpen(item.target); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };

  return <div className="overlay" onMouseDown={onClose}>
    <div className="command" role="dialog" aria-modal="true" aria-label="Buscar paquete o tabla" onMouseDown={e => e.stopPropagation()} onKeyDown={onKey}>
      <label className="command-input"><Search size={16}/><input ref={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar paquete o tabla…" role="combobox" aria-expanded="true" aria-controls="switcher-list" aria-activedescendant={results[selected] ? `sw-${selected}` : undefined} aria-label="Buscar"/></label>
      <ul id="switcher-list" role="listbox" ref={list} aria-label="Resultados">
        {results.map((item, i) => {
          const p = item.kind === 'package' ? problems.get(item.label) : undefined;
          return <li key={item.key} id={`sw-${i}`} role="option" aria-selected={i === selected} className={i === selected ? 'selected' : ''} onMouseEnter={() => setSelected(i)} onClick={() => onOpen(item.target)}>
            {item.kind === 'package' ? <Package size={15}/> : <Table2 size={15}/>}
            <span className="sw-label">{item.label}</span><small>{item.detail}</small>
            {item.kind === 'package' && item.label === active && <em className="sw-active">activo</em>}
            {p?.errors ? <em className="sw-error" title={`${p.errors} error(es)`}>{p.errors} error(es)</em> : null}
          </li>;
        })}
        {!results.length && <li className="empty" role="option" aria-selected="false">Sin resultados para «{query}»</li>}
      </ul>
      <footer><kbd>↑</kbd><kbd>↓</kbd> navegar <kbd>Enter</kbd> abrir <kbd>Esc</kbd> cerrar</footer>
    </div>
  </div>;
}
