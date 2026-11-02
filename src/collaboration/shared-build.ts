import { resolve } from 'node:path';
import type { AccessStore } from './access';
import type { DiagramStore } from './diagram-state';
import { PACKAGE_ID, FILE_NAME, type Principal, type SharedDocuments } from './documents';
import { BadRequest } from './errors';
import { ProjectBuilder, type BuildResult } from '../project/build';
import type { DiagramConfig, Project, SourcePackage } from '../project/loader';

const MAX_BUILDERS = 32;

/**
 * Construye el proyecto compartido a partir de los documentos persistidos y la configuración visual
 * compartida. Hay un único `ProjectBuilder` por proyecto: no existe copia del esquema por usuario, y si
 * un error de sintaxis impide compilar se conserva la última versión válida.
 */
export class SharedBuilds {
  private builders = new Map<string, ProjectBuilder>();
  private root = resolve('.dbml-virtual-root');
  constructor(private access: AccessStore, private documents: SharedDocuments, private diagrams: DiagramStore) {}

  builder(projectId: string): ProjectBuilder {
    let builder = this.builders.get(projectId);
    if (builder) { this.builders.delete(projectId); this.builders.set(projectId, builder); return builder; }
    builder = new ProjectBuilder();
    this.builders.set(projectId, builder);
    if (this.builders.size > MAX_BUILDERS) this.builders.delete(this.builders.keys().next().value!);
    return builder;
  }

  async project(projectId: string, principal: Principal): Promise<Project> {
    const files = await this.documents.files(projectId, principal);
    const packages = new Map<string, SourcePackage>();
    for (const file of files) {
      if (!PACKAGE_ID.test(file.packageId) || !FILE_NAME.test(file.name)) throw new BadRequest('Ruta de documento inválida');
      let pkg = packages.get(file.packageId);
      if (!pkg) { pkg = { id: file.packageId, path: resolve(this.root, file.packageId), files: new Map() }; packages.set(file.packageId, pkg); }
      pkg.files.set(resolve(pkg.path, file.name), file.content);
    }
    const name = (await this.access.getProject(projectId))?.name ?? projectId;
    return { root: this.root, manifest: { name, version: 1, source: { packages: [...packages.keys()] } }, packages: [...packages.values()] };
  }

  /** Configuración visual compartida por paquete (sin el contador de versión). */
  async overrides(projectId: string): Promise<Record<string, DiagramConfig>> {
    return Object.fromEntries(Object.entries(await this.diagrams.read(projectId)).map(([pkg, { version: _version, ...config }]) => [pkg, config]));
  }

  async build(projectId: string, principal: Principal, overrides?: Record<string, DiagramConfig | undefined>): Promise<BuildResult & { project: Project }> {
    const [project, effectiveOverrides] = await Promise.all([this.project(projectId, principal), overrides ? Promise.resolve(overrides) : this.overrides(projectId)]);
    return { ...this.builder(projectId).build(project, effectiveOverrides), project };
  }
}
