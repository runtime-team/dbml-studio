import { useEffect, useRef, useState } from 'react';
import { Check, LayoutGrid, Table2, X } from 'lucide-react';
import type { Diagram } from '../diagram/model';
import type { PackageProblems } from './logic';

interface Props {
  diagrams: Diagram[];
  active: string;
  projectName: string;
  problems: Map<string, PackageProblems>;
  initialDirection: -1 | 0;
  onSelect(packageId: string): void;
  onClose(): void;
}

/** Selector temporal de paquetes, con navegación cíclica por teclado. */
export function ViewSwitcher({ diagrams, active, projectName, problems, initialDirection, onSelect, onClose }: Props) {
  const activeIndex = Math.max(0, diagrams.findIndex(diagram => diagram.packageId === active));
  const [selected, setSelected] = useState(() => (activeIndex + initialDirection + diagrams.length) % diagrams.length);
  const list = useRef<HTMLUListElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const latest = useRef({ diagrams, selected, onSelect, onClose });
  latest.current = { diagrams, selected, onSelect, onClose };

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    list.current?.focus();
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, []);

  useEffect(() => {
    const commitOnShiftRelease = (event: KeyboardEvent) => {
      if (event.key !== 'Shift' || event.shiftKey) return;
      const diagram = latest.current.diagrams[latest.current.selected];
      if (diagram) {
        latest.current.onSelect(diagram.packageId);
        latest.current.onClose();
      }
    };
    const commitOnWindowBlur = () => {
      const diagram = latest.current.diagrams[latest.current.selected];
      if (diagram) {
        latest.current.onSelect(diagram.packageId);
        latest.current.onClose();
      }
    };
    window.addEventListener('keyup', commitOnShiftRelease);
    window.addEventListener('blur', commitOnWindowBlur);
    return () => {
      window.removeEventListener('keyup', commitOnShiftRelease);
      window.removeEventListener('blur', commitOnWindowBlur);
    };
  }, []);

  useEffect(() => {
    setSelected(current => Math.min(current, Math.max(0, diagrams.length - 1)));
  }, [diagrams.length]);

  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [selected]);

  const move = (direction: -1 | 1) => setSelected(current => (current + direction + diagrams.length) % diagrams.length);
  const selectPackage = (packageId: string) => { onSelect(packageId); onClose(); };
  const openSelected = () => {
    const diagram = diagrams[selected];
    if (diagram) selectPackage(diagram.packageId);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key === 'Tab' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.shiftKey || event.key !== 'Tab' ? -1 : 1);
      list.current?.focus();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(1); list.current?.focus(); return; }
    if (event.key === 'Home') { event.preventDefault(); setSelected(0); return; }
    if (event.key === 'End') { event.preventDefault(); setSelected(diagrams.length - 1); return; }
    if (event.key === 'Enter' && !closeButton.current?.contains(event.target as Node)) { event.preventDefault(); openSelected(); }
  };

  return <div className="overlay view-switcher-overlay" onMouseDown={onClose}>
    <section className="view-switcher" role="dialog" aria-modal="true" aria-label="Cambiar vista del proyecto" aria-describedby="view-switcher-help" onMouseDown={event => event.stopPropagation()} onKeyDown={onKeyDown}>
      <header className="view-switcher-header">
        <span className="view-switcher-mark" aria-hidden="true"><LayoutGrid size={17}/></span>
        <div className="view-switcher-title"><h2>Cambiar vista</h2><p title={projectName}>{projectName}</p></div>
        <button ref={closeButton} className="view-switcher-close" type="button" aria-label="Cerrar selector" title="Cerrar (Esc)" onClick={onClose}><X size={17}/></button>
      </header>
      <ul ref={list} className="view-switcher-list" role="listbox" aria-label="Paquetes del proyecto" aria-orientation="horizontal" aria-activedescendant={`view-package-${selected}`} aria-keyshortcuts="Tab Shift+Tab ArrowLeft ArrowRight Enter Escape" tabIndex={0}>
        {diagrams.map((diagram, index) => {
          const current = diagram.packageId === active;
          const packageProblems = problems.get(diagram.packageId);
          const tableCount = diagram.nodes.filter(node => node.kind === 'local').length;
          return <li key={diagram.id} id={`view-package-${index}`} className={`view-switcher-option${selected === index ? ' selected' : ''}`} role="option" aria-selected={selected === index} aria-current={current ? 'page' : undefined} onMouseEnter={() => setSelected(index)} onClick={() => selectPackage(diagram.packageId)}>
            <span className="view-switcher-option-top"><span className="view-switcher-option-icon"><Table2 size={17}/></span>{selected === index && <Check className="view-switcher-check" size={15} aria-hidden="true"/>}</span>
            <span className="view-switcher-option-name" title={diagram.packageId}>{diagram.packageId}</span>
            <span className="view-switcher-option-detail">{tableCount} {tableCount === 1 ? 'tabla local' : 'tablas locales'}</span>
            <span className="view-switcher-option-status">
              {current && <span className="view-switcher-current">Abierta</span>}
              {packageProblems?.errors ? <span className="view-switcher-error">{packageProblems.errors} {packageProblems.errors === 1 ? 'error' : 'errores'}</span> : packageProblems?.warnings ? <span className="view-switcher-warning">{packageProblems.warnings} {packageProblems.warnings === 1 ? 'aviso' : 'avisos'}</span> : null}
            </span>
          </li>;
        })}
      </ul>
      <footer id="view-switcher-help" className="view-switcher-footer">
        <span><kbd>Shift</kbd> + <kbd>Tab</kbd> anterior <kbd>Tab</kbd> siguiente</span>
        <span><kbd>←</kbd>/<kbd>→</kbd> recorrer · soltar <kbd>Shift</kbd> o <kbd>Enter</kbd> abrir · <kbd>Esc</kbd> cancelar</span>
      </footer>
    </section>
  </div>;
}
