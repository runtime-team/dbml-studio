import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Database, Pencil } from 'lucide-react';
import type { Diagram } from '../diagram/model';
import type { Diagnostic } from '../project/diagnostics';
import type { DependencyGraph } from '../project/dependencies';
import type { DiagramPatch } from '../project/diagram-config';
import { isSaveShortcut, sourceFileForPackage } from './logic';
import { Workspace, type WorkspaceHandle } from './workspace';
import { downloadResponse } from './download';
import type { Definition } from './inspector';
import { ProjectManager, readActiveBrowserProject, type BrowserRecentProject } from './project-manager';
import type { BrowserProjectSelection, ProjectDirectoryHandle } from './filesystem-projects';

const CodeEditor = lazy(() => import('./code-editor').then(module => ({ default: module.CodeEditor })));

interface LocalFile { packageId: string; filename: string; content: string; revision: string }
interface LocalState {
  name: string; manifestPath?: string; browserProjectId?: string; ok: boolean; stale: boolean; files: LocalFile[]; configs: Record<string, { revision: string; content: string }>;
  diagrams: Diagram[]; diagnostics: Diagnostic[]; graph: DependencyGraph | null;
}

async function call<T>(path: string, body?: unknown, manifestPath?: string): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (manifestPath) headers.set('x-dbml-manifest', manifestPath);
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let data: { error?: string } & Record<string, unknown>;
  try { data = raw ? JSON.parse(raw) as { error?: string } & Record<string, unknown> : {}; }
  catch { data = { error: raw || `La API respondió sin JSON (HTTP ${response.status}).` }; }
  if (!response.ok) throw new Error(data.error ?? `Error ${response.status}`);
  return data as T;
}

async function openBrowserSnapshot(id: string, archive: Uint8Array): Promise<LocalState> {
  const fs = await import('./filesystem-projects');
  const response = await fetch('/api/projects/open-browser', {
    method: 'POST', headers: { 'content-type': 'application/zip', 'x-dbml-browser-project': id }, body: fs.archiveAsBlob(archive),
  });
  const raw = await response.text();
  let next: LocalState & { error?: string };
  try { next = raw ? JSON.parse(raw) as LocalState & { error?: string } : {} as LocalState & { error?: string }; }
  catch { throw new Error(raw || `La API respondió sin JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(next.error ?? `No se pudo abrir la carpeta (HTTP ${response.status}).`);
  if (!next.manifestPath) throw new Error('El servidor no devolvió el identificador interno del proyecto.');
  return { ...next, browserProjectId: id };
}

/** El navegador lee y escribe los archivos; el servidor recibe una instantánea para compilar y exportar. */
export function LocalApp() {
  const [state, setState] = useState<LocalState>();
  const [error, setError] = useState('');
  const [startupReady, setStartupReady] = useState(false);
  const workspace = useRef<WorkspaceHandle>(null);
  const browserProject = useRef<{ id: string; handle: ProjectDirectoryHandle; sourceRoot: string } | undefined>(undefined);
  const lastKnownFiles = useRef(new Map<string, string>());
  const [editor, setEditor] = useState(true);
  const [fileKey, setFileKey] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [exportingProject, setExportingProject] = useState(false);
  const savingRef = useRef(false);
  const saveAction = useRef<() => void>(() => {});
  const [editorMessage, setEditorMessage] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const fileByPackage = useRef(new Map<string, string>());
  const [focusLineRequest, setFocusLineRequest] = useState<{ fileKey: string; line: number; nonce: number }>();
  const params = useMemo(() => new URLSearchParams(location.search), []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const lastId = readActiveBrowserProject();
      if (!lastId) return;
      const fs = await import('./filesystem-projects');
      if (!fs.supportsFileSystemAccess()) return;
      const stored = await fs.getProjectHandle(lastId);
      if (!stored || !await fs.hasProjectPermission(stored.handle)) return;
      const snapshot = await fs.archiveProjectDirectory(stored.handle);
      const initial = await openBrowserSnapshot(lastId, snapshot.archive);
      if (live) {
        browserProject.current = { id: lastId, handle: stored.handle, sourceRoot: snapshot.sourceRoot };
        lastKnownFiles.current = new Map(initial.files.map(file => [`${file.packageId}/${file.filename}`, file.content]));
        setState(initial);
      }
    })().catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); }).finally(() => { if (live) setStartupReady(true); });
    return () => { live = false; };
  }, []);

  const key = (f: { packageId: string; filename: string }) => `${f.packageId}/${f.filename}`;
  const file = state?.files.find(f => key(f) === fileKey);
  const draft = file ? drafts[fileKey] ?? file.content : '';
  const dirty = !!dirtyFiles[fileKey];
  const unsavedCount = Object.values(dirtyFiles).filter(Boolean).length;
  useEffect(() => {
    if (!state || fileKey) return;
    const preferredPackage = params.get('package');
    const activePackage = state.diagrams.some(diagram => diagram.packageId === preferredPackage) ? preferredPackage : state.diagrams[0]?.packageId;
    const first = state.files.find(f => f.packageId === activePackage) ?? state.files[0];
    if (first) { const firstKey = key(first); fileByPackage.current.set(first.packageId, firstKey); setFileKey(firstKey); }
  }, [state?.manifestPath, fileKey, params]);
  const openFile = useCallback((next: LocalFile, line?: number) => {
    const nextKey = `${next.packageId}/${next.filename}`;
    fileByPackage.current.set(next.packageId, nextKey);
    setEditor(true); setFileKey(nextKey); setEditorMessage(undefined);
    setFocusLineRequest(previous => line ? { fileKey: nextKey, line, nonce: (previous?.nonce ?? 0) + 1 } : undefined);
  }, []);

  const initial = useMemo(() => {
    if (!state) return undefined;
    const requested = params.get('package');
    const packageId = state.diagrams.some(d => d.packageId === requested) ? requested! : state.diagrams[0]?.packageId ?? '';
    return { packageId, tableId: params.get('table') ?? undefined };
  }, [state?.manifestPath, params]);

  const activateProject = (next: LocalState, handle: ProjectDirectoryHandle, sourceRoot: string) => {
    browserProject.current = { id: next.browserProjectId ?? '', handle, sourceRoot };
    lastKnownFiles.current = new Map(next.files.map(file => [`${file.packageId}/${file.filename}`, file.content]));
    setState(next); setError(''); setFileKey(''); draftsRef.current = {}; setDrafts({}); setDirtyFiles({}); setEditorMessage(undefined); setFocusLineRequest(undefined); fileByPackage.current.clear();
    params.delete('package'); params.delete('table'); params.delete('connector');
    history.replaceState(null, '', '/');
  };
  const canLeaveProject = () => !Object.values(dirtyFiles).some(Boolean) || window.confirm('Hay cambios sin guardar. Si continúas, se descartarán. ¿Cambiar de proyecto?');
  const openSelection = async (selection: BrowserProjectSelection) => {
    const next = await openBrowserSnapshot(selection.id, selection.archive);
    await (await import('./filesystem-projects')).rememberProjectHandle({ id: selection.id, handle: selection.handle, sourceRoot: selection.sourceRoot, name: next.name, savedAt: Date.now() });
    if (next.manifestPath) try { window.localStorage.setItem('dbml-studio:active-browser-project', selection.id); } catch { /* El proyecto queda abierto aunque localStorage no esté disponible. */ }
    activateProject(next, selection.handle, selection.sourceRoot);
    return true;
  };
  const openProject = async (project: BrowserRecentProject) => {
    if (!canLeaveProject()) return false;
    const fs = await import('./filesystem-projects');
    const stored = project.browserProjectId ? await fs.getProjectHandle(project.browserProjectId) : undefined;
    if (!stored) throw new Error('Chrome ya no conserva el acceso a esa carpeta. Usa “Abrir carpeta” para seleccionarla de nuevo.');
    await fs.requestProjectPermission(stored.handle);
    const snapshot = await fs.archiveProjectDirectory(stored.handle);
    return openSelection({ ...snapshot, id: stored.id });
  };
  const browseProject = async () => {
    const fs = await import('./filesystem-projects');
    const handle = await fs.chooseProjectDirectory();
    if (!canLeaveProject()) return false;
    const existing = await fs.findProjectHandle(handle);
    const snapshot = await fs.archiveProjectDirectory(handle);
    return openSelection({ ...snapshot, id: existing?.id ?? snapshot.id });
  };
  const createProject = async (name: string) => {
    if (!canLeaveProject()) return false;
    const selection = await (await import('./filesystem-projects')).createProjectDirectory(name);
    return openSelection(selection);
  };

  const send = async (path: string, extra: Record<string, unknown>) => {
    if (!file) return;
    const submittedKey = fileKey, submittedDraft = draft, submittedFile = file;
    const isSaving = path === '/api/save';
    if (isSaving) {
      if (savingRef.current) return;
      savingRef.current = true; setSaving(true);
    }
    try {
      const active = browserProject.current;
      if (isSaving && active) {
        const diskContent = await (await import('./filesystem-projects')).readPackageFile(active.handle, active.sourceRoot, submittedFile.packageId, submittedFile.filename);
        const expectedContent = lastKnownFiles.current.get(submittedKey) ?? submittedFile.content;
        if (diskContent !== expectedContent && diskContent !== submittedDraft) throw new Error(`El archivo ${submittedFile.filename} cambió fuera de DBML Studio. Vuelve a abrir la carpeta para cargar su versión actual.`);
      }
      const next = await call<LocalState>(path, { packageId: submittedFile.packageId, filename: submittedFile.filename, content: submittedDraft, revision: submittedFile.revision, ...extra }, state?.manifestPath);
      if (isSaving) setState(next);
      if (isSaving && browserProject.current) {
        const active = browserProject.current;
        await (await import('./filesystem-projects')).writePackageFile(active.handle, active.sourceRoot, submittedFile.packageId, submittedFile.filename, submittedDraft);
        lastKnownFiles.current.set(submittedKey, submittedDraft);
      }
      setState(next);
      if (isSaving) {
        const stillDirty = (draftsRef.current[submittedKey] ?? submittedFile.content) !== submittedDraft;
        setDirtyFiles(previous => ({ ...previous, [submittedKey]: stillDirty }));
        setEditorMessage({ kind: next.ok ? 'ok' : 'error', text: next.ok ? 'Guardado y compilado.' : 'Guardado con errores de compilacion.' });
      } else setEditorMessage({ kind: next.ok ? 'ok' : 'error', text: next.ok ? 'Vista previa compilada (sin guardar).' : 'La vista previa tiene errores.' });
    } catch (cause) { setEditorMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) }); }
    finally { if (isSaving) { savingRef.current = false; setSaving(false); } }
  };

  saveAction.current = () => { if (file && dirty && !savingRef.current) void send('/api/save', {}); };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault(); event.stopPropagation(); saveAction.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  const patch = useCallback(async (packageId: string, diagramPatch: DiagramPatch) => {
    if (!state) return;
    try {
      const active = browserProject.current;
      if (active) {
        const fs = await import('./filesystem-projects');
        const diskConfig = await fs.readPackageFile(active.handle, active.sourceRoot, packageId, 'diagram.yaml');
        const expectedConfig = state.configs[packageId]?.content ?? '';
        if (diskConfig !== expectedConfig) throw new Error('diagram.yaml cambió fuera de DBML Studio. Vuelve a abrir la carpeta para cargar su versión actual.');
      }
      const next = await call<LocalState>('/api/diagram', { packageId, patch: diagramPatch, revision: state.configs[packageId]?.revision ?? '' }, state.manifestPath);
      setState(next);
      const activeHandle = browserProject.current;
      const config = next.configs[packageId]?.content;
      if (activeHandle && config !== undefined) await (await import('./filesystem-projects')).writePackageFile(activeHandle.handle, activeHandle.sourceRoot, packageId, 'diagram.yaml', config);
    }
    catch (e) {
      // Un conflicto indica que diagram.yaml cambió en disco: se recarga antes de reintentar.
      try { setState(await call<LocalState>('/api/project', undefined, state.manifestPath)); } catch { /* se mantiene el estado actual */ }
      throw e;
    }
  }, [state]);

  const exportFile = useCallback(async (name: string, options: Record<string, string>) => {
    const query = new URLSearchParams(options).toString();
    await downloadResponse(await fetch(`/api/export/${encodeURIComponent(name)}${query ? `?${query}` : ''}`, { headers: state?.manifestPath ? { 'x-dbml-manifest': state.manifestPath } : undefined }), name);
  }, [state?.manifestPath]);

  const exportProject = async () => {
    if (!state) return;
    if (savingRef.current) throw new Error('Espera a que termine el guardado actual antes de exportar.');
    savingRef.current = true;
    setExportingProject(true);
    const pending = state.files.filter(f => dirtyFiles[key(f)]).map(f => ({ file: f, fileKey: key(f), content: draftsRef.current[key(f)] ?? f.content }));
    if (pending.length) setSaving(true);
    try {
      let latest = state;
      for (const item of pending) {
        const latestFile = latest.files.find(f => key(f) === item.fileKey);
        if (!latestFile) throw new Error(`El archivo ${item.fileKey} ya no existe en el proyecto.`);
        const active = browserProject.current;
        if (active) {
          const fs = await import('./filesystem-projects');
          const diskContent = await fs.readPackageFile(active.handle, active.sourceRoot, item.file.packageId, item.file.filename);
          const expectedContent = lastKnownFiles.current.get(item.fileKey) ?? latestFile.content;
          if (diskContent !== expectedContent && diskContent !== item.content) throw new Error(`El archivo ${item.file.filename} cambió fuera de DBML Studio.`);
        }
        latest = await call<LocalState>('/api/save', {
          packageId: item.file.packageId, filename: item.file.filename, content: item.content, revision: latestFile.revision,
        }, latest.manifestPath);
        setState(latest);
        if (active) {
          const fs = await import('./filesystem-projects');
          await fs.writePackageFile(active.handle, active.sourceRoot, item.file.packageId, item.file.filename, item.content);
          lastKnownFiles.current.set(item.fileKey, item.content);
        }
        setDirtyFiles(previous => ({ ...previous, [item.fileKey]: draftsRef.current[item.fileKey] !== item.content }));
      }
      if (pending.length) {
        setState(latest);
        setDirtyFiles(previous => {
          const next = { ...previous };
          for (const item of pending) next[item.fileKey] = draftsRef.current[item.fileKey] !== item.content;
          return next;
        });
      }
      const headers = latest.manifestPath ? { 'x-dbml-manifest': latest.manifestPath } : undefined;
      await downloadResponse(await fetch('/api/project/export', { headers }), `${latest.name}.dbml-project.zip`);
      workspace.current?.notice('Proyecto exportado como archivo ZIP.');
    } finally {
      savingRef.current = false;
      setSaving(false);
      setExportingProject(false);
    }
  };

  const importProject = async (archive: File) => {
    if (savingRef.current) throw new Error('Espera a que termine el guardado actual antes de importar.');
    const selection = await (await import('./filesystem-projects')).importProjectArchive(archive);
    if (!canLeaveProject()) return false;
    return openSelection(selection);
  };

  if (!state) {
    if (!startupReady) return <div className="message" role="status">Preparando proyectos recientes…</div>;
    return <main className="project-start"><section><span className="brand-mark"><Database size={18}/></span><h1>{error ? 'No se pudo abrir el proyecto' : 'Elige una carpeta de proyecto'}</h1>{error && <p role="alert">{error}</p>}<ProjectManager standalone onOpen={openProject} onBrowse={browseProject} onCreate={createProject} onExport={exportProject} onImport={importProject}/></section></main>;
  }

  const bottom = editor ? <section className="editor" aria-label="Editor DBML">
    <div className="editor-toolbar">
      <label>Archivo <select value={fileKey} onChange={e => { const f = state.files.find(x => key(x) === e.target.value); if (f) openFile(f); }}>
        <option value="" disabled>Elige un archivo</option>
        {state.files.map(f => <option key={key(f)} value={key(f)}>{key(f)}</option>)}
      </select></label>
      {file && <>
        <button onClick={() => void send('/api/preview', {})}>Vista previa</button>
        <button className="primary" onClick={() => void send('/api/save', {})} disabled={!dirty || saving || exportingProject} title="Guardar (Ctrl+S)" aria-keyshortcuts="Control+S Meta+S">{exportingProject ? 'Guardando y exportando...' : saving ? 'Guardando...' : 'Guardar'}</button>
        <span className="editor-note">{dirty ? 'Cambios sin guardar' : unsavedCount ? `${unsavedCount} archivo(s) sin guardar` : 'Sin cambios'}</span>
      </>}
      <button className="mini" onClick={() => setEditor(false)}>Ocultar</button>
    </div>
    {file ? <Suspense fallback={<p className="code-editor-loading" role="status">Cargando editor...</p>}><CodeEditor key={fileKey} value={draft} ariaLabel={`DBML ${key(file)}`} focusLineRequest={focusLineRequest?.fileKey === fileKey ? focusLineRequest : undefined} onChange={value => { const next = { ...draftsRef.current, [fileKey]: value }; draftsRef.current = next; setDrafts(next); setDirtyFiles(previous => ({ ...previous, [fileKey]: true })); setEditorMessage(undefined); }}/></Suspense> : <p className="empty">Elige un archivo para editarlo.</p>}
    {editorMessage && <p role={editorMessage.kind === 'error' ? 'alert' : 'status'} className={editorMessage.kind === 'error' ? 'editor-error' : 'editor-ok'}>{editorMessage.text}</p>}
  </section> : null;

  return <Workspace key={state.browserProjectId ?? state.name} ref={workspace} projectName={state.name} projectControl={<ProjectManager current={state.browserProjectId ? { name: state.name, browserProjectId: state.browserProjectId } : undefined} onOpen={openProject} onBrowse={browseProject} onCreate={createProject} onExport={exportProject} onImport={importProject}/>} diagrams={state.diagrams} diagnostics={state.diagnostics} graph={state.graph} stale={state.stale} initial={initial} editable
    onNavigate={target => {
      const url = new URL(location.href); url.searchParams.set('package', target.packageId); if (target.tableId) url.searchParams.set('table', target.tableId); else url.searchParams.delete('table'); history.replaceState(null, '', url);
      const remembered = fileByPackage.current.get(target.packageId);
      const targetFile = sourceFileForPackage(state.files, target.packageId, remembered);
      if (targetFile && targetFile.packageId !== file?.packageId) openFile(targetFile);
      else if (!targetFile && file?.packageId !== target.packageId) { setFileKey(''); setEditorMessage(undefined); }
    }}
    onDiagramPatch={patch} onExport={exportFile}
    fetchDefinition={async tableId => { try { return await call<Definition>(`/api/definition?table=${encodeURIComponent(tableId)}`, undefined, state.manifestPath); } catch { return undefined; } }}
    onOpenDiagnostic={d => { const f = state.files.find(x => d.filepath === key(x)); if (f) openFile(f, d.location?.start?.line); else if (!state.diagrams.length) setEditor(true); }}
    onCopyLink={target => { const url = new URL(location.origin); url.searchParams.set('package', target.packageId); if (target.tableId) url.searchParams.set('table', target.tableId); void navigator.clipboard.writeText(url.toString()).then(() => workspace.current?.notice('Enlace copiado.'), () => workspace.current?.notice('No se pudo copiar el enlace.', 'error')); }}
    headerExtra={<>
      <a className="search-button" href="/docs/" target="_blank" rel="noreferrer" title="Abrir la documentación de DBML Studio"><BookOpen size={15}/> Documentación</a>
      <button className="search-button" onClick={() => { setEditor(e => !e); if (!file && state.files[0]) openFile(state.files[0]); }} aria-pressed={editor}><Pencil size={15}/> {editor ? 'Ocultar editor' : 'Mostrar editor'}</button>
    </>}
    bottom={bottom}/>;
}
