import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Database, Download, GripVertical, Minus, Plus, Maximize2, Search, AlertTriangle, Table2, Network, LayoutGrid, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { Connector, Diagram, TableNode } from '../diagram/model';
import { buildReferenceIndex, connectorTarget, focusNode, goBack, goForward, navigate, type NavigationState, type NavigationTarget } from '../diagram/navigation';
import type { Diagnostic } from '../project/diagnostics';
import type { DependencyGraph } from '../project/dependencies';
import type { DiagramPatch } from '../project/diagram-config';
import { DiagramCanvas, MAX_ZOOM, MIN_ZOOM, type CanvasHandle, type ViewState } from './canvas';
import { ContextMenu, type MenuItem } from './context-menu';
import { Inspector, type Definition, type InspectorSection } from './inspector';
import { Switcher } from './switcher';
import { ViewSwitcher } from './view-switcher';
import { Problems } from './problems';
import { ColumnPicker } from './column-picker';
import { allColumnsOf, defaultCompactColumns, displayPatch, movePatch, problemsByPackage } from './logic';

export interface Selection { packageId: string; nodeId?: string; tableId?: string; relationshipId?: string; connectorId?: string }
export interface PresenceDot { name: string; color: string; packageId: string }
export interface WorkspaceHandle {
  go(target: NavigationTarget, options?: { silent?: boolean }): void;
  openProblems(): void;
  notice(text: string, kind?: 'info' | 'error'): void;
}
export interface WorkspaceProps {
  projectName: string;
  diagrams: Diagram[];
  diagnostics: Diagnostic[];
  graph?: DependencyGraph | null;
  /** `true` si se muestran diagramas anteriores porque las fuentes actuales no compilan. */
  stale?: boolean;
  initial?: NavigationTarget;
  /** Puede cambiar posiciones y modos de representación (estado compartido o archivo `diagram.yaml`). */
  editable: boolean;
  commentCounts?: Record<string, number>;
  presence?: PresenceDot[];
  onNavigate?(target: NavigationTarget): void;
  onDiagramPatch(packageId: string, patch: DiagramPatch): Promise<void>;
  onRenamePackage?(packageId: string): void;
  onExport(name: string, params: Record<string, string>): Promise<void>;
  fetchDefinition(tableId: string): Promise<Definition | undefined>;
  onOpenDiagnostic?(diagnostic: Diagnostic): void;
  /** Copia un enlace estable a la tabla o al conector indicado. */
  onCopyLink?(target: { packageId: string; tableId?: string; connectorId?: string }): void;
  headerExtra?: ReactNode;
  projectControl?: ReactNode;
  sidebarExtra?: ReactNode;
  /** Panel inferior (editor de código). */
  bottom?: ReactNode;
  inspectorExtra?(selection: Selection): ReactNode;
  onCommentTarget?(selection: Selection): void;
}

const DEFAULT_VIEW: ViewState = { zoom: 1, left: 0, top: 0 };
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const INITIAL_EDITOR_WIDTH = 46;
const INITIAL_EDITOR_HEIGHT = 38;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function readSplitPreference(key: string, fallback: number, min: number, max: number) {
  if (typeof window === 'undefined') return fallback;
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? clamp(value, min, max) : fallback;
  } catch { return fallback; }
}

export const Workspace = forwardRef<WorkspaceHandle, WorkspaceProps>(function Workspace(props, ref) {
  const { diagrams } = props;
  const firstPackage = diagrams[0]?.packageId ?? '';
  const [nav, setNav] = useState<NavigationState>(() => ({ current: props.initial && diagrams.some(d => d.packageId === props.initial!.packageId) ? props.initial : { packageId: firstPackage }, back: [], forward: [] }));
  const activeId = diagrams.some(d => d.packageId === nav.current.packageId) ? nav.current.packageId : firstPackage;
  const diagram = diagrams.find(d => d.packageId === activeId);
  const [selection, setSelection] = useState<Selection>(() => ({ packageId: activeId, tableId: props.initial?.tableId, connectorId: props.initial?.connectorId }));
  const [focus, setFocus] = useState<{ nodeId?: string; nonce: number }>({ nonce: 0 });
  const [highlight, setHighlight] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; label: string }>();
  const [switcher, setSwitcher] = useState(false);
  const [viewSwitcher, setViewSwitcher] = useState<-1 | 0 | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => {
    try { return typeof window === 'undefined' || window.localStorage.getItem('dbml-studio:inspector') !== 'hidden'; }
    catch { return true; }
  });
  const [problems, setProblems] = useState(false);
  const [section, setSection] = useState<{ name: InspectorSection; nonce: number }>({ name: undefined, nonce: 0 });
  const [definition, setDefinition] = useState<Definition | 'loading' | 'missing'>();
  const [picker, setPicker] = useState<{ node: TableNode; all: string[] }>();
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' }>();
  const [busy, setBusy] = useState<string>();
  const [exportOptions, setExportOptions] = useState({ size: 'A4', orientation: 'landscape' });
  const [editorWidth, setEditorWidth] = useState(() => readSplitPreference('dbml-studio:workbench-width', INITIAL_EDITOR_WIDTH, 28, 68));
  const [editorHeight, setEditorHeight] = useState(() => readSplitPreference('dbml-studio:workbench-height', INITIAL_EDITOR_HEIGHT, 24, 62));
  const [stackedWorkbench, setStackedWorkbench] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches === true);
  const [resizing, setResizing] = useState(false);
  const workbench = useRef<HTMLDivElement>(null);
  const splitter = useRef<HTMLDivElement>(null);
  const dragAxis = useRef<'width' | 'height' | null>(null);
  const editorWidthRef = useRef(editorWidth);
  const editorHeightRef = useRef(editorHeight);
  const stackedWorkbenchRef = useRef(stackedWorkbench);
  const editorPaneId = useId();
  const diagramPaneId = useId();
  const views = useRef(new Map<string, ViewState>());
  const [, rerender] = useState(0);
  const canvas = useRef<CanvasHandle>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 760px)');
    if (!media) return;
    const update = () => { stackedWorkbenchRef.current = media.matches; setStackedWorkbench(media.matches); };
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  useEffect(() => { if (diagrams.length < 2 && viewSwitcher !== null) setViewSwitcher(null); }, [diagrams.length, viewSwitcher]);

  const splitBounds = (axis: 'width' | 'height'): [number, number] => {
    const rect = workbench.current?.getBoundingClientRect();
    if (axis === 'width') {
      const width = rect?.width || 900;
      const min = Math.max(28, 240 / width * 100);
      const max = Math.min(68, (width - 24 - 300) / width * 100);
      return [min, Math.max(min, max)];
    }
    const viewportHeight = typeof window === 'undefined' ? 800 : Math.max(1, window.innerHeight);
    const height = rect?.height || viewportHeight;
    const min = Math.max(24, 240 / viewportHeight * 100);
    const max = Math.min(62, (height - 24 - 320) / viewportHeight * 100);
    return [min, Math.max(min, max)];
  };

  const updateSplit = (axis: 'width' | 'height', proposed: number, persist: boolean) => {
    const [min, max] = splitBounds(axis);
    const value = clamp(proposed, min, max);
    if (axis === 'width') {
      editorWidthRef.current = value;
      workbench.current?.style.setProperty('--editor-width', `${value}%`);
      if (persist) {
        setEditorWidth(value);
        try { window.localStorage.setItem('dbml-studio:workbench-width', String(value)); } catch { /* El ajuste sigue activo durante esta sesión. */ }
      }
    } else {
      editorHeightRef.current = value;
      workbench.current?.style.setProperty('--editor-height', `${value}vh`);
      if (persist) {
        setEditorHeight(value);
        try { window.localStorage.setItem('dbml-studio:workbench-height', String(value)); } catch { /* El ajuste sigue activo durante esta sesión. */ }
      }
    }
    if (splitter.current && (stackedWorkbenchRef.current ? axis === 'height' : axis === 'width')) {
      splitter.current.setAttribute('aria-valuenow', String(Math.round(value)));
      splitter.current.setAttribute('aria-valuetext', axis === 'width' ? `${Math.round(value)} por ciento para el editor` : `${Math.round(value)} por ciento del alto de ventana para el editor`);
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!props.bottom || !event.isPrimary) return;
    event.preventDefault();
    dragAxis.current = stackedWorkbenchRef.current ? 'height' : 'width';
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizing(true);
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const axis = dragAxis.current;
    const rect = workbench.current?.getBoundingClientRect();
    if (!axis || !rect) return;
    if (axis === 'width' && rect.width > 0) updateSplit(axis, (event.clientX - rect.left - 12) / rect.width * 100, false);
    if (axis === 'height' && typeof window !== 'undefined') updateSplit(axis, (event.clientY - rect.top - 12) / Math.max(1, window.innerHeight) * 100, false);
  };
  const finishResize = () => {
    const axis = dragAxis.current;
    if (!axis) return;
    dragAxis.current = null;
    setResizing(false);
    updateSplit(axis, axis === 'width' ? editorWidthRef.current : editorHeightRef.current, true);
  };
  const keyResize = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const axis = stackedWorkbenchRef.current ? 'height' : 'width';
    const [min, max] = splitBounds(axis);
    const current = clamp(axis === 'width' ? editorWidthRef.current : editorHeightRef.current, min, max);
    const step = event.shiftKey ? 5 : 2;
    let next: number | undefined;
    if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else if (axis === 'width' && event.key === 'ArrowLeft') next = current - step;
    else if (axis === 'width' && event.key === 'ArrowRight') next = current + step;
    else if (axis === 'height' && event.key === 'ArrowUp') next = current - step;
    else if (axis === 'height' && event.key === 'ArrowDown') next = current + step;
    if (next !== undefined) { event.preventDefault(); updateSplit(axis, next, true); }
  };

  useEffect(() => {
    const element = workbench.current;
    if (!element) return;
    const fitPanes = () => {
      const [widthMin, widthMax] = splitBounds('width');
      const [heightMin, heightMax] = splitBounds('height');
      const width = clamp(editorWidthRef.current, widthMin, widthMax);
      const height = clamp(editorHeightRef.current, heightMin, heightMax);
      element.style.setProperty('--editor-width', `${width}%`);
      element.style.setProperty('--editor-height', `${height}vh`);
      const value = stackedWorkbenchRef.current ? height : width;
      splitter.current?.setAttribute('aria-valuenow', String(Math.round(value)));
      splitter.current?.setAttribute('aria-valuetext', stackedWorkbenchRef.current ? `${Math.round(value)} por ciento del alto de ventana para el editor` : `${Math.round(value)} por ciento para el editor`);
      const [minimum, maximum] = stackedWorkbenchRef.current ? [heightMin, heightMax] : [widthMin, widthMax];
      splitter.current?.setAttribute('aria-valuemin', String(Math.round(minimum)));
      splitter.current?.setAttribute('aria-valuemax', String(Math.round(maximum)));
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fitPanes);
    observer?.observe(element);
    window.addEventListener('resize', fitPanes);
    fitPanes();
    return () => { observer?.disconnect(); window.removeEventListener('resize', fitPanes); };
  }, [props.bottom, stackedWorkbench]);

  const index = useMemo(() => buildReferenceIndex(diagrams), [diagrams]);
  const problemsMap = useMemo(() => problemsByPackage(props.diagnostics), [props.diagnostics]);
  const errorCount = props.diagnostics.filter(d => d.severity !== 'warning').length;
  const warningCount = props.diagnostics.length - errorCount;

  const say = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setNotice({ text, kind });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(undefined), kind === 'error' ? 9000 : 4000);
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem('dbml-studio:inspector', inspectorOpen ? 'open' : 'hidden'); }
    catch { /* El panel sigue funcionando aunque el almacenamiento local esté deshabilitado. */ }
  }, [inspectorOpen]);
  useEffect(() => () => { clearTimeout(noticeTimer.current); clearTimeout(highlightTimer.current); }, []);

  const view = views.current.get(activeId) ?? DEFAULT_VIEW;
  const setView = useCallback((next: ViewState) => {
    const previous = views.current.get(activeId) ?? DEFAULT_VIEW;
    views.current.set(activeId, next);
    // El desplazamiento solo se recuerda; únicamente el zoom vuelve a dibujar.
    if (previous.zoom !== next.zoom) rerender(n => n + 1);
  }, [activeId]);
  const zoomBy = (factor: number) => setView({ ...view, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(view.zoom * factor * 100) / 100)) });

  const go = useCallback((target: NavigationTarget, options?: { silent?: boolean }) => {
    const next = diagrams.find(d => d.packageId === target.packageId);
    if (!next) { say(`El paquete ${target.packageId} ya no existe.`, 'error'); return; }
    const connector = target.connectorId ? next.connectors.find(c => c.id === target.connectorId) : undefined;
    const node = connector ? next.nodes.find(n => n.id === connector.nodeId) : focusNode(next, target.tableId);
    setNav(state => navigate(state, target));
    setSelection({ packageId: next.packageId, nodeId: node?.id, tableId: node?.tableId ?? target.tableId, connectorId: target.connectorId });
    setDefinition(undefined);
    setSwitcher(false);
    if (node) {
      setFocus(f => ({ nodeId: node.id, nonce: f.nonce + 1 }));
      setHighlight(node.id);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlight(undefined), 2500);
    }
    if (!options?.silent) props.onNavigate?.(target);
  }, [diagrams, props.onNavigate, say]);

  useImperativeHandle(ref, () => ({ go, openProblems: () => setProblems(true), notice: say }), [go, say]);

  // Enlaces directos (tabla o conector): al abrir la página se centra y resalta el elemento indicado.
  useEffect(() => {
    if (props.initial && (props.initial.tableId || props.initial.connectorId)) {
      const frame = requestAnimationFrame(() => go(props.initial!, { silent: true }));
      return () => cancelAnimationFrame(frame);
    }
  }, []);

  // Tras navegar, el visor se centra en el destino cuando el diagrama ya está dibujado.
  useEffect(() => {
    if (!focus.nodeId) return;
    const frame = requestAnimationFrame(() => canvas.current?.centerOn(focus.nodeId!));
    return () => cancelAnimationFrame(frame);
  }, [focus.nonce, activeId]);

  // Atajos globales: Shift+Tab cambia de vista; Ctrl/Cmd+K busca; Alt+←/→ recorren el historial.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (viewSwitcher !== null) return;
      const target = event.target as HTMLElement | null;
      const typing = target?.closest?.('input, textarea, select, [contenteditable="true"]');
      const inOverlay = target?.closest?.('[role="dialog"], [role="menu"]');
      if (event.shiftKey && event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey && !typing && !inOverlay && diagrams.length > 1) {
        event.preventDefault();
        setViewSwitcher(-1);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSwitcher(true); return; }
      if (event.altKey && !typing && event.key === 'ArrowLeft') { event.preventDefault(); back(); }
      if (event.altKey && !typing && event.key === 'ArrowRight') { event.preventDefault(); forward(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const apply = (next: NavigationState) => {
    setNav(next);
    setSelection({ packageId: next.current.packageId, tableId: next.current.tableId, connectorId: next.current.connectorId });
    const d = diagrams.find(x => x.packageId === next.current.packageId);
    const node = focusNode(d, next.current.tableId);
    if (node) setFocus(f => ({ nodeId: node.id, nonce: f.nonce + 1 }));
    props.onNavigate?.(next.current);
  };
  const back = () => { if (nav.back.length) apply(goBack(nav)); };
  const forward = () => { if (nav.forward.length) apply(goForward(nav)); };

  const selectedNode = diagram?.nodes.find(n => n.id === selection.nodeId) ?? (selection.tableId ? focusNode(diagram, selection.tableId) : undefined);
  const selectedRelationship = diagram?.relationships.find(r => r.id === selection.relationshipId);

  const patch = async (patchValue: DiagramPatch, success?: string) => {
    if (!diagram) return;
    try { await props.onDiagramPatch(diagram.packageId, patchValue); if (success) say(success); }
    catch (error) { say(error instanceof Error ? error.message : String(error), 'error'); }
  };

  const showDefinition = async (tableId: string) => {
    setDefinition('loading');
    try { setDefinition((await props.fetchDefinition(tableId)) ?? 'missing'); } catch { setDefinition('missing'); }
  };
  const copy = (text: string, done: string) => { navigator.clipboard.writeText(text).then(() => say(done), () => say('No se pudo copiar al portapapeles.', 'error')); };
  const select = (node: TableNode, extra: Partial<Selection> = {}) => setSelection({ packageId: activeId, nodeId: node.id, tableId: node.tableId, ...extra });

  const changeDisplay = (node: TableNode, display: 'full' | 'compact' | 'connector', columns?: string[]) => {
    if (!diagram) return;
    const all = allColumnsOf(diagrams, node.tableId);
    const { patch: p, nodeId } = displayPatch(diagram, node, display, all, columns);
    setSelection(s => ({ ...s, nodeId }));
    void patch(p);
  };

  const nodeMenu = (node: TableNode): MenuItem[] => {
    if (!diagram) return [];
    const connectors = diagram.connectors.filter(c => c.nodeId === node.id);
    const items: MenuItem[] = [];
    const canEdit = props.editable;
    if (node.display === 'connector') {
      // Con varias relaciones se distingue cada conector por la columna local de su clave.
      const suffix = (c: Connector) => connectors.length > 1 ? ` (${c.endpoints.find(e => e.tableId === c.sourceTableId)?.columns.join(', ') ?? c.label})` : '';
      connectors.forEach(c => items.push({ label: `Ir al diagrama destino${suffix(c)}`, run: () => go(connectorTarget(c)) }));
      connectors.forEach(c => items.push({ label: `Ver relación${suffix(c)}`, run: () => { select(node, { relationshipId: c.relationshipId, connectorId: c.id }); } }));
      items.push({ label: 'Mostrar tabla externa', run: () => changeDisplay(node, 'full'), disabled: !canEdit });
      connectors.forEach(c => items.push({ label: `Copiar referencia${suffix(c)}`, run: () => copy(`${c.label} · ${c.targetPackageId}.${c.targetTableId}`, 'Referencia copiada.') }));
      items.push({ separator: true, label: '' });
    } else if (node.kind === 'external') {
      items.push({ label: 'Mostrar Full', run: () => changeDisplay(node, 'full'), disabled: !canEdit || node.display === 'full' });
      items.push({ label: 'Mostrar Compact', run: () => changeDisplay(node, 'compact'), disabled: !canEdit || node.display === 'compact' });
      items.push({ label: 'Elegir columnas visibles…', run: () => setPicker({ node, all: allColumnsOf(diagrams, node.tableId) }), disabled: !canEdit });
      items.push({ label: 'Mostrar Connector', run: () => changeDisplay(node, 'connector'), disabled: !canEdit || !diagram.relationships.some(r => r.endpoints.some(e => e.tableId === node.tableId)) });
      items.push({ label: 'Ir a definición original', run: () => go({ packageId: node.owner, tableId: node.tableId }) });
      items.push({ separator: true, label: '' });
    }
    items.push(
      { label: 'Ver definición', run: () => { select(node); void showDefinition(node.tableId); } },
      { label: 'Ver relaciones', run: () => { select(node); setSection(s => ({ name: 'relations', nonce: s.nonce + 1 })); } },
      { label: 'Ver referencias entrantes', run: () => { select(node); setSection(s => ({ name: 'incoming', nonce: s.nonce + 1 })); } },
      { label: 'Ir al paquete propietario', run: () => go({ packageId: node.owner, tableId: node.tableId }), disabled: node.owner === activeId && node.kind === 'local' },
      { label: 'Copiar identificador', run: () => copy(node.tableId, 'Identificador copiado.') },
    );
    if (props.onCopyLink) items.push({ label: 'Copiar enlace a la tabla', run: () => props.onCopyLink!({ packageId: activeId, tableId: node.tableId }) });
    if (props.onCommentTarget) items.push({ separator: true, label: '' }, { label: 'Comentar…', run: () => { select(node); props.onCommentTarget!({ packageId: activeId, nodeId: node.id, tableId: node.tableId }); } });
    return items;
  };

  const exportFile = async (name: string, params: Record<string, string> = {}) => {
    setBusy(name);
    try { await props.onExport(name, params); say(`Exportado ${name}.`); }
    catch (error) { say(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(undefined); }
  };
  const packageMenu = (packageId: string): MenuItem[] => [
    { label: 'Abrir', run: () => go({ packageId }) },
    { label: 'Copiar identificador', run: () => copy(packageId, 'Identificador copiado.') },
    ...(props.editable && props.onRenamePackage ? [{ label: 'Cambiar nombre…', run: () => props.onRenamePackage!(packageId) }] : []),
    { label: 'Exportar SVG', run: () => void exportFile(`${packageId}.svg`) },
    { label: 'Exportar PDF', run: () => void exportFile(`${packageId}.pdf`, exportOptions) },
    { label: `Ver errores${problemsMap.get(packageId)?.errors ? ` (${problemsMap.get(packageId)!.errors})` : ''}`, run: () => { go({ packageId }); setProblems(true); } },
    ...(props.onCommentTarget ? [{ label: 'Comentar…', run: () => props.onCommentTarget!({ packageId }) }] : []),
  ];
  const openMenu = (x: number, y: number, items: MenuItem[], label: string) => setMenu({ x, y, items, label });
  const packageMenuAt = (packageId: string) => (event: React.MouseEvent | React.KeyboardEvent) => {
    if ('key' in event) { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; const r = (event.currentTarget as HTMLElement).getBoundingClientRect(); event.preventDefault(); openMenu(r.left, r.bottom, packageMenu(packageId), `Paquete ${packageId}`); return; }
    event.preventDefault(); openMenu(event.clientX, event.clientY, packageMenu(packageId), `Paquete ${packageId}`);
  };

  const onTabKey = (event: React.KeyboardEvent<HTMLElement>, i: number) => {
    const tabs = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const to = event.key === 'ArrowRight' ? i + 1 : event.key === 'ArrowLeft' ? i - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    if (to !== undefined) { event.preventDefault(); tabs[(to + tabs.length) % tabs.length]?.focus(); return; }
    packageMenuAt(diagrams[i]!.packageId)(event);
  };

  const dots = (packageId: string) => (props.presence ?? []).filter(p => p.packageId === packageId);
  const connectorsHere: Connector[] = diagram?.connectors ?? [];

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Database size={17}/></span><strong>DBML Studio</strong><span className="divider"/>{props.projectControl ?? <span className="project-name">{props.projectName}</span>}</div>
      <div className="top-actions">
        <button className="search-button" onClick={() => setSwitcher(true)} aria-keyshortcuts="Control+K"><Search size={15}/> Buscar paquete <kbd>Ctrl K</kbd></button>
        {props.headerExtra}
      </div>
    </header>
    {props.stale && <div className="banner warning" role="status"><AlertTriangle size={15}/> Se muestra la última versión válida: las fuentes actuales tienen errores. <button className="mini" onClick={() => setProblems(true)}>Ver errores</button></div>}
    <div className={`workspace ${inspectorOpen ? 'inspector-open' : 'inspector-collapsed'}`}>
      <aside className="sidebar" aria-label="Proyecto">
        <div className="side-heading"><span>PROYECTO</span><span>{diagrams.length}</span></div>
        <div className="project-label"><Database size={16}/><strong>{props.projectName}</strong></div>
        <div className="side-heading second">PAQUETES</div>
        <nav aria-label="Paquetes">
          {diagrams.map(d => {
            const p = problemsMap.get(d.packageId);
            return <button key={d.id} className={`package ${d.packageId === activeId ? 'active' : ''}`} aria-current={d.packageId === activeId ? 'page' : undefined} onClick={() => go({ packageId: d.packageId })} onContextMenu={packageMenuAt(d.packageId)} onKeyDown={packageMenuAt(d.packageId)}>
              <Table2 size={16}/><span>{d.packageId}</span>
              {dots(d.packageId).slice(0, 3).map((u, i) => <i key={i} className="presence-dot" style={{ background: u.color }} title={`${u.name} está aquí`}/>)}
              {p?.errors ? <b className="badge-error" title={`${p.errors} error(es)`}>{p.errors}</b> : null}
              <small>{d.nodes.filter(n => n.kind === 'local').length}</small>
            </button>;
          })}
        </nav>
        {props.graph && (props.graph.imports.length > 0 || props.graph.foreignKeys.length > 0 || props.graph.visual.length > 0) && <details className="deps">
          <summary><Network size={14}/> Dependencias</summary>
          {([['Importaciones', props.graph.imports], ['Claves foráneas', props.graph.foreignKeys], ['Referencias visuales', props.graph.visual]] as const).map(([title, edges]) => edges.length > 0 && <div key={title}><h4>{title}</h4><ul>{edges.map(e => <li key={`${e.from}>${e.to}`}><button className="inline-link" onClick={() => go({ packageId: e.from })}>{e.from}</button> → <button className="inline-link" onClick={() => go({ packageId: e.to })}>{e.to}</button></li>)}</ul></div>)}
          {props.graph.importCycles.length > 0 && <p className="empty small">Ciclos de importación entre paquetes: {props.graph.importCycles.map(c => c.join(' ↔ ')).join('; ')}</p>}
        </details>}
        {props.sidebarExtra}
        <div className="sidebar-foot"><span className={`status-dot ${props.stale || errorCount ? 'bad' : ''}`}/> {props.stale ? 'Última versión válida' : errorCount ? 'Con errores' : 'Esquema compilado'}</div>
      </aside>

      <main className={`main ${props.bottom ? 'has-editor' : ''}`}>
        <div className="tabs-row">
          <div className="history" role="group" aria-label="Historial">
            <button title="Anterior (Alt+←)" aria-label="Anterior" disabled={!nav.back.length} onClick={back}><ArrowLeft size={15}/></button>
            <button title="Siguiente (Alt+→)" aria-label="Siguiente" disabled={!nav.forward.length} onClick={forward}><ArrowRight size={15}/></button>
          </div>
          <div className="tabs" role="tablist" aria-label="Diagramas por paquete">
            {diagrams.map((d, i) => {
              const p = problemsMap.get(d.packageId);
              return <button key={d.id} role="tab" aria-selected={d.packageId === activeId} tabIndex={d.packageId === activeId ? 0 : -1} className={`tab ${d.packageId === activeId ? 'active' : ''}`} onClick={() => go({ packageId: d.packageId })} onContextMenu={packageMenuAt(d.packageId)} onKeyDown={event => onTabKey(event, i)}>
                {d.packageId}
                {dots(d.packageId).slice(0, 3).map((u, k) => <i key={k} className="presence-dot" style={{ background: u.color }} title={`${u.name} está aquí`}/>)}
                {p?.errors ? <b className="badge-error" title={`${p.errors} error(es)`}>{p.errors}</b> : p?.warnings ? <b className="badge-warn" title={`${p.warnings} advertencia(s)`}>!</b> : null}
              </button>;
            })}
          </div>
          <button className="view-switcher-trigger" type="button" title="Cambiar vista (Shift+Tab)" aria-label="Cambiar vista" aria-haspopup="dialog" aria-keyshortcuts="Shift+Tab" disabled={diagrams.length < 2} onClick={() => setViewSwitcher(0)}><LayoutGrid size={15}/></button>
        </div>

        <div ref={workbench} style={{ '--editor-width': `${editorWidth}%`, '--editor-height': `${editorHeight}vh` } as CSSProperties} className={`workbench ${props.bottom ? 'with-editor' : 'diagram-only'}`}>
          {props.bottom && <div id={editorPaneId} className="editor-pane">{props.bottom}</div>}
          {props.bottom && <div
            ref={splitter}
            className={`workbench-splitter${resizing ? ' is-resizing' : ''}`}
            role="separator"
            aria-label="Redimensionar editor y visor"
            aria-orientation={stackedWorkbench ? 'horizontal' : 'vertical'}
            aria-controls={`${editorPaneId} ${diagramPaneId}`}
            aria-valuemin={Math.round(splitBounds(stackedWorkbench ? 'height' : 'width')[0])}
            aria-valuemax={Math.round(splitBounds(stackedWorkbench ? 'height' : 'width')[1])}
            aria-valuenow={Math.round(stackedWorkbench ? editorHeight : editorWidth)}
            aria-valuetext={stackedWorkbench ? `${Math.round(editorHeight)} por ciento del alto de ventana para el editor` : `${Math.round(editorWidth)} por ciento para el editor`}
            tabIndex={0}
            title="Arrastra para cambiar el tamaño; usa las flechas del teclado. Doble clic para restablecer."
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onLostPointerCapture={finishResize}
            onDoubleClick={() => updateSplit(stackedWorkbenchRef.current ? 'height' : 'width', stackedWorkbenchRef.current ? INITIAL_EDITOR_HEIGHT : INITIAL_EDITOR_WIDTH, true)}
            onKeyDown={keyResize}
          ><span aria-hidden="true"><GripVertical size={16}/></span></div>}
          <section id={diagramPaneId} className="diagram-pane" aria-label="Visor del diagrama">
            <div className="diagram-content">
        {!diagram ? <div className="message" role="alert"><strong>Sin diagramas</strong><p>{errorCount ? 'El proyecto tiene errores y aún no hay una versión válida que mostrar.' : 'El proyecto no contiene paquetes.'}</p>{errorCount > 0 && <button onClick={() => setProblems(true)}>Ver errores</button>}</div> : <>
          <div className="canvas-heading">
            <div><h1>{diagram.packageId}</h1><p>{count(diagram.nodes.filter(n => n.kind === 'local').length, 'tabla local', 'tablas locales')} · {count(diagram.nodes.filter(n => n.kind === 'external' && n.display !== 'connector').length, 'externa', 'externas')} · {count(connectorsHere.length, 'conector', 'conectores')} · {count(diagram.relationships.length, 'relación', 'relaciones')}</p></div>
            <div className="toolbar">
              {(errorCount > 0 || warningCount > 0) && <button className={`chip-button ${errorCount ? 'error' : 'warn'}`} onClick={() => setProblems(p => !p)} aria-pressed={problems}><AlertTriangle size={14}/> {errorCount ? `${errorCount} error(es)` : `${warningCount} advertencia(s)`}</button>}
              <div className="zoom-controls" role="group" aria-label="Zoom">
                <button onClick={() => zoomBy(1 / 1.2)} aria-label="Alejar" disabled={view.zoom <= MIN_ZOOM}><Minus size={14}/></button>
                <button className="zoom-value" onClick={() => setView({ ...view, zoom: 1 })} aria-label="Restablecer zoom">{Math.round(view.zoom * 100)}%</button>
                <button onClick={() => zoomBy(1.2)} aria-label="Acercar" disabled={view.zoom >= MAX_ZOOM}><Plus size={14}/></button>
                <button onClick={() => { const z = canvas.current?.fit(); if (z) setView({ zoom: z, left: 0, top: 0 }); }} aria-label="Ajustar al visor" title="Ajustar al visor"><Maximize2 size={14}/></button>
              </div>
              {props.editable && <button onClick={() => void patch({ layout: Object.fromEntries(Object.keys(diagram.layout ?? {}).map(id => [id, null])) }, 'Disposición automática restablecida.')} disabled={!Object.keys(diagram.layout ?? {}).length} title="Descarta las posiciones guardadas"><LayoutGrid size={14}/> Reorganizar</button>}
              <details className="export-menu">
                <summary className="export-button"><Download size={15}/> Exportar</summary>
                <div className="export-panel" role="group" aria-label="Opciones de exportación">
                  <label>Tamaño <select value={exportOptions.size} onChange={e => setExportOptions(o => ({ ...o, size: e.target.value }))}><option>A4</option><option>A3</option></select></label>
                  <label>Orientación <select value={exportOptions.orientation} onChange={e => setExportOptions(o => ({ ...o, orientation: e.target.value }))}><option value="landscape">Horizontal</option><option value="portrait">Vertical</option></select></label>
                  <button disabled={!!busy} onClick={() => void exportFile(`${diagram.packageId}.svg`)}>SVG · {diagram.packageId}</button>
                  <button disabled={!!busy} onClick={() => void exportFile(`${diagram.packageId}.pdf`, exportOptions)}>PDF · {diagram.packageId}</button>
                  <button disabled={!!busy} onClick={() => void exportFile('all.pdf', exportOptions)}>PDF · todos los paquetes</button>
                  <button disabled={!!busy} onClick={() => void exportFile('schema.sql')}>Esquema SQL</button>
                  <button disabled={!!busy} onClick={() => void exportFile('schema.dbml')}>DBML estándar (aplanado)</button>
                </div>
              </details>
            </div>
          </div>
          {diagram.diagnostics?.length ? <div className="banner warning" role="status"><AlertTriangle size={15}/> {diagram.diagnostics.length} vista(s) de este diagrama se omitieron por errores de configuración. <button className="mini" onClick={() => setProblems(true)}>Ver detalle</button></div> : null}
          <DiagramCanvas ref={canvas} diagram={diagram} view={view} editable={props.editable} selectedTable={selection.tableId} selectedRelationship={selection.relationshipId} highlightNodeId={highlight} commentCounts={props.commentCounts}
            onView={setView} onSelectNode={node => node ? select(node) : setSelection({ packageId: activeId })} onSelectRelationship={id => setSelection({ packageId: activeId, relationshipId: id })}
            onActivateNode={node => { const c = diagram.connectors.find(x => x.nodeId === node.id); go(c ? connectorTarget(c) : { packageId: node.owner, tableId: node.tableId }); }}
            onNodeMenu={(node, x, y) => { select(node); openMenu(x, y, nodeMenu(node), `Acciones de ${node.name}`); }}
            onBackgroundMenu={(x, y) => openMenu(x, y, packageMenu(activeId), `Paquete ${activeId}`)}
            onMove={moved => patch(movePatch(diagram, moved))}
            onCommentBadge={node => { select(node); props.onCommentTarget?.({ packageId: activeId, nodeId: node.id, tableId: node.tableId }); }}/>
        </>}
        {problems && <Problems diagnostics={props.diagnostics} packageId={undefined} onClose={() => setProblems(false)} onOpen={d => { if (d.packageId && diagrams.some(x => x.packageId === d.packageId)) go({ packageId: d.packageId }); props.onOpenDiagnostic?.(d); }}/>}
            </div>
          </section>
        </div>
      </main>

      {inspectorOpen ? diagram ? <Inspector diagram={diagram} index={index} node={selectedNode} relationship={selectedRelationship} section={section.name} sectionNonce={section.nonce} definition={definition} onCollapse={() => setInspectorOpen(false)}
        onNavigate={go} onSelectRelationship={id => setSelection(s => ({ ...s, relationshipId: id, nodeId: undefined, tableId: undefined }))} onShowDefinition={id => void showDefinition(id)}
        onCopyLink={props.onCopyLink ? target => props.onCopyLink!({ packageId: activeId, ...target }) : undefined}
        extra={props.inspectorExtra?.({ ...selection, packageId: activeId, nodeId: selectedNode?.id, tableId: selectedNode?.tableId ?? selection.tableId })}/>
        : <aside className="inspector inspector-empty" aria-label="Inspector"><div className="inspector-title"><strong>Inspector</strong><span>DETALLES</span><button className="panel-toggle" type="button" aria-label="Ocultar inspector" aria-expanded="true" title="Ocultar inspector" onClick={() => setInspectorOpen(false)}><PanelRightClose size={16}/></button></div></aside>
        : <aside className="inspector-rail" aria-label="Inspector"><button type="button" aria-expanded="false" aria-label="Mostrar inspector" title="Mostrar inspector" onClick={() => setInspectorOpen(true)}><PanelRightOpen size={17}/><span>Inspector</span></button></aside>}
    </div>
    {notice && <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}<button aria-label="Cerrar aviso" onClick={() => setNotice(undefined)}>×</button></div>}
    {menu && <><div className="menu-dismiss" onClick={() => setMenu(undefined)} onContextMenu={e => { e.preventDefault(); setMenu(undefined); }}/><ContextMenu x={menu.x} y={menu.y} actions={menu.items} label={menu.label} close={() => setMenu(undefined)}/></>}
    {switcher && <Switcher diagrams={diagrams} active={activeId} problems={problemsMap} onOpen={go} onClose={() => setSwitcher(false)}/>}
    {viewSwitcher !== null && diagrams.length > 1 && <ViewSwitcher diagrams={diagrams} active={activeId} projectName={props.projectName} problems={problemsMap} initialDirection={viewSwitcher} onSelect={packageId => go({ packageId })} onClose={() => setViewSwitcher(null)}/>}
    {picker && diagram && <ColumnPicker table={picker.node.tableId} columns={picker.all} selected={picker.node.display === 'compact' ? picker.node.columns : defaultCompactColumns(diagram, picker.node, picker.all)} onClose={() => setPicker(undefined)} onApply={columns => { changeDisplay(picker.node, 'compact', columns); setPicker(undefined); }}/>}
  </div>;
});

