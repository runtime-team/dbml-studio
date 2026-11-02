import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Diagram, TableNode } from '../diagram/model';
import { layoutDiagram } from '../diagram/layout';
import { renderSvg } from '../diagram/svg';
import { GRID } from './logic';

export interface CanvasHandle {
  /** Centra el visor en un nodo. */
  centerOn(nodeId: string): void;
  /** Ajusta el zoom para ver el diagrama completo y devuelve el valor aplicado. */
  fit(): number;
}
export interface ViewState { zoom: number; left: number; top: number }

interface Props {
  diagram: Diagram;
  view: ViewState;
  editable: boolean;
  selectedTable?: string;
  selectedRelationship?: string;
  highlightNodeId?: string;
  /** Número de discusiones abiertas por `tabla|id`; se muestran como insignias sobre la tabla. */
  commentCounts?: Record<string, number>;
  onView(view: ViewState): void;
  onSelectNode(node: TableNode | undefined): void;
  onSelectRelationship(id: string): void;
  /** Doble clic o Enter sobre una tabla externa o un conector. */
  onActivateNode(node: TableNode): void;
  onNodeMenu(node: TableNode, x: number, y: number): void;
  onBackgroundMenu?(x: number, y: number): void;
  /** Posiciones nuevas tras arrastrar o mover con el teclado. Debe resolverse al terminar de guardar. */
  onMove(moved: Record<string, { x: number; y: number }>): Promise<void> | void;
  onCommentBadge?(node: TableNode): void;
}

export const MIN_ZOOM = 0.25, MAX_ZOOM = 2.5;
const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));

/**
 * Visor del diagrama: desplazamiento (barras o arrastrando el fondo), zoom (botones, Ctrl+rueda), arrastre de tablas,
 * y movimiento con teclado (Alt+flechas). Los eventos se delegan sobre el SVG generado por `renderSvg`.
 */
export const DiagramCanvas = forwardRef<CanvasHandle, Props>(function DiagramCanvas(props, ref) {
  const { diagram, view, editable } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number }>();
  const dragState = useRef<{ id: string; startX: number; startY: number; ox: number; oy: number; moved: boolean; pending?: number } | null>(null);
  const panState = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const nudge = useRef<{ moved: Record<string, { x: number; y: number }>; timer?: ReturnType<typeof setTimeout> }>({ moved: {} });
  const viewRef = useRef(view); viewRef.current = view;

  const layout = useMemo(() => layoutDiagram(diagram), [diagram]);
  const svg = useMemo(() => renderSvg(diagram, {
    positions: drag ? { [drag.id]: { x: drag.x, y: drag.y } } : undefined,
    highlight: props.highlightNodeId, selectedTable: props.selectedTable, selectedRelationship: props.selectedRelationship,
  }), [diagram, drag, props.highlightNodeId, props.selectedTable, props.selectedRelationship]);
  const live = useMemo(() => drag ? layoutDiagram(diagram, { positions: { [drag.id]: { x: drag.x, y: drag.y } } }) : layout, [diagram, drag, layout]);

  const nodeById = useCallback((id: string | null | undefined) => diagram.nodes.find(n => n.id === id), [diagram]);
  const nodeOf = (target: EventTarget | null) => nodeById((target as Element | null)?.closest?.('[data-node]')?.getAttribute('data-node'));

  useImperativeHandle(ref, () => ({
    centerOn(nodeId) {
      const el = scroller.current, box = layout.boxes.find(b => b.node.id === nodeId);
      if (!el || !box) return;
      const zoom = viewRef.current.zoom;
      el.scrollTo({ left: Math.max(0, (box.x + box.width / 2) * zoom - el.clientWidth / 2), top: Math.max(0, (box.y + box.height / 2) * zoom - el.clientHeight / 2), behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    },
    fit() {
      const el = scroller.current;
      if (!el) return viewRef.current.zoom;
      return clamp(Math.min(1, (el.clientWidth - 16) / layout.width, (el.clientHeight - 16) / layout.height));
    },
  }), [layout]);

  // Restaura el desplazamiento guardado al cambiar de diagrama.
  useEffect(() => { const el = scroller.current; if (el) { el.scrollLeft = viewRef.current.left; el.scrollTop = viewRef.current.top; } }, [diagram.id]);

  // Ctrl + rueda: zoom centrado en el puntero. Listener nativo porque React registra la rueda como pasiva.
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = viewRef.current, next = clamp(current.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
      if (next === current.zoom) return;
      const rect = el.getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top;
      const cx = (el.scrollLeft + px) / current.zoom, cy = (el.scrollTop + py) / current.zoom;
      props.onView({ zoom: next, left: Math.max(0, cx * next - px), top: Math.max(0, cy * next - py) });
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, cx * next - px); el.scrollTop = Math.max(0, cy * next - py); });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [props.onView]);

  const commit = async (moved: Record<string, { x: number; y: number }>) => {
    try { await props.onMove(moved); } finally { setDrag(undefined); }
  };

  // El puntero solo se captura cuando empieza un arrastre: capturarlo en pointerdown desviaría el `click` posterior
  // al contenedor y la tabla dejaría de poder seleccionarse con un simple clic.
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const node = nodeOf(event.target);
    if (node && editable && event.button === 0) {
      const box = layout.boxes.find(b => b.node.id === node.id)!;
      dragState.current = { id: node.id, startX: event.clientX, startY: event.clientY, ox: box.x, oy: box.y, moved: false };
    } else if (!node) {
      const el = scroller.current!;
      panState.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = dragState.current;
    if (d) {
      const dx = event.clientX - d.startX, dy = event.clientY - d.startY;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < 5) return;
        d.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (d.pending) cancelAnimationFrame(d.pending);
      const zoom = viewRef.current.zoom;
      d.pending = requestAnimationFrame(() => setDrag({ id: d.id, x: Math.max(0, d.ox + dx / zoom), y: Math.max(0, d.oy + dy / zoom) }));
      return;
    }
    const p = panState.current, el = scroller.current;
    if (p && el) {
      const dx = event.clientX - p.x, dy = event.clientY - p.y;
      if (!p.moved) {
        if (Math.hypot(dx, dy) < 4) return;
        p.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      el.scrollLeft = p.left - dx; el.scrollTop = p.top - dy;
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = dragState.current, p = panState.current;
    dragState.current = null; panState.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (p?.moved) suppressClick.current = true; // arrastrar el fondo no debe deseleccionar
    if (!d) return;
    if (d.pending) cancelAnimationFrame(d.pending);
    if (!d.moved) return;
    suppressClick.current = true;
    const zoom = viewRef.current.zoom;
    void commit({ [d.id]: { x: Math.max(0, d.ox + (event.clientX - d.startX) / zoom), y: Math.max(0, d.oy + (event.clientY - d.startY) / zoom) } });
  };

  const onClick = (event: React.MouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    const node = nodeOf(event.target);
    if (node) { props.onSelectNode(node); return; }
    const relation = (event.target as Element).closest?.('[data-relationship]')?.getAttribute('data-relationship');
    if (relation) props.onSelectRelationship(relation); else props.onSelectNode(undefined);
  };
  const onDoubleClick = (event: React.MouseEvent) => { const node = nodeOf(event.target); if (node && (node.kind === 'external' || node.display === 'connector')) props.onActivateNode(node); };
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const node = nodeOf(event.target);
    if (node) props.onNodeMenu(node, event.clientX, event.clientY); else props.onBackgroundMenu?.(event.clientX, event.clientY);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const node = nodeOf(event.target);
    if (!node) return;
    const box = (event.target as Element).getBoundingClientRect();
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); props.onNodeMenu(node, box.left + 8, box.bottom); return; }
    if (event.altKey && editable && event.key.startsWith('Arrow')) {
      event.preventDefault();
      const current = nudge.current.moved[node.id] ?? (() => { const b = layout.boxes.find(x => x.node.id === node.id)!; return { x: b.x, y: b.y }; })();
      const step = event.shiftKey ? GRID * 4 : GRID;
      nudge.current.moved[node.id] = { x: Math.max(0, current.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)), y: Math.max(0, current.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)) };
      setDrag({ id: node.id, ...nudge.current.moved[node.id]! });
      clearTimeout(nudge.current.timer);
      nudge.current.timer = setTimeout(() => { const moved = nudge.current.moved; nudge.current.moved = {}; void commit(moved); }, 450);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      props.onSelectNode(node);
      // Enter sobre una referencia externa o un conector abre el diagrama que la define.
      if (event.key === 'Enter' && (node.kind === 'external' || node.display === 'connector')) props.onActivateNode(node);
    }
  };

  const counts = props.commentCounts;
  const badges = counts ? live.boxes.flatMap(box => {
    const n = counts[`table|${box.node.tableId}`];
    return n && box.node.kind === 'local' ? [{ node: box.node, count: n, x: box.x + box.width - 14, y: box.y - 10 }] : [];
  }) : [];

  return <div className="canvas" ref={scroller} onScroll={event => { const el = event.currentTarget; props.onView({ ...viewRef.current, left: el.scrollLeft, top: el.scrollTop }); }} data-editable={editable}>
    <div className="canvas-sizer" style={{ width: live.width * view.zoom, height: live.height * view.zoom }}>
      <div className="canvas-stage" ref={stage} style={{ width: live.width, height: live.height, transform: `scale(${view.zoom})` }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
        <div className="svg-host" dangerouslySetInnerHTML={{ __html: svg }}/>
        {badges.map(b => <button key={b.node.id} className="comment-badge" style={{ left: b.x, top: b.y }} title={`${b.count} discusión(es) abiertas en ${b.node.name}`} aria-label={`${b.count} discusiones abiertas en ${b.node.name}`} onClick={event => { event.stopPropagation(); props.onCommentBadge?.(b.node); }}>{b.count}</button>)}
      </div>
    </div>
  </div>;
});
