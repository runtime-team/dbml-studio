import { resolve, relative, isAbsolute, sep } from 'node:path';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { parse } from 'yaml';
import { Codes, StudioError, type NodeId, type PackageId } from './diagnostics';

export const SQL_DIALECTS = ['postgres', 'mysql', 'mssql', 'oracle'] as const;
export const OUTPUT_FORMATS = ['svg', 'pdf'] as const;

export interface ProjectManifest {
  name: string;
  version: number;
  source: {
    root?: string;
    /** Lista explícita. Si se omite, los paquetes se descubren: cada subdirectorio directo con archivos `.dbml`. */
    packages?: string[];
    /** Patrones (`*` como comodín) de directorios o archivos que nunca forman parte del proyecto. */
    exclude?: string[];
  };
  output?: { directory?: string; formats?: string[] };
  /** Opciones de compilación. */
  options?: { sqlDialect?: (typeof SQL_DIALECTS)[number] };
}
export interface ExternalView { table: string; display: 'full' | 'compact' | 'connector'; show?: string[]; id?: string; label?: string; relationship?: string }
export interface NodePosition { x: number; y: number }
export interface DiagramConfig {
  package?: string;
  external?: ExternalView[];
  /** Posiciones persistidas por identificador de nodo. Los nodos sin entrada se colocan automáticamente. */
  layout?: Record<NodeId, NodePosition>;
}
export interface SourcePackage { id: PackageId; path: string; files: Map<string, string>; diagram?: DiagramConfig }
export interface Project { root: string; manifest: ProjectManifest; packages: SourcePackage[] }

/** Directorios que nunca se descubren como paquetes. */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'docs', 'output', 'dist', 'out', 'coverage']);

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** `*` coincide con cualquier secuencia de caracteres (sin separadores). */
export function matchesPattern(pattern: string, name: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*')}$`);
  return regex.test(name);
}

const invalid = (message: string, code: string = Codes.manifest, filepath?: string) => new StudioError([{ code, severity: 'error', message, filepath }]);

/** Valida y normaliza un `diagram.yaml`; lanza `StudioError` con el archivo afectado. */
export function parseDiagramConfig(raw: unknown, packageId: string, filepath = `${packageId}/diagram.yaml`): DiagramConfig {
  const fail = (message: string, suggestion?: string, code: string = Codes.diagramConfig) => new StudioError([{ code, severity: 'error', message, filepath, packageId, suggestion }]);
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fail('El archivo debe contener un objeto YAML.');
  const config = raw as DiagramConfig;
  if (config.package !== undefined && config.package !== packageId) throw fail(`El campo package (${String(config.package)}) no coincide con el paquete ${packageId}.`, `Usa \`package: ${packageId}\` o elimina el campo.`);
  if (config.external !== undefined && !Array.isArray(config.external)) throw fail('El campo external debe ser una lista.');
  if (config.layout !== undefined) {
    if (typeof config.layout !== 'object' || config.layout === null || Array.isArray(config.layout)) throw fail('El campo layout debe ser un mapa de nodos a posiciones.', undefined, Codes.layoutInvalid);
    for (const [id, position] of Object.entries(config.layout)) {
      const p = position as Partial<NodePosition> | null;
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 1e6 || p.y > 1e6)
        throw fail(`Posición inválida para el nodo ${id}: x e y deben ser números finitos entre 0 y 1000000.`, undefined, Codes.layoutInvalid);
    }
  }
  return config;
}

/** Load explicit package directories; generated output and nested directories are never scanned. */
export async function loadProject(manifestPath: string): Promise<Project> {
  const absoluteManifest = resolve(manifestPath);
  const rawManifest = (await readFile(absoluteManifest, 'utf8')).replace(/^﻿/, '');
  let manifest: ProjectManifest;
  try { manifest = parse(rawManifest) as ProjectManifest; }
  catch (error) { throw invalid(`El manifiesto no es YAML válido: ${error instanceof Error ? error.message : String(error)}`, Codes.manifest, 'dbml.project.yaml'); }
  if (!manifest || typeof manifest.name !== 'string' || manifest.version !== 1 || !manifest.source || typeof manifest.source !== 'object'
    || (manifest.source.packages !== undefined && !Array.isArray(manifest.source.packages))) {
    throw invalid('Manifiesto inválido: se requiere name, version: 1 y source (con packages opcional).');
  }
  const exclude = manifest.source.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some(p => typeof p !== 'string' || !p)) throw invalid('source.exclude debe ser una lista de patrones.');
  const formats = manifest.output?.formats;
  if (formats !== undefined && (!Array.isArray(formats) || formats.some(f => !(OUTPUT_FORMATS as readonly string[]).includes(f)))) throw invalid(`output.formats solo admite: ${OUTPUT_FORMATS.join(', ')}.`);
  const dialect = manifest.options?.sqlDialect;
  if (dialect !== undefined && !(SQL_DIALECTS as readonly string[]).includes(dialect)) throw invalid(`options.sqlDialect solo admite: ${SQL_DIALECTS.join(', ')}.`);

  const manifestDir = await realpath(resolve(absoluteManifest, '..'));
  const root = await realpath(resolve(manifestDir, manifest.source.root ?? '.'));
  const output = resolve(manifestDir, manifest.output?.directory ?? 'output');

  let ids = manifest.source.packages;
  if (!ids) {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRECTORIES.has(e.name) && !exclude.some(p => matchesPattern(p, e.name)) && !inside(output, resolve(root, e.name)) && resolve(root, e.name) !== output);
    ids = [];
    for (const entry of candidates.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const files = await readdir(resolve(root, entry.name));
      if (files.some(name => name.endsWith('.dbml'))) ids.push(entry.name);
    }
    if (!ids.length) throw invalid('No se encontraron paquetes: crea subdirectorios con archivos .dbml o define source.packages.');
  }

  const seen = new Set<string>();
  const packages: SourcePackage[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) throw invalid(`Paquete duplicado o inválido: ${id}`, Codes.packageDuplicate);
    seen.add(id);
    const path = resolve(root, id);
    if (!inside(root, path) || inside(output, path)) throw invalid(`Ruta de paquete inválida: ${id}`);
    const resolvedPackagePath = await realpath(path);
    if (!inside(root, resolvedPackagePath) || !(await stat(resolvedPackagePath)).isDirectory()) throw invalid(`Ruta de paquete fuera de la raíz: ${id}`);
    const entries = await readdir(resolvedPackagePath, { withFileTypes: true });
    const files = new Map<string, string>();
    for (const entry of entries.filter(e => e.isFile() && e.name.endsWith('.dbml') && !exclude.some(p => matchesPattern(p, e.name))).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = resolve(resolvedPackagePath, entry.name);
      files.set(file, (await readFile(file, 'utf8')).replace(/^﻿/, ''));
    }
    if (!files.size) throw invalid(`El paquete ${id} no contiene archivos DBML.`, Codes.packageEmpty);
    const diagramEntry = entries.find(e => e.isFile() && e.name === 'diagram.yaml');
    let diagram: DiagramConfig | undefined;
    if (diagramEntry) {
      let raw: unknown;
      try { raw = parse(await readFile(resolve(resolvedPackagePath, diagramEntry.name), 'utf8')); }
      catch (error) { throw new StudioError([{ code: Codes.diagramConfig, severity: 'error', packageId: id, filepath: `${id}/diagram.yaml`, message: `YAML inválido: ${error instanceof Error ? error.message : String(error)}` }]); }
      diagram = parseDiagramConfig(raw, id);
    }
    packages.push({ id, path: resolvedPackagePath, files, diagram });
  }
  if (new Set(packages.map(p => p.path.toLocaleLowerCase())).size !== packages.length) throw invalid('Hay rutas de paquete duplicadas.', Codes.packageDuplicate);
  return { root, manifest, packages };
}
