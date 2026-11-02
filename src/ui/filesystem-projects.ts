import { parse } from 'yaml';
import { strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10_000;
const SKIPPED_DIRECTORIES = new Set(['.git', '.data', '.cache', 'node_modules', 'dist', 'out', 'coverage']);
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type ProjectDirectoryHandle = FileSystemDirectoryHandle;
export interface BrowserProjectSelection { id: string; handle: ProjectDirectoryHandle; archive: Uint8Array; sourceRoot: string }
export interface StoredBrowserProject { id: string; handle: ProjectDirectoryHandle; sourceRoot: string; name: string; savedAt: number }
type ComparableDirectoryHandle = ProjectDirectoryHandle & { isSameEntry?(other: FileSystemHandle): Promise<boolean> };
type PermissionDirectoryHandle = ProjectDirectoryHandle & {
  queryPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
};

type PickerWindow = Window & { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<ProjectDirectoryHandle> };

function picker(): PickerWindow['showDirectoryPicker'] {
  const fn = (window as PickerWindow).showDirectoryPicker;
  if (!window.isSecureContext || !fn) throw new Error('El acceso a carpetas requiere Chrome o Edge y una conexión segura (HTTPS o localhost).');
  return fn;
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

export async function chooseProjectDirectory(): Promise<ProjectDirectoryHandle> {
  try { return await picker()!.call(window, { mode: 'readwrite' }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Se canceló la selección de carpeta.');
    throw error;
  }
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dbml-studio-project-handles', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir el almacenamiento local del navegador.'));
  });
}

async function withHandleStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openHandleDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction('projects', mode).objectStore('projects'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('No se pudo guardar el acceso a la carpeta.'));
    });
  } finally { db.close(); }
}

export async function rememberProjectHandle(project: StoredBrowserProject): Promise<void> {
  await withHandleStore('readwrite', store => store.put(project));
}

export async function getProjectHandle(id: string): Promise<StoredBrowserProject | undefined> {
  return withHandleStore('readonly', store => store.get(id));
}

export async function findProjectHandle(handle: ProjectDirectoryHandle): Promise<StoredBrowserProject | undefined> {
  const records = await withHandleStore('readonly', store => store.getAll());
  const candidate = handle as ComparableDirectoryHandle;
  for (const record of records as StoredBrowserProject[]) {
    const stored = record.handle as ComparableDirectoryHandle;
    if (candidate.isSameEntry && await candidate.isSameEntry(stored)) return record;
  }
  return undefined;
}

export async function forgetProjectHandle(id: string): Promise<void> {
  await withHandleStore('readwrite', store => store.delete(id));
}

export async function requestProjectPermission(handle: ProjectDirectoryHandle): Promise<void> {
  const descriptor = { mode: 'readwrite' as const };
  const permissionHandle = handle as PermissionDirectoryHandle;
  if (await permissionHandle.queryPermission(descriptor) === 'granted') return;
  if (await permissionHandle.requestPermission(descriptor) !== 'granted') throw new Error(`Chrome no concedió acceso a la carpeta “${handle.name}”.`);
}

export async function hasProjectPermission(handle: ProjectDirectoryHandle): Promise<boolean> {
  return (await (handle as PermissionDirectoryHandle).queryPermission({ mode: 'readwrite' })) === 'granted';
}

function safeRelativePath(value: string): string[] {
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\0')) throw new Error('El proyecto contiene una ruta de archivo inválida.');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || RESERVED_NAME.test(part) || part === '__proto__'))
    throw new Error(`El proyecto contiene una ruta no permitida: ${value}`);
  return parts;
}

function relativeSourceRoot(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') return '';
  return safeRelativePath(normalized).join('/');
}

async function writeFile(root: ProjectDirectoryHandle, relativePath: string, content: string | Uint8Array): Promise<void> {
  const parts = safeRelativePath(relativePath);
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const file = await directory.getFileHandle(parts.at(-1)!, { create: true });
  const writable = await file.createWritable();
  try { await writable.write(typeof content === 'string' ? content : new Uint8Array(content).buffer as ArrayBuffer); } finally { await writable.close(); }
}

async function readFile(root: ProjectDirectoryHandle, relativePath: string): Promise<string> {
  const parts = safeRelativePath(relativePath);
  let directory = root;
  try {
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    return (await (await directory.getFileHandle(parts.at(-1)!)).getFile()).text();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return '';
    throw error;
  }
}

async function readManifest(root: ProjectDirectoryHandle): Promise<{ text: string; sourceRoot: string; name: string }> {
  let file: FileSystemFileHandle;
  try { file = await root.getFileHandle('dbml.project.yaml'); }
  catch { try { file = await root.getFileHandle('dbml.project.yml'); } catch { throw new Error('La carpeta seleccionada no contiene dbml.project.yaml ni dbml.project.yml.'); } }
  const text = await (await file.getFile()).text();
  let parsed: { name?: unknown; source?: { root?: unknown } };
  try { parsed = parse(text) as typeof parsed; }
  catch (error) { throw new Error(`El manifiesto no contiene YAML válido: ${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed.name !== 'string') throw new Error('El manifiesto no contiene el nombre del proyecto.');
  const sourceRoot = parsed.source?.root ?? '.';
  if (typeof sourceRoot !== 'string') throw new Error('source.root debe ser una ruta relativa.');
  relativeSourceRoot(sourceRoot);
  return { text, sourceRoot, name: parsed.name };
}

export async function archiveProjectDirectory(handle: ProjectDirectoryHandle): Promise<BrowserProjectSelection> {
  const { sourceRoot } = await readManifest(handle);
  const entries: Zippable = Object.create(null) as Zippable;
  let count = 0, total = 0;
  const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const entry of directory.values()) {
      if (entry.kind === 'directory') {
        if (!SKIPPED_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US')))
          await walk(entry, prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelativePath(path);
      const bytes = new Uint8Array(await (await entry.getFile()).arrayBuffer());
      if (bytes.byteLength > MAX_FILE_BYTES || ++count > MAX_FILES || total + bytes.byteLength > MAX_CONTENT_BYTES)
        throw new Error('La carpeta del proyecto supera los límites de tamaño permitidos.');
      total += bytes.byteLength;
      entries[path] = bytes;
    }
  };
  await walk(handle, '');
  if (!count) throw new Error('La carpeta seleccionada está vacía.');
  const archive = zipSync(entries, { level: 1, mtime: new Date(1980, 0, 1) });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('El proyecto comprimido supera el límite de 100 MiB.');
  return { id: crypto.randomUUID(), handle, archive, sourceRoot };
}

export async function createProjectDirectory(name: string): Promise<BrowserProjectSelection> {
  const parent = await chooseProjectDirectory();
  const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'proyecto';
  let root: ProjectDirectoryHandle | undefined;
  for (let suffix = 1; suffix <= 1000; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    try { await parent.getDirectoryHandle(candidate); continue; }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
      root = await parent.getDirectoryHandle(candidate, { create: true });
      break;
    }
  }
  if (!root) throw new Error('No se encontró un nombre de carpeta libre para el proyecto.');
  const manifest = `name: ${JSON.stringify(name)}\nversion: 1\n\nsource:\n  root: .\n  packages:\n    - principal\n\noutput:\n  directory: output\n  formats:\n    - svg\n    - pdf\n`;
  await writeFile(root, 'dbml.project.yaml', manifest);
  await writeFile(root, 'principal/schema.dbml', 'Table ejemplo {\n  id integer [pk]\n  nombre varchar(120)\n}\n');
  const snapshot = await archiveProjectDirectory(root);
  return { ...snapshot, id: crypto.randomUUID() };
}

function validateArchivePath(path: string): string | undefined {
  const directory = path.endsWith('/');
  const normalized = directory ? path.slice(0, -1) : path;
  if (!normalized) return undefined;
  const parts = safeRelativePath(normalized);
  return directory ? undefined : parts.join('/');
}

export async function importProjectArchive(file: File): Promise<BrowserProjectSelection> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('El archivo ZIP supera el límite de 100 MiB.');
  const parent = await chooseProjectDirectory();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let count = 0, total = 0, validationError = '';
  const seen = new Set<string>();
  const extracted = unzipSync(bytes, { filter: entry => {
    try {
      if (++count > MAX_FILES) throw new Error('El ZIP contiene demasiados archivos.');
      const path = validateArchivePath(entry.name);
      if (path) {
        const key = path.toLocaleLowerCase('en-US');
        if (seen.has(key)) throw new Error(`El ZIP repite la ruta ${path}.`);
        seen.add(key);
        if (entry.originalSize > MAX_FILE_BYTES || total + entry.originalSize > MAX_CONTENT_BYTES) throw new Error('El ZIP descomprimido supera el límite de tamaño.');
        total += entry.originalSize;
      }
      return true;
    } catch (error) { validationError = error instanceof Error ? error.message : String(error); return false; }
  } });
  if (validationError) throw new Error(validationError);
  const manifests = Object.keys(extracted).filter(path => /(^|\/)dbml\.project\.ya?ml$/i.test(path));
  if (manifests.length !== 1) throw new Error('El ZIP debe incluir un único manifiesto DBML.');
  const manifestPath = manifests[0]!;
  const prefix = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : '';
  if (prefix && Object.keys(extracted).some(path => !path.startsWith(prefix))) throw new Error('Los archivos del ZIP deben estar dentro de la carpeta del manifiesto.');
  const relativeFiles = Object.keys(extracted).map(path => [prefix ? path.slice(prefix.length) : path, extracted[path]!] as const).filter(([path]) => !!path);
  const manifestBytes = relativeFiles.find(([path]) => path === manifestPath.slice(prefix.length))?.[1];
  if (!manifestBytes) throw new Error('No se pudo leer el manifiesto del ZIP.');
  let metadata: { name?: unknown };
  try { metadata = parse(strFromU8(manifestBytes)) as typeof metadata; }
  catch { throw new Error('El manifiesto del ZIP no contiene YAML válido.'); }
  if (typeof metadata?.name !== 'string') throw new Error('El manifiesto no contiene el nombre del proyecto.');
  const base = metadata.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'proyecto';
  let root: ProjectDirectoryHandle | undefined;
  for (let suffix = 1; suffix <= 1000; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    try { await parent.getDirectoryHandle(candidate); continue; }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
      root = await parent.getDirectoryHandle(candidate, { create: true });
      break;
    }
  }
  if (!root) throw new Error('No se encontró una carpeta libre para importar el proyecto.');
  for (const [path, content] of relativeFiles) await writeFile(root, path, content);
  const snapshot = await archiveProjectDirectory(root);
  return { ...snapshot, id: crypto.randomUUID() };
}

export async function writePackageFile(handle: ProjectDirectoryHandle, sourceRoot: string, packageId: string, filename: string, content: string): Promise<void> {
  const root = relativeSourceRoot(sourceRoot);
  const relative = [root, packageId.replaceAll('\\', '/'), filename].filter(Boolean).join('/');
  await writeFile(handle, relative, content);
}

export async function readPackageFile(handle: ProjectDirectoryHandle, sourceRoot: string, packageId: string, filename: string): Promise<string> {
  const root = relativeSourceRoot(sourceRoot);
  const relative = [root, packageId.replaceAll('\\', '/'), filename].filter(Boolean).join('/');
  return readFile(handle, relative);
}

export function manifestSourceRoot(handle: ProjectDirectoryHandle): Promise<string> {
  return readManifest(handle).then(manifest => manifest.sourceRoot);
}

export function archiveAsBlob(archive: Uint8Array): Blob {
  return new Blob([archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer], { type: 'application/zip' });
}
