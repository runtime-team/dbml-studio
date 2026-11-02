import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { BookOpen, ChevronDown, Clock3, Download, FilePlus2, FolderOpen, LoaderCircle, RefreshCw, Search, Trash2, Upload, Users, X } from 'lucide-react';

export interface LocalProjectIdentity { name: string; browserProjectId?: string; manifestPath?: string }
export interface BrowserRecentProject {
  name: string; manifestPath: string; relativePath: string; packages: number; available: boolean; browserProjectId?: string;
}
const supportsDirectoryPicker = () => typeof window !== 'undefined' && window.isSecureContext
  && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
interface Props {
  current?: LocalProjectIdentity;
  standalone?: boolean;
  onOpen(project: BrowserRecentProject): Promise<boolean>;
  onBrowse?(): Promise<boolean>;
  onCreate(name: string): Promise<boolean>;
  onExport?(): Promise<void>;
  onImport?(file: File): Promise<boolean>;
}

const ACTIVE_KEY = 'dbml-studio:active-browser-project';
export function readActiveBrowserProject(): string | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage.getItem(ACTIVE_KEY) ?? undefined; }
  catch { return undefined; }
}

async function readJson<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let data: T & { error?: string };
  try { data = raw ? JSON.parse(raw) as T & { error?: string } : {} as T & { error?: string }; }
  catch { throw new Error(raw || `La API respondió sin JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(data.error ?? `Error HTTP ${response.status}.`);
  return data;
}

export function ProjectManager({ current, standalone = false, onOpen, onBrowse, onCreate, onExport, onImport }: Props) {
  const [recent, setRecent] = useState<BrowserRecentProject[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'open' | 'create' | 'import'>();
  const [openTab, setOpenTab] = useState<'recent' | 'folder'>('recent');
  const [name, setName] = useState('Mi proyecto');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<File>();
  const root = useRef<HTMLDivElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const archiveInput = useRef<HTMLInputElement>(null);

  const loadRecent = async () => {
    setLoading(true);
    try {
      const data = await readJson<{ projects?: BrowserRecentProject[] }>(await fetch('/api/projects/recent'));
      setRecent((Array.isArray(data.projects) ? data.projects : []).filter(project => !!project.browserProjectId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const available = supportsDirectoryPicker();
    setSupported(available);
    if (available) void import('./filesystem-projects');
    void loadRecent();
  }, []);
  useEffect(() => { if (current?.browserProjectId) { try { window.localStorage.setItem(ACTIVE_KEY, current.browserProjectId); } catch { /* El selector sigue funcionando si el almacenamiento web está desactivado. */ } } }, [current?.browserProjectId]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); root.current?.querySelector<HTMLButtonElement>('.project-widget')?.focus(); } };
    document.addEventListener('pointerdown', closeOutside); document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [menuOpen]);
  useEffect(() => { if (menuOpen) requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()); }, [menuOpen]);
  useEffect(() => { if (dialog) requestAnimationFrame(() => firstInput.current?.focus()); }, [dialog]);

  const navigateMenu = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const active = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (active + 1 + items.length) % items.length : (active - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const beginOpen = () => { setError(''); setQuery(''); setOpenTab('recent'); setDialog('open'); setMenuOpen(false); void loadRecent(); };
  const beginCreate = () => { setError(''); setName('Mi proyecto'); setDialog('create'); setMenuOpen(false); };
  const beginImportArchive = () => { setError(''); if (archiveInput.current) { archiveInput.current.value = ''; archiveInput.current.click(); } };

  const openRecent = async (project: BrowserRecentProject) => {
    setBusy(true); setError('');
    try {
      if (await onOpen(project)) {
        if (project.browserProjectId) try { window.localStorage.setItem(ACTIVE_KEY, project.browserProjectId); } catch { /* La apertura no depende de localStorage. */ }
        setDialog(undefined); setMenuOpen(false); void loadRecent();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const browse = async () => {
    setBusy(true); setError('');
    try { if (await onBrowse?.()) { setDialog(undefined); setMenuOpen(false); void loadRecent(); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const createProject = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { if (await onCreate(name.trim())) { setDialog(undefined); void loadRecent(); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const exportProject = async () => {
    if (!onExport || busy) return;
    setBusy(true); setError('');
    try { await onExport(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const importProject = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file || busy) return;
    setPendingArchive(file); setError(''); setDialog('import'); setMenuOpen(false);
  };

  const confirmImport = async () => {
    if (!pendingArchive || busy) return;
    setBusy(true); setError('');
    try { if (await onImport?.(pendingArchive)) { setDialog(undefined); setPendingArchive(undefined); setMenuOpen(false); void loadRecent(); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const removeRecent = async (project: BrowserRecentProject) => {
    setBusy(true); setError('');
    try {
      await readJson(await fetch('/api/projects/recent/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifestPath: project.manifestPath }) }));
      if (project.browserProjectId) await (await import('./filesystem-projects')).forgetProjectHandle(project.browserProjectId);
      await loadRecent();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const filteredRecent = recent.filter(project => `${project.name} ${project.relativePath}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const entries = recent.filter(project => project.browserProjectId !== current?.browserProjectId);
  const menuContent = <>
    <div className="project-menu-current"><span>PROYECTO LOCAL</span><strong>{current?.name ?? 'Ningún proyecto abierto'}</strong>{current && <small>Carpeta: {current.name}</small>}</div>
    <button type="button" role="menuitem" onClick={beginOpen} disabled={busy || !supported}><FolderOpen size={16}/>Abrir proyecto…</button>
    <button type="button" role="menuitem" onClick={beginCreate} disabled={busy || !supported}><FilePlus2 size={16}/>Crear proyecto local…</button>
    <button type="button" role="menuitem" onClick={beginImportArchive} disabled={busy || !supported}><Upload size={16}/>Importar proyecto (.zip)…</button>
    {current && <button type="button" role="menuitem" onClick={() => void exportProject()} disabled={busy}><Download size={16}/>{busy ? 'Preparando ZIP…' : 'Exportar proyecto (.zip)'}</button>}
    {entries.length > 0 && <><div className="project-menu-section"><Clock3 size={13}/> Recientes</div>{entries.slice(0, 8).map(item => <button type="button" role="menuitem" className="project-recent" key={item.browserProjectId} onClick={() => void openRecent(item)} disabled={busy || !item.browserProjectId}><strong>{item.name}</strong><small>{item.available ? `${item.packages} ${item.packages === 1 ? 'paquete' : 'paquetes'}` : 'Reconstruir desde la carpeta guardada'}</small></button>)}</>}
    <a role="menuitem" href="/shared" className="project-menu-link"><Users size={16}/>Proyectos compartidos</a>
    <a role="menuitem" href="/docs/" target="_blank" rel="noreferrer" className="project-menu-link"><BookOpen size={16}/>Documentación</a>
    {error && <p role="alert" className="project-menu-error">{error}</p>}
  </>;

  return <>
    <input ref={archiveInput} type="file" accept=".zip,application/zip" aria-label="Seleccionar archivo ZIP del proyecto" hidden onChange={event => void importProject(event)}/>
    {standalone ? <section className="project-launcher" aria-label="Administrar proyectos locales">
      {!supported && <p className="project-browser-notice" role="status">Para abrir o guardar proyectos locales, usa Chrome o Edge en localhost o HTTPS.</p>}
      <div className="project-launcher-actions">
        <button type="button" className="primary" onClick={beginOpen} disabled={busy || !supported}><FolderOpen size={17}/> Abrir proyecto</button>
        <button type="button" className="mini" onClick={beginCreate} disabled={busy || !supported}><FilePlus2 size={16}/> Nuevo proyecto</button>
        <button type="button" onClick={beginImportArchive} disabled={busy || !supported}><Upload size={16}/> Importar proyecto (.zip)</button>
        <a href="/shared"><Users size={16}/> Proyectos compartidos</a>
        <a href="/docs/" target="_blank" rel="noreferrer"><BookOpen size={16}/> Documentación</a>
      </div>
      {entries.length > 0 && <div className="project-launcher-recents"><h2>Proyectos recientes</h2>{entries.map(item => <div className="project-recent-row" key={item.browserProjectId}>
        <button type="button" onClick={() => void openRecent(item)} disabled={busy || !item.browserProjectId}><strong>{item.name}</strong><small>{item.available ? `${item.packages} ${item.packages === 1 ? 'paquete' : 'paquetes'}` : 'Reconstruir desde la carpeta guardada'}</small></button>
        <button type="button" className="project-recent-remove" title="Quitar de recientes" aria-label={`Quitar ${item.name} de recientes`} onClick={() => void removeRecent(item)} disabled={busy}><Trash2 size={14}/></button>
      </div>)}</div>}
      {error && <p role="alert" className="project-form-error">{error}</p>}
    </section> : <div className="project-manager" ref={root}>
      <button type="button" className="project-widget" aria-haspopup="menu" aria-controls={menuOpen ? 'project-switch-menu' : undefined} aria-expanded={menuOpen} title={current?.name ?? 'Abrir o crear un proyecto'} onClick={() => setMenuOpen(open => !open)}>
        <span className="project-name">{current?.name ?? 'Proyectos'}</span><ChevronDown size={14}/>
      </button>
      {menuOpen && <div className="project-menu" id="project-switch-menu" role="menu" onKeyDown={navigateMenu}>{menuContent}</div>}
    </div>}
    {dialog && <div className="overlay project-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setDialog(undefined); }}>
      <form className="dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onSubmit={dialog === 'create' ? createProject : event => event.preventDefault()} onKeyDown={event => { if (event.key === 'Escape' && !busy) setDialog(undefined); }}>
        <header className="project-dialog-header"><h2 id="project-dialog-title">{dialog === 'open' ? 'Abrir proyecto' : dialog === 'create' ? 'Crear proyecto local' : 'Importar proyecto'}</h2><button type="button" className="icon" aria-label="Cerrar" onClick={() => { setDialog(undefined); setPendingArchive(undefined); }} disabled={busy}><X size={17}/></button></header>
        {!supported && <p className="project-browser-notice" role="status">El acceso a carpetas requiere Chrome o Edge y una conexión segura.</p>}
        {dialog === 'open' ? <>
          <div className="project-dialog-tabs" aria-label="Origen del proyecto">
            <button type="button" className={openTab === 'recent' ? 'active' : ''} aria-pressed={openTab === 'recent'} onClick={() => { setOpenTab('recent'); setQuery(''); }}><Clock3 size={14}/> Recientes</button>
            <button type="button" className={openTab === 'folder' ? 'active' : ''} aria-pressed={openTab === 'folder'} onClick={() => setOpenTab('folder')}><FolderOpen size={14}/> Elegir carpeta</button>
          </div>
          {openTab === 'folder' ? <div className="project-browser-pick"><p>Chrome abrirá el selector del sistema. Elige la carpeta raíz que contiene el manifiesto DBML.</p><button type="button" className="primary" onClick={() => void browse()} disabled={busy || !supported}><FolderOpen size={15}/> Seleccionar carpeta</button></div> : <>
            <label className="project-search"><Search size={15}/><input ref={firstInput} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar proyectos recientes…" autoComplete="off" aria-label="Buscar proyectos recientes"/><kbd>Esc</kbd></label>
            <div className="project-discovery" aria-label="Proyectos recientes">
              {loading ? <p className="project-discovery-message" role="status"><LoaderCircle size={15} className="project-spinner"/> Cargando recientes…</p>
                : filteredRecent.length ? filteredRecent.map(project => <div className="project-option-row" key={project.browserProjectId}>
                  <button type="button" className="project-option" onClick={() => void openRecent(project)} disabled={busy || !project.browserProjectId}><FolderOpen size={16}/><span><strong>{project.name}</strong><small>{project.available ? `${project.packages} ${project.packages === 1 ? 'paquete' : 'paquetes'}` : 'Reconstruir desde la carpeta guardada'}</small></span></button>
                  <button type="button" className="project-option-remove" title="Quitar de recientes" aria-label={`Quitar ${project.name} de recientes`} onClick={() => void removeRecent(project)} disabled={busy}><Trash2 size={14}/></button>
                </div>) : <div className="project-discovery-message"><span>{recent.length ? 'No hay coincidencias.' : 'Todavía no hay proyectos recientes en este navegador.'}</span><button type="button" className="mini" onClick={() => setOpenTab('folder')}><FolderOpen size={13}/> Elegir carpeta</button></div>}
            </div>
            <div className="project-discovery-footer"><span>Accesos guardados en Chrome; lista sincronizada con la base de datos local</span><button type="button" className="mini" onClick={() => void loadRecent()} disabled={loading}><RefreshCw size={13}/> Actualizar</button></div>
          </>}
        </> : dialog === 'create' ? <>
          <label>Nombre del proyecto<input ref={firstInput} value={name} onChange={event => setName(event.target.value)} maxLength={80} required/><small>Luego elegirás la carpeta contenedora en el selector del sistema.</small></label>
        </> : <div className="project-browser-pick"><p><strong>{pendingArchive?.name ?? 'Archivo seleccionado'}</strong><br/>Se extraerá en una carpeta nueva dentro de la ubicación que elijas.</p><button type="button" className="primary" onClick={() => void confirmImport()} disabled={busy || !supported}><FolderOpen size={15}/> Elegir destino e importar</button></div>}
        {error && <p role="alert" className="project-form-error">{error}</p>}
        <div className="dialog-actions"><button type="button" onClick={() => { setDialog(undefined); setPendingArchive(undefined); }} disabled={busy}>Cancelar</button>{dialog === 'create' && <button type="submit" className="primary" disabled={busy || !supported || !name.trim()}>{busy ? 'Creando…' : 'Elegir carpeta y crear'}</button>}</div>
      </form>
    </div>}
  </>;
}
