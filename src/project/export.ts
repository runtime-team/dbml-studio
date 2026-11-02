import type { BuildResult } from './build';
import { renderSvg } from '../diagram/svg';
import { renderPdf, type PdfOptions } from '../diagram/pdf';
import type { SqlDialect } from './compiler';
import { SQL_DIALECTS } from './loader';

export interface ExportSpec { format: 'svg' | 'pdf' | 'sql' | 'dbml'; packageId?: string; size?: string | null; orientation?: string | null; dialect?: string | null }
export interface ExportedFile { body: Uint8Array | string; contentType: string; filename: string }
export class ExportError extends Error {}

/** Exportación común a la CLI, al servidor local y a la API compartida. SQL se genera solo del esquema lógico global. */
export async function exportFromBuild(build: BuildResult, spec: ExportSpec, projectName = 'proyecto'): Promise<ExportedFile> {
  if (!build.ok || !build.compiled) throw new ExportError('El proyecto tiene errores de compilación; corrígelos antes de exportar.');
  const safe = (name: string) => name.replace(/[^\w.-]+/g, '_');
  if (spec.format === 'dbml') return { body: build.compiled.exportDbml(), contentType: 'text/plain; charset=utf-8', filename: `${safe(projectName)}.dbml` };
  if (spec.format === 'sql') {
    const dialect = (spec.dialect ?? 'postgres') as SqlDialect;
    if (!(SQL_DIALECTS as readonly string[]).includes(dialect)) throw new ExportError(`Dialecto SQL desconocido: ${spec.dialect}`);
    return { body: build.compiled.exportSql(dialect), contentType: 'application/sql; charset=utf-8', filename: `${safe(projectName)}.sql` };
  }
  const diagrams = spec.packageId ? build.diagrams.filter(d => d.packageId === spec.packageId) : build.diagrams;
  if (!diagrams.length) throw new ExportError(spec.packageId ? `El paquete ${spec.packageId} no existe.` : 'No hay diagramas para exportar.');
  const name = spec.packageId ? safe(spec.packageId) : safe(projectName);
  if (spec.format === 'svg') {
    if (!spec.packageId) throw new ExportError('El SVG se exporta por paquete.');
    return { body: renderSvg(diagrams[0]!), contentType: 'image/svg+xml; charset=utf-8', filename: `${name}.svg` };
  }
  if (spec.format !== 'pdf') throw new ExportError(`Formato desconocido: ${spec.format}`);
  const size = spec.size === 'A3' ? 'A3' : spec.size && spec.size !== 'A4' ? undefined : 'A4';
  const orientation = spec.orientation === 'portrait' ? 'portrait' : spec.orientation && spec.orientation !== 'landscape' ? undefined : 'landscape';
  if (!size) throw new ExportError('Tamaño de página no admitido (A4 o A3).');
  if (!orientation) throw new ExportError('Orientación no admitida (landscape o portrait).');
  const options: PdfOptions = { size, orientation };
  return { body: await renderPdf(diagrams, options), contentType: 'application/pdf', filename: `${name}.pdf` };
}
