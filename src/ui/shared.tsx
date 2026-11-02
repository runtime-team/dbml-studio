import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { BookOpen, Clock, Eye, EyeOff, FilePlus, FileText, History as HistoryIcon, LogOut, MessageSquare, Pencil, Share2, Trash2, Users, X } from 'lucide-react';
import { CollaborationClient, type PresenceMember } from '../collaboration/client';
import { buildProjectPath, parseProjectPath, readShareToken } from '../collaboration/links';
import type { Diagnostic } from '../project/diagnostics';
import { Workspace, type PresenceDot, type Selection, type WorkspaceHandle } from './workspace';
import { CollabEditor } from './editor';
import { CommentsPanel } from './comments';
import { HistoryPanel } from './history';
import { AccessPanel } from './sharing';
import { SharedClient, type BuildPayload, type SharedInfo } from './shared-api';
import { colorFor, initials } from './logic';

const SESSION_KEY = 'dbml-session';
const readSession = () => { try { return sessionStorage.getItem(SESSION_KEY) ?? ''; } catch { return ''; } };
const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
type Drawer = 'history' | 'comments' | 'access' | undefined;

/** Evita recalcular cada pulsación: agrupa llamadas en una sola tras `ms`. */
function useDebounced(fn: () => void, ms: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(fn); latest.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(() => latest.current(), ms); }, [ms]);
}

function LoginForm({ onToken, registration, message }: { onToken(token: string): void; registration: boolean; message?: string }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState(''), [error, setError] = useState(''), [register, setRegister] = useState(false), [busy, setBusy] = useState(false), [showPassword, setShowPassword] = useState(false), [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (register && password !== confirmPassword) throw new Error('Las contraseñas no coinciden.');
      const response = await fetch(`/api/shared/${register ? 'register' : 'login'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, ...(register ? { confirmPassword } : {}) }) });
      const data = await response.json() as { token?: string; error?: string };
      if (!response.ok || !data.token) throw new Error(response.status === 403 && !register ? 'Usuario o contraseña incorrectos.' : data.error ?? 'No se pudo iniciar sesión.');
      try { sessionStorage.setItem(SESSION_KEY, data.token); } catch { /* almacenamiento no disponible: la sesión dura mientras la página */ }
      onToken(data.token); setPassword(''); setConfirmPassword('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <form className="shared-login" onSubmit={submit} aria-label={register ? 'Crear cuenta' : 'Iniciar sesión'} data-mode={register ? 'register' : 'login'}>
    <h2>{register ? 'Crear cuenta' : 'Iniciar sesión'}</h2>
    {message && <p className="shared-login-message">{message}</p>}
    <div className="shared-field"><label htmlFor="shared-username">Usuario</label><input id="shared-username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={64} pattern="[A-Za-z0-9._-]{3,64}" title="Usa de 3 a 64 letras, números, puntos, guiones o guiones bajos."/></div>
    <div className="shared-field"><label htmlFor="shared-password">Contraseña</label><div className="shared-password-field"><input id="shared-password" type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : 1} maxLength={1024} aria-describedby={register ? 'shared-password-help' : undefined}/><button type="button" className="shared-password-toggle" aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div></div>
    <div className="shared-login-registration" id="shared-login-registration" aria-hidden={!register} inert={!register} data-open={register}>
      <div className="shared-login-registration-inner">
        <div className="shared-field"><label htmlFor="shared-confirm-password">Confirmar contraseña</label><div className="shared-password-field"><input id="shared-confirm-password" type={showConfirmPassword ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" required={register} disabled={!register} minLength={12} maxLength={1024}/><button type="button" className="shared-password-toggle" aria-label={showConfirmPassword ? 'Ocultar confirmación de contraseña' : 'Mostrar confirmación de contraseña'} aria-pressed={showConfirmPassword} onClick={() => setShowConfirmPassword(value => !value)} tabIndex={register ? 0 : -1}>{showConfirmPassword ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div></div>
        <p id="shared-password-help" className="shared-login-help">El usuario admite letras, números, punto, guion y guion bajo. La contraseña debe tener al menos 12 caracteres.</p>
      </div>
    </div>
    <button className="primary shared-login-submit" type="submit" disabled={busy} aria-busy={busy}>{busy ? (register ? 'Creando cuenta…' : 'Iniciando sesión…') : (register ? 'Crear cuenta' : 'Entrar')}</button>
    {registration && <button type="button" className="shared-login-switch" aria-controls="shared-login-registration" aria-expanded={register} onClick={() => { setRegister(r => !r); setError(''); setConfirmPassword(''); }}>{register ? 'Ya tengo cuenta' : 'Crear una cuenta'}</button>}
    {error && <p role="alert" className="shared-login-error">{error}</p>}
  </form>;
}

function useConfig() {
  const [registration, setRegistration] = useState(false);
  useEffect(() => { fetch('/api/shared/config').then(r => r.json()).then((c: { registration?: boolean }) => setRegistration(!!c.registration)).catch(() => {}); }, []);
  return registration;
}

function Shell({ children, user, onLogout }: { children: React.ReactNode; user?: string | null; onLogout?: () => void }) {
  return <div className="shared-page"><header><a href="/">DBML Studio</a><span>Proyectos compartidos</span><span className="spacer"/>{user && <span className="user-chip"><Users size={14}/> {user}</span>}{onLogout && <button className="mini" onClick={onLogout}><LogOut size={13}/> Salir</button>}</header><main>{children}</main></div>;
}

/** Entrada de la sección compartida: lista de proyectos o un proyecto concreto según la URL. */
export function SharedApp() {
  const [token, setToken] = useState(readSession);
  const registration = useConfig();
  const location0 = useMemo(() => parseProjectPath(location.pathname, location.search), []);
  const [linkToken] = useState(() => {
    // El secreto del enlace llega en el fragmento; se guarda para la pestaña y se retira de la barra de direcciones.
    if (!location0) return undefined;
    const key = `dbml-share:${location0.projectId}`;
    const fromHash = readShareToken(location.hash);
    try {
      if (fromHash) { sessionStorage.setItem(key, fromHash); history.replaceState(null, '', location.pathname + location.search); return fromHash; }
      return sessionStorage.getItem(key) ?? undefined;
    } catch { return fromHash; }
  });
  const client = useMemo(() => new SharedClient(token, linkToken), [token, linkToken]);
  const [me, setMe] = useState<{ userId: string; username: string | null }>();
  useEffect(() => { setMe(undefined); if (token) client.request<{ userId: string; username: string | null }>('me').then(setMe).catch(() => { setToken(''); try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignorado */ } }); }, [token]);
  const logout = () => { void client.request('logout', {}).catch(() => {}); try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignorado */ } setToken(''); setMe(undefined); };

  if (!token) return <Shell><section className="shared-auth" aria-labelledby="shared-auth-title"><div className="shared-auth-intro"><h1 id="shared-auth-title">DBML Studio</h1><p>Inicia sesión para abrir y guardar tus proyectos.</p></div><LoginForm onToken={setToken} registration={registration}/></section></Shell>;
  if (location0) return <ProjectPage key={`${location0.projectId}:${token}`} client={client} initial={location0} me={me} registration={registration} onToken={setToken} onLogout={logout}/>;
  return <Shell user={me?.username} onLogout={token ? logout : undefined}>
    <h1>Proyectos compartidos</h1><p>Trabaja con otras personas sobre el mismo proyecto DBML, con permisos, comentarios e historial.</p>
    {!token ? <LoginForm onToken={setToken} registration={registration}/> : <ProjectList client={client}/>}
  </Shell>;
}

function ProjectList({ client }: { client: SharedClient }) {
  const [projects, setProjects] = useState<{ id: string; name: string; role: string }[]>();
  const [name, setName] = useState(''), [error, setError] = useState('');
  useEffect(() => { client.request<{ projects: typeof projects }>('projects').then(r => setProjects(r.projects)).catch(e => setError(e.message)); }, [client]);
  const create = async () => { try { const r = await client.request<{ id: string }>('projects', { name: name || 'Proyecto nuevo' }); location.assign(buildProjectPath({ projectId: r.id })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  return <section aria-label="Mis proyectos">
    <h2>Mis proyectos</h2>
    {error && <p role="alert" className="editor-error">{error}</p>}
    {!projects ? <p>Cargando…</p> : projects.length === 0 ? <p className="empty">Aún no participas en ningún proyecto.</p> : <ul className="project-list">{projects.map(p => <li key={p.id}><a href={buildProjectPath({ projectId: p.id })}>{p.name}</a><small>{p.role}</small></li>)}</ul>}
    <div className="compose row"><input value={name} onChange={e => setName(e.target.value)} placeholder="Nombre del proyecto nuevo" maxLength={80} aria-label="Nombre del proyecto nuevo"/><button className="primary" onClick={() => void create()}>Crear proyecto</button></div>
  </section>;
}

function ProjectPage({ client, initial, me, registration, onToken, onLogout }: { client: SharedClient; initial: NonNullable<ReturnType<typeof parseProjectPath>>; me?: { userId: string; username: string | null }; registration: boolean; onToken(token: string): void; onLogout?: () => void }) {
  const projectId = initial.projectId;
  const workspace = useRef<WorkspaceHandle>(null);
  const [info, setInfo] = useState<SharedInfo>();
  const [build, setBuild] = useState<BuildPayload>();
  const [fatal, setFatal] = useState<{ status: number; message: string }>();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [drawer, setDrawer] = useState<Drawer>();
  const [rev, setRev] = useState({ comments: 0, history: 0, docs: 0 });
  const [current, setCurrent] = useState(initial);
  const currentRef = useRef(current);
  currentRef.current = current;
  const pendingPackageNavigation = useRef<{ packageId: string; tableId?: string; connectorId?: string } | undefined>(undefined);
  const [editorOpen, setEditorOpen] = useState(true);
  const [fileId, setFileId] = useState<string>();
  const [selection, setSelection] = useState<Selection>();
  const [newFile, setNewFile] = useState<{ packageId: string; name: string }>();
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' }>();
  const [editorDoc, setEditorDoc] = useState<{ doc: Y.Doc; client: CollaborationClient }>();
  const [editorStatus, setEditorStatus] = useState('');
  // El editor es de solo lectura hasta recibir el estado inicial: escribir antes fusionaría texto sobre un documento vacío.
  const [editorSynced, setEditorSynced] = useState(false);
  const [docMembers, setDocMembers] = useState<PresenceMember[]>([]);
  const [conflict, setConflict] = useState('');
  const say = useCallback((text: string, kind: 'info' | 'error' = 'info') => { setToast({ text, kind }); setTimeout(() => setToast(t => t?.text === text ? undefined : t), kind === 'error' ? 8000 : 4000); }, []);

  const loadInfo = useCallback(async () => {
    try { setInfo(await client.info(projectId)); setFatal(undefined); }
    catch (e) { const err = e as Error & { status?: number }; setFatal({ status: err.status ?? 0, message: err.message }); }
  }, [client, projectId]);
  const loadBuild = useCallback(async () => { try { setBuild(await client.build(projectId)); } catch (e) { say(e instanceof Error ? e.message : String(e), 'error'); } }, [client, projectId, say]);
  const loadCounts = useCallback(async () => { try { setCounts((await client.request<{ counts: Record<string, number> }>(`${client.project(projectId)}/comments?status=open`)).counts); } catch { /* sin permiso o sin red */ } }, [client, projectId]);
  const refreshBuild = useDebounced(() => void loadBuild(), 500);
  const applyPackageRename = useCallback((from: string, to: string) => {
    if (currentRef.current.packageId !== from) return;
    const next = { ...currentRef.current, packageId: to };
    currentRef.current = next;
    pendingPackageNavigation.current = { packageId: to, tableId: next.tableId, connectorId: next.connectorId };
    setCurrent(next);
    history.replaceState(null, '', buildProjectPath(next));
  }, [projectId]);
  useEffect(() => { void loadInfo(); void loadBuild(); void loadCounts(); }, [loadInfo, loadBuild, loadCounts]);
  useEffect(() => {
    if (!info || (fileId && info.documents.some(doc => doc.id === fileId))) return;
    const preferred = info.documents.find(doc => doc.packageId === current.packageId) ?? info.documents[0];
    setFileId(preferred?.id);
  }, [info, fileId, current.packageId]);

  // Canal del proyecto: presencia y eventos. Los cambios de texto de cualquier archivo recompilan una sola vez tras una pausa.
  useEffect(() => {
    if (!info) return;
    const doc = new Y.Doc();
    const channel = new CollaborationClient(doc, {
      url: wsUrl(), projectId, sessionToken: client.token || undefined, linkToken: client.linkToken, editable: false,
      onStatus: setStatus, onPresence: setMembers, onProjectChanged: () => refreshBuild(),
      onEvent: event => {
        if (event.type === 'diagram-changed') void loadBuild();
        else if (event.type === 'documents-changed') { void loadInfo(); void loadBuild(); setRev(r => ({ ...r, docs: r.docs + 1 })); }
        else if (event.type === 'package-renamed') applyPackageRename(event.from, event.to);
        else if (event.type === 'comments-changed') { setRev(r => ({ ...r, comments: r.comments + 1 })); void loadCounts(); }
        else if (event.type === 'history-changed') setRev(r => ({ ...r, history: r.history + 1 }));
      },
    });
    channel.connect();
    return () => { channel.destroy(); doc.destroy(); };
  }, [info?.id, client, applyPackageRename]);

  // Editor del archivo elegido.
  useEffect(() => {
    if (!fileId || !info) { setEditorDoc(undefined); return; }
    setEditorSynced(false);
    const doc = new Y.Doc();
    const editorClient = new CollaborationClient(doc, {
      url: wsUrl(), projectId, documentId: fileId, sessionToken: client.token || undefined, linkToken: client.linkToken, editable: info.editable,
      onStatus: s => { if (s === 'connected') setEditorSynced(true); setEditorStatus(s === 'connected' ? '' : s === 'offline' ? 'Sin conexión: tus cambios se enviarán al reconectar.' : 'Conectando…'); },
      onPresence: setDocMembers, onError: setConflict,
    });
    editorClient.connect(); setEditorDoc({ doc, client: editorClient });
    return () => { editorClient.destroy(); doc.destroy(); setEditorDoc(undefined); setDocMembers([]); };
  }, [fileId, info?.id, info?.editable, client]);

  // URL <-> navegación: cada cambio de pestaña, tabla o conector actualiza la dirección y el historial del navegador.
  const navigateUrl = useCallback((target: { packageId: string; tableId?: string; connectorId?: string }) => {
    pendingPackageNavigation.current = undefined;
    const next = { ...currentRef.current, ...target };
    currentRef.current = next;
    setCurrent(next);
    history.pushState(null, '', buildProjectPath({ projectId, ...target }));
  }, [projectId]);
  useEffect(() => {
    const target = pendingPackageNavigation.current;
    if (!target || !build?.diagrams.some(diagram => diagram.packageId === target.packageId)) return;
    pendingPackageNavigation.current = undefined;
    workspace.current?.go(target, { silent: true });
  }, [build, current]);
  useEffect(() => {
    const onPop = () => { pendingPackageNavigation.current = undefined; const loc = parseProjectPath(location.pathname, location.search); if (loc?.packageId) workspace.current?.go({ packageId: loc.packageId, tableId: loc.tableId, connectorId: loc.connectorId }, { silent: true }); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => { document.title = info ? `${info.name} · DBML Studio` : 'DBML Studio'; }, [info?.name]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(undefined); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const docPackage = useMemo(() => new Map((info?.documents ?? []).map(d => [d.id, d.packageId])), [info?.documents]);
  const presence: PresenceDot[] = useMemo(() => members.flatMap(m => m.documentId && docPackage.get(m.documentId) && m.peerId !== undefined ? [{ name: m.name ?? 'Invitado', color: colorFor(m.userId ?? m.peerId), packageId: docPackage.get(m.documentId)! }] : []), [members, docPackage]);
  const people = useMemo(() => { const seen = new Map<string, { name: string; color: string }>(); for (const m of members) { const key = m.userId ?? m.peerId ?? ''; if (!seen.has(key)) seen.set(key, { name: m.name ?? 'Invitado', color: colorFor(m.userId ?? m.peerId) }); } return [...seen.values()]; }, [members]);

  if (fatal) {
    return <Shell user={me?.username} onLogout={onLogout}>
      <h1>{fatal.status === 404 ? 'Proyecto no encontrado' : 'Sin acceso a este proyecto'}</h1>
      <p role="alert" className="editor-error">{fatal.message}</p>
      {fatal.status === 403 && !client.token && <LoginForm onToken={onToken} registration={registration} message="Inicia sesión con una cuenta autorizada y comprueba que el enlace de acceso siga vigente."/>}
      {fatal.status === 403 && client.token && <p>Tu cuenta no tiene permiso para este proyecto. Pide al propietario que te invite o que te comparta un enlace.</p>}
      <p><a href="/shared">Volver a mis proyectos</a></p>
    </Shell>;
  }
  if (!info || !build) return <Shell user={me?.username} onLogout={onLogout}><p role="status">Cargando proyecto…</p></Shell>;

  const file = info.documents.find(d => d.id === fileId);
  const openFileByPath = (path?: string, line?: number) => {
    const doc = info.documents.find(d => `${d.packageId}/${d.name}` === path);
    if (doc) { setFileId(doc.id); setEditorOpen(true); }
    void line;
  };
  const createFile = async () => {
    if (!newFile) return;
    try { const r = await client.request<{ id: string }>(`${client.project(projectId)}/documents`, { packageId: newFile.packageId, name: newFile.name.endsWith('.dbml') ? newFile.name : `${newFile.name}.dbml`, content: '' }); setNewFile(undefined); await loadInfo(); setFileId(r.id); setEditorOpen(true); }
    catch (e) { say(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const deleteFile = async (id: string, label: string) => {
    if (!confirm(`¿Eliminar ${label}? Podrá recuperarse restaurando una versión anterior.`)) return;
    try { await client.request(`${client.project(projectId)}/documents/${id}/delete`, {}); if (fileId === id) setFileId(undefined); await loadInfo(); await loadBuild(); } catch (e) { say(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const renamePackage = async (packageId: string) => {
    const answer = window.prompt(`Nuevo identificador del paquete “${packageId}”`, packageId);
    if (answer === null) return;
    const nextPackageId = answer.trim();
    if (nextPackageId === packageId) return;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(nextPackageId)) { say('Usa de 1 a 80 letras, números, guion o guion bajo.', 'error'); return; }
    try {
      await client.request(`${client.project(projectId)}/packages/${encodeURIComponent(packageId)}/rename`, { packageId: nextPackageId });
      applyPackageRename(packageId, nextPackageId);
      await Promise.all([loadInfo(), loadBuild()]);
      say(`Paquete cambiado a ${nextPackageId}.`);
    } catch (e) { say(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const packages = [...new Set(info.documents.map(d => d.packageId))];
  const statusLabel = status === 'connected' ? 'En línea' : status === 'connecting' ? 'Conectando…' : 'Sin conexión';
  const diagnostics: Diagnostic[] = build.diagnostics;
  const location1 = { projectId, packageId: current.packageId, tableId: current.tableId, connectorId: current.connectorId };

  const editor = editorOpen ? <section className="editor" aria-label="Editor colaborativo">
    <div className="editor-toolbar">
      <label>Archivo <select value={fileId ?? ''} onChange={e => setFileId(e.target.value || undefined)}><option value="">Elige un archivo</option>{info.documents.map(d => <option key={d.id} value={d.id}>{d.packageId}/{d.name}</option>)}</select></label>
      <span className="editor-note">{info.editable ? 'Los cambios se sincronizan al escribir.' : 'Solo lectura.'}</span>
      <button className="mini" onClick={() => setEditorOpen(false)}>Ocultar</button>
    </div>
    {file && editorDoc ? <CollabEditor doc={editorDoc.doc} editable={info.editable && editorSynced} members={docMembers} selfPeerId={editorDoc.client.peerId} documentId={file.id} label={`Código de ${file.packageId}/${file.name}`} onSelection={(a, h, rel) => editorDoc.client.selection(a, h, rel)}/> : <p className="empty">Elige un archivo para ver o editar su contenido.</p>}
    {editorStatus && <p role="status" className="editor-error">{editorStatus}</p>}
    {conflict && <p role="alert" className="editor-error">{conflict} <button className="mini" onClick={() => setConflict('')}>Descartar</button></p>}
    {!build.ok && <p role="status" className="editor-note">Hay errores de sintaxis: el diagrama muestra la última versión válida mientras sigues editando.</p>}
  </section> : null;

  const files = <div className="files" aria-label="Archivos">
    <div className="side-heading second">ARCHIVOS</div>
    {packages.map(pkg => <div key={pkg} className="file-group"><div className="file-group-heading"><small>{pkg}</small>{info.editable && <button className="icon" aria-label={`Cambiar nombre del paquete ${pkg}`} title="Cambiar nombre" onClick={() => void renamePackage(pkg)}><Pencil size={12}/></button>}</div>
      {info.documents.filter(d => d.packageId === pkg).map(d => <div key={d.id} className={`file ${d.id === fileId ? 'active' : ''}`}>
        <button onClick={() => { setFileId(d.id); setEditorOpen(true); }}><FileText size={13}/> {d.name}{members.filter(m => m.documentId === d.id).slice(0, 3).map((m, i) => <i key={i} className="presence-dot" style={{ background: colorFor(m.userId ?? m.peerId) }} title={`${m.name ?? 'Invitado'} está editando`}/>)}</button>
        {info.editable && <button className="icon" aria-label={`Eliminar ${d.name}`} onClick={() => void deleteFile(d.id, `${pkg}/${d.name}`)}><Trash2 size={12}/></button>}
      </div>)}
    </div>)}
    {info.editable && (newFile
      ? <form className="new-file" onSubmit={e => { e.preventDefault(); void createFile(); }}><input list="pkgs" value={newFile.packageId} onChange={e => setNewFile({ ...newFile, packageId: e.target.value })} placeholder="paquete" aria-label="Paquete" required pattern="[a-zA-Z0-9_\-]{1,80}"/><datalist id="pkgs">{packages.map(p => <option key={p} value={p}/>)}</datalist><input value={newFile.name} onChange={e => setNewFile({ ...newFile, name: e.target.value })} placeholder="archivo.dbml" aria-label="Archivo" required pattern="[a-zA-Z0-9_\-]{1,120}(\.dbml)?"/><button className="mini primary" type="submit">Crear</button><button type="button" className="mini" onClick={() => setNewFile(undefined)}>Cancelar</button></form>
      : <button className="mini" onClick={() => setNewFile({ packageId: current.packageId ?? packages[0] ?? 'principal', name: '' })}><FilePlus size={12}/> Nuevo archivo</button>)}
  </div>;

  return <>
    <Workspace ref={workspace} projectName={info.name} diagrams={build.diagrams} diagnostics={diagnostics} graph={build.graph} stale={build.stale}
      initial={initial.packageId || initial.tableId || initial.connectorId ? { packageId: initial.packageId ?? build.diagrams[0]?.packageId ?? '', tableId: initial.tableId, connectorId: initial.connectorId } : undefined}
      editable={info.editable} commentCounts={counts} presence={presence}
      onNavigate={navigateUrl}
      onDiagramPatch={async (packageId, patch) => { await client.patch(projectId, packageId, patch); await loadBuild(); }}
      onRenamePackage={packageId => { void renamePackage(packageId); }}
      onExport={(name, params) => client.download(projectId, name, params)}
      fetchDefinition={async table => { try { return await client.definition(projectId, table); } catch { return undefined; } }}
      onOpenDiagnostic={d => openFileByPath(d.filepath, d.location?.start?.line)}
      onCopyLink={target => { void navigator.clipboard.writeText(`${location.origin}${buildProjectPath({ projectId, ...target })}`).then(() => workspace.current?.notice('Enlace copiado. Quien lo abra necesita permiso de acceso.'), () => workspace.current?.notice('No se pudo copiar el enlace.', 'error')); }}
      onCommentTarget={sel => { setSelection(sel); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.inspector .comments textarea')?.focus()); }}
      headerExtra={<>
        <span className={`sync sync-${status}`} role="status" title={statusLabel}><i/> {statusLabel}</span>
        <div className="people" aria-label={`${people.length} persona(s) conectada(s)`}>{people.slice(0, 5).map((p, i) => <span key={i} className="avatar" style={{ background: p.color }} title={p.name}>{initials(p.name)}</span>)}{people.length > 5 && <span className="avatar more">+{people.length - 5}</span>}</div>
        {info.role && <span className="role-chip" title="Tu rol en este proyecto">{info.role === 'owner' ? 'Propietario' : info.role === 'editor' ? 'Editor' : info.role === 'commenter' ? 'Comentarista' : 'Lector'}</span>}
        <button className="search-button" onClick={() => setDrawer(d => d === 'comments' ? undefined : 'comments')} aria-pressed={drawer === 'comments'}><MessageSquare size={15}/> Comentarios</button>
        <button className="search-button" onClick={() => setDrawer(d => d === 'history' ? undefined : 'history')} aria-pressed={drawer === 'history'}><HistoryIcon size={15}/> Versiones</button>
        {info.admin && <button className="search-button" onClick={() => setDrawer(d => d === 'access' ? undefined : 'access')} aria-pressed={drawer === 'access'}><Share2 size={15}/> Compartir</button>}
        <a className="search-button" href="/docs/" target="_blank" rel="noreferrer" title="Abrir la documentación de DBML Studio"><BookOpen size={15}/> Documentación</a>
        <a className="search-button" href="/shared"><Clock size={15}/> Proyectos</a>
        {onLogout && <button className="search-button" onClick={onLogout}><LogOut size={15}/> Salir</button>}
        {!client.token && <a className="search-button" href={`/shared`}>Iniciar sesión</a>}
      </>}
      sidebarExtra={files} bottom={editor}
      inspectorExtra={sel => <CommentsPanel client={client} projectId={projectId} diagrams={build.diagrams} selection={sel} canComment={info.commentable} admin={info.admin} meId={me?.userId} revision={rev.comments} onNavigate={t => workspace.current?.go(t)} onError={m => say(m, 'error')}/>}
    />
    {drawer && <aside className="drawer" role="dialog" aria-label={drawer === 'history' ? 'Versiones' : drawer === 'comments' ? 'Comentarios' : 'Compartir'}>
      <button className="drawer-close" onClick={() => setDrawer(undefined)} aria-label="Cerrar panel"><X size={16}/></button>
      {drawer === 'history' && <HistoryPanel client={client} projectId={projectId} canEdit={info.editable} revision={rev.history} onError={m => say(m, 'error')} onRestored={() => { say('Versión restaurada como una revisión nueva.'); void loadInfo(); void loadBuild(); }} onNavigatePackage={p => { workspace.current?.go({ packageId: p }); }}/>}
      {drawer === 'comments' && <CommentsPanel all client={client} projectId={projectId} diagrams={build.diagrams} selection={selection} canComment={info.commentable} admin={info.admin} meId={me?.userId} revision={rev.comments} onNavigate={t => { workspace.current?.go(t); }} onError={m => say(m, 'error')}/>}
      {drawer === 'access' && <AccessPanel client={client} projectId={projectId} name={info.name} location={location1} revision={rev.history} onRenamed={() => void loadInfo()} onNotice={say}/>}
    </aside>}
    {toast && <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>{toast.text}<button aria-label="Cerrar aviso" onClick={() => setToast(undefined)}>×</button></div>}
  </>;
}
