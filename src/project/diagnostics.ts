/** Identificadores lógicos diferenciados. Son alias de cadena: nunca derivan de posiciones ni de números de página. */
export type ProjectId = string;
export type PackageId = string;
/** `esquema.tabla`, p. ej. `public.paises`. */
export type TableId = string;
/** `esquema.tabla.columna`. */
export type ColumnId = string;
export type RelationshipId = string;
export type DiagramId = string;
export type NodeId = string;
export type ConnectorId = string;

export type Severity = 'error' | 'warning';

/** Diagnóstico estructurado: archivo, posición, código, descripción y sugerencia. */
export interface Diagnostic {
  message: string;
  severity?: Severity;
  /** Ruta tal como la conoce el compilador (relativa a la raíz del proyecto, con `/` inicial) o el archivo de configuración. */
  filepath?: string;
  code?: number | string;
  location?: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } };
  suggestion?: string;
  packageId?: PackageId;
}

export class StudioError extends Error {
  constructor(readonly diagnostics: Diagnostic[], name = 'StudioError') {
    super(diagnostics.map(formatDiagnostic).join('\n'));
    this.name = name;
  }
}
export class ProjectCompileError extends StudioError {
  constructor(diagnostics: Diagnostic[]) { super(diagnostics, 'ProjectCompileError'); }
}

export function formatDiagnostic(d: Diagnostic): string {
  const place = `${d.filepath ?? 'proyecto'}:${d.location?.start?.line ?? '?'}:${d.location?.start?.column ?? '?'}`;
  return `${place} [${d.code ?? 'DBML'}] ${d.message}${d.suggestion ? ` Sugerencia: ${d.suggestion}` : ''}`;
}

/** Códigos propios de DBML Studio. Los códigos numéricos pertenecen al compilador oficial. */
export const Codes = {
  duplicateTable: 'STU001',
  ambiguousName: 'STU002',
  missingImport: 'STU003',
  importCycle: 'STU004',
  externalInvalid: 'STU010',
  externalMissingTable: 'STU011',
  externalLocalTable: 'STU012',
  externalColumn: 'STU013',
  compactColumns: 'STU014',
  connectorRelation: 'STU015',
  connectorNoRelation: 'STU016',
  layoutInvalid: 'STU017',
  diagramConfig: 'STU018',
  manifest: 'STU020',
  packageDuplicate: 'STU021',
  packageEmpty: 'STU022',
} as const;

/** Convierte un `Error` genérico en diagnóstico; los errores estructurados conservan su contenido. */
export function toDiagnostics(error: unknown): Diagnostic[] {
  if (error instanceof StudioError) return error.diagnostics;
  if (error && typeof error === 'object' && 'diags' in error && Array.isArray((error as { diags: unknown }).diags)) return (error as { diags: Diagnostic[] }).diags;
  return [{ message: error instanceof Error ? error.message : String(error), severity: 'error' }];
}
