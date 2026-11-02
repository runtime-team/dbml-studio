import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';

export const MAX_PROJECT_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_PROJECT_CONTENT_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 10_000;
const OMITTED_DIRECTORIES = new Set(['.git', '.data', '.cache', 'node_modules', 'dist', 'out', 'coverage']);
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class ProjectArchiveError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'ProjectArchiveError'; }
}

export async function createProjectArchive(rootPath: string): Promise<Uint8Array> {
  const root = resolve(rootPath);
  const contents: Zippable = Object.create(null) as Zippable;
  let total = 0;
  let count = 0;

  const collect = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!OMITTED_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))) await collect(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(path);
      total += bytes.byteLength;
      if (++count > MAX_ARCHIVE_FILES || bytes.byteLength > MAX_ARCHIVE_FILE_BYTES || total > MAX_PROJECT_CONTENT_BYTES)
        throw new ProjectArchiveError('El proyecto supera los límites de tamaño para crear un ZIP.', 413);
      contents[relative(root, path).split(sep).join('/')] = bytes;
    }
  };

  await collect(root);
  if (!count) throw new ProjectArchiveError('El proyecto no contiene archivos para exportar.');
  // fflate serializa mtime como fecha local DOS; medianoche UTC cae en 1979
  // en zonas horarias al oeste de UTC y queda fuera del rango ZIP permitido.
  const archive = zipSync(contents, { level: 1, mtime: new Date(1980, 0, 1) });
  if (archive.byteLength > MAX_PROJECT_ARCHIVE_BYTES) throw new ProjectArchiveError('El ZIP supera el límite de descarga de 100 MiB.', 413);
  return archive;
}

function validateArchivePath(name: string): string | undefined {
  if (!name || name.length > 4096 || name.includes('\0')) throw new ProjectArchiveError('El ZIP contiene una ruta inválida.');
  const path = name.replaceAll('\\', '/');
  const directoryEntry = path.endsWith('/');
  const normalized = directoryEntry ? path.slice(0, -1) : path;
  if (!normalized) return undefined;
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new ProjectArchiveError('El ZIP contiene una ruta absoluta.');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED_NAME.test(part) || part === '__proto__'))
    throw new ProjectArchiveError('El ZIP contiene una ruta no permitida.');
  return directoryEntry ? undefined : parts.join('/');
}

export function readProjectArchive(bytes: Uint8Array): { manifestName: string; files: Map<string, Uint8Array> } {
  let total = 0;
  let count = 0;
  let limitError = '';
  let limitStatus = 400;
  const filterSeen = new Set<string>();
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes, { filter: entry => {
      count++;
      if (count > MAX_ARCHIVE_FILES) { limitError = 'El ZIP contiene demasiados archivos.'; limitStatus = 413; return false; }
      try {
        const path = validateArchivePath(entry.name);
        if (path) {
          const folded = path.toLocaleLowerCase('en-US');
          if (filterSeen.has(folded)) { limitError = `El ZIP repite la ruta ${path}.`; return false; }
          filterSeen.add(folded);
        }
      }
      catch (error) { limitError = error instanceof Error ? error.message : 'El ZIP contiene una ruta inválida.'; return false; }
      if (entry.originalSize > MAX_ARCHIVE_FILE_BYTES || total + entry.originalSize > MAX_PROJECT_CONTENT_BYTES) {
        limitError = 'El contenido descomprimido supera el límite permitido (512 MiB).';
        limitStatus = 413;
        return false;
      }
      total += entry.originalSize;
      return true;
    } });
  } catch (error) {
    throw new ProjectArchiveError(`No se pudo leer el ZIP: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (limitError) throw new ProjectArchiveError(limitError, limitStatus);

  const entries = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  for (const [rawName, content] of Object.entries(extracted)) {
    const name = validateArchivePath(rawName);
    if (!name) continue;
    const folded = name.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new ProjectArchiveError(`El ZIP repite la ruta ${name} con diferencias de mayúsculas.`);
    seen.add(folded);
    entries.set(name, content);
  }

  const manifests = [...entries.keys()].filter(name => /(^|\/)dbml\.project\.ya?ml$/i.test(name));
  if (manifests.length !== 1) throw new ProjectArchiveError('El ZIP debe contener exactamente un manifiesto dbml.project.yaml o dbml.project.yml.');
  const manifestPath = manifests[0]!;
  const prefix = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : '';
  if (prefix && [...entries.keys()].some(name => !name.startsWith(prefix)))
    throw new ProjectArchiveError('Los archivos del ZIP deben estar dentro de la carpeta del manifiesto.');

  const files = new Map<string, Uint8Array>();
  for (const [name, content] of entries) {
    const relativeName = prefix ? name.slice(prefix.length) : name;
    if (!relativeName) continue;
    files.set(relativeName, content);
  }
  return { manifestName: manifestPath.slice(prefix.length), files };
}
