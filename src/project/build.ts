import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { compileProject, type CompiledProject } from './compiler';
import { compileDiagramSet, type Diagram } from '../diagram/model';
import { buildDependencyGraph, type DependencyGraph } from './dependencies';
import { toDiagnostics, type Diagnostic, type PackageId } from './diagnostics';
import type { DiagramConfig, Project } from './loader';

export interface BuildResult {
  /** `false` si las fuentes no compilan; entonces `diagrams` conserva la última versión válida (`stale`). */
  ok: boolean;
  stale: boolean;
  diagrams: Diagram[];
  diagnostics: Diagnostic[];
  graph?: DependencyGraph;
  compiled?: CompiledProject;
  /** Paquetes cuyo diagrama cambió respecto a la compilación anterior (actualización selectiva). */
  changedPackages: PackageId[];
  sourceKey: string;
}

const digest = (parts: string[]) => { const hash = createHash('sha1'); for (const part of parts) { hash.update(part); hash.update('\u0000'); } return hash.digest('hex'); };

/** Clave de contenido de las fuentes DBML (no incluye la configuración visual). */
export function sourceKey(project: Project): string {
  return digest([project.manifest.name, ...[...project.packages].sort((a, b) => a.id.localeCompare(b.id, 'en')).flatMap(pkg =>
    [...pkg.files].map(([file, content]) => `${pkg.id}:${relative(project.root, file).split(sep).join('/')}:${content}`).sort())]);
}
const configKey = (project: Project, overrides: Record<string, DiagramConfig | undefined>) =>
  digest(project.packages.map(pkg => JSON.stringify([pkg.id, overrides[pkg.id] ?? pkg.diagram ?? null])));

/**
 * Compilación con caché. El análisis del parser (lo costoso) se reutiliza mientras no cambien las fuentes;
 * cambiar solo posiciones o vistas externas reconstruye únicamente los diagramas. Si las fuentes dejan de
 * compilar se conserva la última versión válida y se informan los errores.
 */
export class ProjectBuilder {
  stats = { compiles: 0, diagramBuilds: 0 };
  private compiled?: { key: string; value: CompiledProject };
  private last?: { key: string; result: BuildResult };
  private lastValid?: BuildResult;

  build(project: Project, overrides: Record<PackageId, DiagramConfig | undefined> = {}): BuildResult {
    const sKey = sourceKey(project), full = `${sKey}:${configKey(project, overrides)}`;
    if (this.last?.key === full) return this.last.result;
    let compiled: CompiledProject;
    try {
      if (this.compiled?.key === sKey) compiled = this.compiled.value;
      else { this.stats.compiles++; compiled = compileProject(project); this.compiled = { key: sKey, value: compiled }; }
    } catch (error) {
      const diagnostics = toDiagnostics(error);
      // Un error de compilación no tira abajo la vista: se muestran los últimos diagramas válidos.
      const result: BuildResult = { ok: false, stale: !!this.lastValid, diagrams: this.lastValid?.diagrams ?? [], diagnostics: [...diagnostics, ...(this.lastValid?.diagnostics.filter(d => d.severity === 'warning') ?? [])], graph: this.lastValid?.graph, changedPackages: [], sourceKey: sKey };
      this.last = { key: full, result };
      return result;
    }
    this.stats.diagramBuilds++;
    const { diagrams, diagnostics: diagramDiagnostics } = compileDiagramSet(project, compiled, overrides);
    const graph = buildDependencyGraph(compiled, diagrams, project.packages.map(p => p.id));
    const previous = new Map((this.lastValid?.diagrams ?? []).map(d => [d.packageId, d.hash] as const));
    const changedPackages = diagrams.filter(d => previous.get(d.packageId) !== d.hash).map(d => d.packageId);
    const result: BuildResult = { ok: true, stale: false, diagrams, diagnostics: [...compiled.warnings, ...diagramDiagnostics], graph, compiled, changedPackages, sourceKey: sKey };
    this.last = { key: full, result }; this.lastValid = result;
    return result;
  }
}
