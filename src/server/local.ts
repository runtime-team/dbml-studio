import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { Database } from 'bun:sqlite';
import { parse, stringify } from 'yaml';
import { ProjectBuilder, type BuildResult } from '../project/build';
import { loadProject, type DiagramConfig, type Project } from '../project/loader';
import { revision, saveSource, SaveConflict, readOrEmpty } from '../project/save';
import { applyDiagramPatch, serializeDiagramConfig } from '../project/diagram-config';
import { exportFromBuild, ExportError } from '../project/export';
import { findDefinition } from '../project/definition';
import { StudioError, toDiagnostics } from '../project/diagnostics';
import { readBoundedBody, readBoundedBytes, RequestBodyTooLarge } from './body';
import { createProjectArchive, MAX_PROJECT_ARCHIVE_BYTES, ProjectArchiveError, readProjectArchive } from './project-archive';
import { LocalProjectRegistry } from './project-registry';

const MAX_SOURCE = 1_000_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: HEADERS });

export interface LocalApiOptions { manifest: string; port: number; extraOrigins?: string[]; workspaceRoot?: string; browserProjectsRoot?: string; db?: Database }

const IGNORED_PROJECT_DIRECTORIES = new Set(['.git', '.data', '.impeccable', '.idea', 'node_modules', 'dist', 'out', 'output', 'coverage']);
const projectFolder = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'proyecto';
const isInside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const normalizedPath = (path: string) => {
  const value = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
};

async function projectPlaces(workspaceRoot: string) {
  const home = homedir();
  const candidates = [
    { name: 'Espacio de trabajo', path: workspaceRoot },
    { name: 'Proyectos de DBML Studio', path: join(workspaceRoot, 'projects') },
    { name: 'Carpeta personal', path: home },
    { name: 'Documentos', path: join(home, 'Documents') },
    { name: 'Escritorio', path: join(home, 'Desktop') },
    { name: process.platform === 'win32' ? `Disco ${parsePath(workspaceRoot).root.slice(0, 2)}` : 'Raíz del sistema', path: parsePath(workspaceRoot).root },
  ];
  const seen = new Set<string>();
  const places = [];
  for (const place of candidates) {
    try {
      const path = await realpath(place.path);
      if (!(await lstat(path)).isDirectory()) continue;
      const key = normalizedPath(path);
      if (seen.has(key)) continue;
      seen.add(key);
      places.push({ name: place.name, path });
    } catch { /* Omite ubicaciones que no existen en este equipo. */ }
  }
  return places;
}

async function discoverProjects(workspaceRoot: string) {
  const candidates: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 7 || candidates.length >= 500) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isFile() && (entry.name === 'dbml.project.yaml' || entry.name === 'dbml.project.yml')) candidates.push(join(directory, entry.name));
    }
    for (const entry of entries.filter(item => item.isDirectory() && !item.isSymbolicLink() && !item.name.startsWith('.') && !IGNORED_PROJECT_DIRECTORIES.has(item.name)).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      await visit(join(directory, entry.name), depth + 1);
      if (candidates.length >= 500) return;
    }
  };
  await visit(workspaceRoot, 0);
  const projects = await Promise.all(candidates.map(async manifestPath => {
    try {
      const project = await loadProject(manifestPath);
      return { name: project.manifest.name, manifestPath: resolve(manifestPath), relativePath: relative(workspaceRoot, manifestPath).split(sep).join('/'), packages: project.packages.length };
    } catch { return undefined; }
  }));
  return projects.filter((item): item is NonNullable<typeof item> => !!item).sort((a, b) => a.name.localeCompare(b.name, 'es') || a.relativePath.localeCompare(b.relativePath, 'en'));
}

/**
 * API del modo local: lee y escribe los archivos del proyecto en disco. Solo atiende a la propia máquina
 * (cabecera Host comprobada contra ataques de DNS rebinding) y exige un Origin conocido para escribir.
 */
export function createLocalApi(options: LocalApiOptions) {
  const builder = new ProjectBuilder();
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const browserProjectsRoot = resolve(options.browserProjectsRoot ?? join(workspaceRoot, '.data', 'browser-projects'));
  const origins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${options.port}`, `http://127.0.0.1:${options.port}`, ...(options.extraOrigins ?? [])]);
  const registry = options.db ? new LocalProjectRegistry(options.db) : undefined;
  const browserIdForManifest = (manifestPath: string) => {
    if (!isInside(browserProjectsRoot, manifestPath)) return undefined;
    const id = relative(browserProjectsRoot, manifestPath).split(sep)[0];
    return id && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id) ? id : undefined;
  };

  const rememberProject = async (manifestPath: string, project: Project) => {
    if (registry) registry.remember(await realpath(manifestPath), project.manifest.name);
  };
  const recentProjects = async () => Promise.all((registry?.list() ?? []).map(async item => {
    const browserProjectId = browserIdForManifest(item.manifestPath);
    try {
      const project = await loadProject(item.manifestPath);
      const relativePath = isInside(workspaceRoot, item.manifestPath)
        ? relative(workspaceRoot, item.manifestPath).split(sep).join('/')
        : item.manifestPath;
      return { ...item, name: project.manifest.name, relativePath, packages: project.packages.length, available: true, browserProjectId };
    } catch {
      return { ...item, relativePath: item.manifestPath, packages: 0, available: false, browserProjectId };
    }
  }));

  /** `onDisk` es el proyecto tal como está en disco: las revisiones y contenidos informados nunca son los de una vista previa. */
  const state = async (project: Project, build: BuildResult, onDisk: Project = project, sourceManifest = options.manifest) => {
    const files = onDisk.packages.flatMap(pkg => [...pkg.files].map(([path, content]) => ({ packageId: pkg.id, filename: path.split(/[\\/]/).at(-1)!, content, revision: revision(content) })));
    const configs = Object.fromEntries(await Promise.all(project.packages.map(async pkg => {
      const content = await readOrEmpty(resolve(pkg.path, 'diagram.yaml'));
      return [pkg.id, { revision: revision(content), content }] as const;
    })));
    return {
      name: project.manifest.name, manifestPath: resolve(sourceManifest), ok: build.ok, stale: build.stale, files, configs,
      diagrams: build.diagrams, diagnostics: build.diagnostics, graph: build.graph ?? null, changedPackages: build.changedPackages,
    };
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const host = (request.headers.get('host') ?? '').replace(/:\d+$/, '');
    if (host && !LOCAL_HOSTS.has(host)) return json({ error: 'Host no permitido' }, 403);
    const write = request.method === 'POST';
    if (write && !origins.has(request.headers.get('origin') ?? '')) return json({ error: 'Origen no autorizado' }, 403);
    const selectedManifest = request.headers.get('x-dbml-manifest');
    if (selectedManifest && (selectedManifest.length > 4096 || !isAbsolute(selectedManifest))) return json({ error: 'La ruta del manifiesto debe ser absoluta.' }, 400);
    const manifestPath = selectedManifest ? resolve(selectedManifest) : resolve(options.manifest);
    try {
      const readBody = async () => {
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new StudioError([{ message: 'Tipo de contenido inválido' }]);
        const text = await readBoundedBody(request, MAX_SOURCE + 10_000);
        return JSON.parse(text) as Record<string, unknown>;
      };

      if (url.pathname === '/api/projects/open-browser') {
        if (!write) return json({ error: 'Método no permitido' }, 405);
        const browserProjectId = request.headers.get('x-dbml-browser-project') ?? '';
        if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(browserProjectId))
          return json({ error: 'El identificador del proyecto del navegador no es válido.' }, 400);
        const contentType = request.headers.get('content-type') ?? '';
        if (!contentType.startsWith('application/zip') && !contentType.startsWith('application/octet-stream'))
          return json({ error: 'Selecciona una carpeta DBML con un manifiesto válido.' }, 415);
        const archive = readProjectArchive(await readBoundedBytes(request, MAX_PROJECT_ARCHIVE_BYTES));
        if (archive.manifestName !== 'dbml.project.yaml' && archive.manifestName !== 'dbml.project.yml')
          throw new ProjectArchiveError('El proyecto debe contener dbml.project.yaml o dbml.project.yml en la carpeta seleccionada.');
        const manifestBytes = archive.files.get(archive.manifestName);
        if (!manifestBytes) throw new ProjectArchiveError('No se encontró el manifiesto del proyecto.');
        let manifest: { source?: { root?: unknown } };
        try { manifest = parse(new TextDecoder().decode(manifestBytes)) as typeof manifest; }
        catch { throw new ProjectArchiveError('El manifiesto del proyecto no contiene YAML válido.'); }
        const sourceRoot = manifest?.source?.root ?? '.';
        if (typeof sourceRoot !== 'string' || sourceRoot.includes('\0') || isAbsolute(sourceRoot))
          throw new ProjectArchiveError('El manifiesto debe usar una ruta relativa en source.root.');

        await mkdir(browserProjectsRoot, { recursive: true });
        const target = join(browserProjectsRoot, browserProjectId);
        const staging = join(browserProjectsRoot, `${browserProjectId}.tmp-${randomUUID()}`);
        try {
          await mkdir(staging);
          if (!isInside(staging, resolve(staging, sourceRoot))) throw new ProjectArchiveError('source.root apunta fuera de la carpeta del proyecto.');
          for (const [name, content] of archive.files) {
            const path = resolve(staging, ...name.split('/'));
            if (!isInside(staging, path)) throw new ProjectArchiveError('La carpeta intenta escribir fuera del proyecto.');
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, { flag: 'wx' });
          }
          const stagedManifest = join(staging, archive.manifestName);
          const stagedProject = await loadProject(stagedManifest);
          if (!isInside(await realpath(staging), stagedProject.root)) throw new ProjectArchiveError('La raíz del proyecto debe permanecer dentro de la carpeta seleccionada.');
          await rm(target, { recursive: true, force: true });
          await rename(staging, target);
          const manifestPath = join(target, archive.manifestName);
          const project = await loadProject(manifestPath);
          await rememberProject(manifestPath, project);
          return json({ ...await state(project, builder.build(project), project, manifestPath), browserProjectId });
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
      }

      if (url.pathname === '/api/projects/import') {
        if (!write) return json({ error: 'Método no permitido' }, 405);
        const contentType = request.headers.get('content-type') ?? '';
        if (!contentType.startsWith('application/zip') && !contentType.startsWith('application/octet-stream'))
          return json({ error: 'Selecciona un archivo ZIP de DBML Studio.' }, 415);
        const archive = readProjectArchive(await readBoundedBytes(request, MAX_PROJECT_ARCHIVE_BYTES));
        const manifestBytes = archive.files.get(archive.manifestName);
        if (!manifestBytes) throw new ProjectArchiveError('No se encontró el manifiesto del proyecto dentro del ZIP.');
        let manifest: { name?: unknown; source?: { root?: unknown } };
        try { manifest = parse(new TextDecoder().decode(manifestBytes)) as typeof manifest; }
        catch { throw new ProjectArchiveError('El manifiesto del proyecto no contiene YAML válido.'); }
        const sourceRoot = manifest?.source?.root ?? '.';
        if (typeof sourceRoot !== 'string' || sourceRoot.includes('\0') || isAbsolute(sourceRoot))
          throw new ProjectArchiveError('El manifiesto debe usar una ruta relativa en source.root.');

        const projectsDirectory = join(workspaceRoot, 'projects');
        await mkdir(projectsDirectory, { recursive: true });
        const folder = projectFolder(typeof manifest.name === 'string' ? manifest.name : 'proyecto');
        let target = '';
        for (let suffix = 1; suffix <= 1000; suffix++) {
          const candidate = join(projectsDirectory, suffix === 1 ? folder : `${folder}-${suffix}`);
          try { await mkdir(candidate); target = candidate; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        if (!target) throw new ProjectArchiveError('No se encontró una carpeta libre para importar el proyecto.', 409);

        try {
          if (!isInside(target, resolve(target, sourceRoot))) throw new ProjectArchiveError('source.root apunta fuera de la carpeta del proyecto.');
          for (const [name, content] of archive.files) {
            const path = resolve(target, ...name.split('/'));
            if (!isInside(target, path)) throw new ProjectArchiveError('El ZIP intenta escribir fuera de la carpeta del proyecto.');
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, { flag: 'wx' });
          }
          const manifestPath = join(target, archive.manifestName);
          const project = await loadProject(manifestPath);
          if (!isInside(await realpath(target), project.root)) throw new ProjectArchiveError('La raíz del proyecto debe permanecer dentro de la carpeta importada.');
          await rememberProject(manifestPath, project);
          return json(await state(project, builder.build(project), project, manifestPath), 201);
        } catch (error) {
          await rm(target, { recursive: true, force: true });
          throw error;
        }
      }

      if (url.pathname === '/api/projects/browse') {
        if (request.method !== 'GET') return json({ error: 'Método no permitido' }, 405);
        const requestedPath = url.searchParams.get('path') || workspaceRoot;
        if (requestedPath.length > 4096 || !isAbsolute(requestedPath)) return json({ error: 'La ubicación debe ser una ruta absoluta.' }, 400);
        const currentPath = await realpath(resolve(requestedPath));
        if (!(await lstat(currentPath)).isDirectory()) return json({ error: 'La ubicación seleccionada no es una carpeta.' }, 400);
        const entries = await readdir(currentPath, { withFileTypes: true });
        const rawDirectories = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !IGNORED_PROJECT_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US')))
          .sort((a, b) => a.name.localeCompare(b.name, 'es'));
        const directories = rawDirectories.slice(0, 500).map(entry => ({ name: entry.name, path: join(currentPath, entry.name) }));
        const manifests = entries.filter(entry => entry.isFile() && (entry.name === 'dbml.project.yaml' || entry.name === 'dbml.project.yml')).map(entry => join(currentPath, entry.name));
        const projects = (await Promise.all(manifests.map(async manifestPath => {
          try {
            const project = await loadProject(manifestPath);
            const relativePath = isInside(workspaceRoot, manifestPath) ? relative(workspaceRoot, manifestPath).split(sep).join('/') : manifestPath;
            return { name: project.manifest.name, manifestPath: resolve(manifestPath), relativePath, packages: project.packages.length };
          } catch { return undefined; }
        }))).filter((project): project is NonNullable<typeof project> => !!project);
        const rootPath = parsePath(currentPath).root;
        const parentPath = normalizedPath(currentPath) === normalizedPath(rootPath) ? undefined : dirname(currentPath);
        return json({ currentPath, parentPath, places: await projectPlaces(workspaceRoot), directories, projects, truncated: rawDirectories.length > directories.length });
      }

      if (url.pathname === '/api/projects/recent') {
        if (request.method !== 'GET') return json({ error: 'Método no permitido' }, 405);
        return json({ projects: await recentProjects() });
      }

      if (url.pathname === '/api/projects/recent/remove') {
        if (!write) return json({ error: 'Método no permitido' }, 405);
        const body = await readBody();
        if (typeof body.manifestPath !== 'string' || !body.manifestPath.trim() || body.manifestPath.length > 4096 || !isAbsolute(body.manifestPath))
          return json({ error: 'Indica la ruta absoluta del proyecto reciente.' }, 400);
        const browserProjectId = browserIdForManifest(body.manifestPath);
        registry?.remove(body.manifestPath);
        if (browserProjectId) await rm(join(browserProjectsRoot, browserProjectId), { recursive: true, force: true });
        return json({ projects: await recentProjects() });
      }

      if (url.pathname === '/api/projects') {
        if (request.method !== 'GET') return json({ error: 'MÃ©todo no permitido' }, 405);
        return json({ workspaceRoot, projects: await discoverProjects(workspaceRoot), recentProjects: await recentProjects() });
      }

      // Keep project selection available even when the active manifest cannot be loaded.
      if (url.pathname === '/api/projects/open') {
        if (!write) return json({ error: 'MÃ©todo no permitido' }, 405);
        const body = await readBody();
        if (typeof body.manifestPath !== 'string' || !body.manifestPath.trim() || body.manifestPath.length > 4096 || !isAbsolute(body.manifestPath))
          return json({ error: 'Indica la ruta absoluta a un manifiesto DBML.' }, 400);
        const target = resolve(body.manifestPath);
        const project = await loadProject(target);
        const build = builder.build(project);
        await rememberProject(target, project);
        return json(await state(project, build, project, target));
      }

      if (url.pathname === '/api/projects/create') {
        if (!write) return json({ error: 'MÃ©todo no permitido' }, 405);
        const body = await readBody();
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const directory = typeof body.directory === 'string' ? body.directory.trim() : '';
        const parentDirectory = typeof body.parentDirectory === 'string' ? body.parentDirectory.trim() : '';
        if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) return json({ error: 'El nombre debe tener entre 1 y 80 caracteres.' }, 400);
        if (directory && (directory.length > 4096 || !isAbsolute(directory))) return json({ error: 'La ruta de destino debe ser absoluta.' }, 400);
        if (parentDirectory && (parentDirectory.length > 4096 || !isAbsolute(parentDirectory))) return json({ error: 'La carpeta contenedora debe ser una ruta absoluta.' }, 400);
        if (directory && parentDirectory) return json({ error: 'Indica una carpeta de destino o una carpeta contenedora, no ambas.' }, 400);
        let destinationParent: string | undefined;
        if (parentDirectory) {
          destinationParent = await realpath(resolve(parentDirectory));
          const parentStat = await lstat(destinationParent);
          if (!parentStat.isDirectory()) return json({ error: 'La carpeta contenedora debe ser una carpeta accesible.' }, 400);
        }
        const target = destinationParent ? join(destinationParent, projectFolder(name)) : directory ? resolve(directory) : join(workspaceRoot, 'projects', projectFolder(name));
        if (!basename(target)) return json({ error: 'Elige una carpeta dentro de una ubicaciÃ³n, no la raÃ­z del disco.' }, 400);
        try {
          const existing = await lstat(target);
          if (!existing.isDirectory() || existing.isSymbolicLink()) return json({ error: 'La ubicaciÃ³n elegida no es una carpeta normal.' }, 400);
          if ((await readdir(target)).length) return json({ error: 'La carpeta ya contiene archivos. Elige una carpeta vacÃ­a o una nueva.' }, 409);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await mkdir(dirname(target), { recursive: true });
          await mkdir(target);
        }

        const nextManifest = join(target, 'dbml.project.yaml');
        const packageDirectory = join(target, 'principal');
        await mkdir(packageDirectory);
        await writeFile(nextManifest, stringify({
          name, version: 1,
          source: { root: '.', packages: ['principal'] },
          output: { directory: 'output', formats: ['svg', 'pdf'] },
        }), { flag: 'wx' });
        await writeFile(join(packageDirectory, 'schema.dbml'), 'Table ejemplo {\n  id integer [pk]\n  nombre varchar(120)\n}\n', { flag: 'wx' });
        const project = await loadProject(nextManifest);
        const build = builder.build(project);
        await rememberProject(nextManifest, project);
        return json(await state(project, build, project, nextManifest), 201);
      }

      const project = await loadProject(manifestPath);

      if (url.pathname === '/api/project') {
        if (request.method !== 'GET') return json({ error: 'Método no permitido' }, 405);
        if (!selectedManifest) await rememberProject(manifestPath, project);
        return json(await state(project, builder.build(project), project, manifestPath));
      }

      if (url.pathname === '/api/preview' || url.pathname === '/api/save') {
        if (!write) return json({ error: 'Método no permitido' }, 405);
        const body = await readBody() as { packageId?: unknown; filename?: unknown; content?: unknown; revision?: unknown };
        if (typeof body.content !== 'string' || body.content.length > MAX_SOURCE || typeof body.packageId !== 'string' || typeof body.filename !== 'string') return json({ error: 'Solicitud inválida' }, 400);
        const pkg = project.packages.find(p => p.id === body.packageId);
        const file = [...(pkg?.files.keys() ?? [])].find(path => path.split(/[\\/]/).at(-1) === body.filename);
        if (!pkg || !file) return json({ error: 'Archivo no encontrado' }, 404);
        if (url.pathname === '/api/save') {
          if (typeof body.revision !== 'string') return json({ error: 'Falta la revisión del archivo' }, 400);
          // Se guarda aunque el texto aún no compile: un trabajo a medias no debe perderse. Los errores se devuelven.
          await saveSource(file, body.content, body.revision);
        }
        if (url.pathname === '/api/preview') {
          // La vista previa compila el borrador en memoria; el estado informado sigue siendo el de disco.
          const disk = await loadProject(manifestPath);
          pkg.files.set(file, body.content);
          return json(await state(project, builder.build(project), disk, manifestPath));
        }
        const fresh = await loadProject(manifestPath);
        return json(await state(fresh, builder.build(fresh), fresh, manifestPath));
      }

      if (url.pathname === '/api/diagram') {
        if (!write) return json({ error: 'Método no permitido' }, 405);
        const body = await readBody() as { packageId?: unknown; patch?: unknown; revision?: unknown };
        const pkg = project.packages.find(p => p.id === body.packageId);
        if (!pkg) return json({ error: 'Paquete no encontrado' }, 404);
        if (typeof body.revision !== 'string') return json({ error: 'Falta la revisión de diagram.yaml' }, 400);
        const path = resolve(pkg.path, 'diagram.yaml');
        const next = applyDiagramPatch(pkg.diagram, body.patch, pkg.id);
        // No se escribe una configuración que introduzca errores nuevos en este diagrama.
        const before = new Set(builder.build(project).diagnostics.filter(d => d.severity !== 'warning' && d.packageId === pkg.id).map(d => d.message));
        const added = builder.build(project, { [pkg.id]: next as DiagramConfig }).diagnostics.filter(d => d.severity !== 'warning' && d.packageId === pkg.id && !before.has(d.message));
        if (added.length) return json({ error: `Configuración rechazada: ${added.map(d => d.message).join('; ')}`, diagnostics: added }, 422);
        await saveSource(path, serializeDiagramConfig(next, pkg.id), body.revision);
        const fresh = await loadProject(manifestPath);
        return json(await state(fresh, builder.build(fresh), fresh, manifestPath));
      }

      if (url.pathname === '/api/definition') {
        const build = builder.build(project);
        const definition = build.compiled && findDefinition(project, build.compiled, url.searchParams.get('table') ?? '');
        return definition ? json(definition) : json({ error: 'Definición no encontrada' }, 404);
      }

      if (url.pathname === '/api/project/export') {
        if (request.method !== 'GET') return json({ error: 'Método no permitido' }, 405);
        const manifestDirectory = await realpath(dirname(manifestPath));
        if (!isInside(manifestDirectory, project.root))
          throw new ProjectArchiveError('La raíz source.root está fuera de la carpeta del manifiesto; colócala dentro del proyecto para exportarlo como ZIP.');
        const archive = await createProjectArchive(manifestDirectory);
        const filename = `${projectFolder(project.manifest.name)}.dbml-project.zip`;
        return new Response(archive as BodyInit, { headers: { ...HEADERS, 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${filename}"` } });
      }

      const exported = /^\/api\/export\/([^/]+)$/.exec(url.pathname);
      if (exported && request.method === 'GET') {
        const name = decodeURIComponent(exported[1]!);
        const build = builder.build(project);
        const spec = name === 'schema.sql' ? { format: 'sql' as const, dialect: url.searchParams.get('dialect') ?? project.manifest.options?.sqlDialect }
          : name === 'schema.dbml' ? { format: 'dbml' as const }
          : name === 'all.pdf' ? { format: 'pdf' as const }
          : /^[\w-]{1,80}\.(svg|pdf)$/.test(name) ? { format: name.endsWith('.svg') ? 'svg' as const : 'pdf' as const, packageId: name.replace(/\.(svg|pdf)$/, '') }
          : undefined;
        if (!spec) return json({ error: 'Exportación inexistente' }, 404);
        const file = await exportFromBuild(build, { ...spec, size: url.searchParams.get('size'), orientation: url.searchParams.get('orientation') }, project.manifest.name);
        return new Response(file.body as BodyInit, { headers: { ...HEADERS, 'content-type': file.contentType, 'content-disposition': `attachment; filename="${file.filename}"` } });
      }
      return new Response('No encontrado', { status: 404 });
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) return json({ error: error.message }, 413);
      if (error instanceof SaveConflict) return json({ error: error.message }, 409);
      if (error instanceof ExportError) return json({ error: error.message }, 422);
      if (error instanceof ProjectArchiveError) return json({ error: error.message }, error.status);
      if (error instanceof SyntaxError) return json({ error: 'JSON inválido' }, 400);
      return json({ error: error instanceof Error ? error.message : String(error), diagnostics: toDiagnostics(error) }, 400);
    }
  };
}
