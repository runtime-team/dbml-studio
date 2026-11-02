import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem { label: string; run?: () => void; disabled?: boolean; separator?: boolean; hint?: string }
/** Compatibilidad con código anterior. */
export type MenuAction = MenuItem;

/**
 * Menú contextual con teclado completo: ↑/↓ recorren las opciones, Inicio/Fin saltan a los extremos,
 * Enter o Espacio activan, Escape o Tab cierran y devuelven el foco a quien lo abrió.
 */
export function ContextMenu({ x, y, actions, close, label = 'Acciones' }: { x: number; y: number; actions: MenuItem[]; close: () => void; label?: string }) {
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  const [position, setPosition] = useState({ left: x, top: y });
  const enabled = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];

  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) });
  }, [x, y, actions.length]);

  useEffect(() => {
    enabled()[0]?.focus();
    const restore = opener.current as HTMLElement | null;
    return () => { if (restore && document.contains(restore)) restore.focus?.(); };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const items = enabled();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (index: number) => { event.preventDefault(); items[(index + items.length) % items.length]?.focus(); };
    if (event.key === 'ArrowDown') focus(current + 1);
    else if (event.key === 'ArrowUp') focus(current <= 0 ? items.length - 1 : current - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(items.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); }
  };

  return <div className="context-menu" role="menu" aria-label={label} ref={menu} onKeyDown={onKeyDown} style={{ left: position.left, top: position.top }}>
    {actions.map((action, index) => action.separator
      ? <div key={`s${index}`} role="separator" className="menu-separator"/>
      : <button role="menuitem" key={`${index}:${action.label}`} disabled={action.disabled} onClick={() => { close(); action.run?.(); }}>
        <span>{action.label}</span>{action.hint && <kbd>{action.hint}</kbd>}
      </button>)}
  </div>;
}
