import { AccessStore } from './access';
import { AccessDenied, BadRequest } from './errors';
import { ProjectEvents } from './events';
import { PACKAGE_ID, type Principal } from './documents';
import { applyDiagramPatch, serializeDiagramConfig } from '../project/diagram-config';
import type { DiagramConfig } from '../project/loader';
import type { LibsqlDatabase } from './database';

const MAX_CONFIG_BYTES = 1_000_000;

/**
 * Estado compartido de los diagramas (posiciones, modos Full/Compact/Connector, conectores): se persiste
 * y lo ven todos. Zoom, pestaña activa, selección y paneles abiertos son estado personal y nunca llegan aquí.
 * Cada parche se fusiona en el servidor, por lo que dos personas moviendo tablas distintas no se pisan.
 */
export class DiagramStore {
  constructor(private db: LibsqlDatabase, private access: AccessStore, private events?: ProjectEvents, private now: () => number = Date.now) {}
  /** Configuraciones de todos los paquetes con sus versiones. */
  async all(projectId: string, principal: Principal): Promise<Record<string, DiagramConfig & { version: number }>> {
    if (!await this.access.can(projectId, principal.userId, 'read', principal.linkToken)) throw new AccessDenied();
    return this.read(projectId);
  }
  /** Lectura interna sin comprobar permisos; el llamador ya autorizó la operación. */
  async read(projectId: string): Promise<Record<string, DiagramConfig & { version: number }>> {
    const rows = await this.db.query('SELECT package_id AS packageId, config, version FROM diagram_configs WHERE project_id=?').all(projectId) as { packageId: string; config: string; version: number }[];
    return Object.fromEntries(rows.map(r => [r.packageId, { ...(JSON.parse(r.config) as DiagramConfig), version: r.version }]));
  }
  /** Aplica un parche validado. `check` puede rechazar la configuración resultante antes de guardarla. */
  async patch(projectId: string, principal: Principal, packageId: string, patch: unknown, check?: (config: DiagramConfig) => void | Promise<void>): Promise<{ version: number; config: DiagramConfig }> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    if (!PACKAGE_ID.test(packageId)) throw new BadRequest('Paquete inválido');
    return this.db.transaction(async () => {
      const row = await this.db.query('SELECT config, version FROM diagram_configs WHERE project_id=? AND package_id=?').get(projectId, packageId) as { config: string; version: number } | null;
      const next = applyDiagramPatch(row ? JSON.parse(row.config) as DiagramConfig : undefined, patch, packageId);
      await check?.(next);
      return this.write(projectId, packageId, next, principal.userId, (row?.version ?? 0) + 1, row !== null);
    })();
  }
  /** Reemplaza la configuración completa (restauración de versiones). */
  async replace(projectId: string, principal: Principal, packageId: string, config: DiagramConfig | undefined): Promise<void> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    const row = await this.db.query('SELECT version FROM diagram_configs WHERE project_id=? AND package_id=?').get(projectId, packageId) as { version: number } | null;
    if (!config && !row) return;
    await this.write(projectId, packageId, config ?? {}, principal.userId, (row?.version ?? 0) + 1, row !== null);
  }
  private async write(projectId: string, packageId: string, config: DiagramConfig, userId: string | undefined, version: number, exists: boolean) {
    const clean: DiagramConfig = { ...(config.external?.length ? { external: config.external } : {}), ...(config.layout && Object.keys(config.layout).length ? { layout: config.layout } : {}) };
    const text = JSON.stringify(clean);
    if (text.length > MAX_CONFIG_BYTES) throw new BadRequest('La configuración del diagrama es demasiado grande');
    if (exists) await this.db.query('UPDATE diagram_configs SET config=?, version=?, updated_by=?, updated_at=? WHERE project_id=? AND package_id=?').run(text, version, userId ?? null, this.now(), projectId, packageId);
    else await this.db.query('INSERT INTO diagram_configs (project_id, package_id, config, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, packageId, text, version, userId ?? null, this.now());
    this.events?.emit(projectId, { type: 'diagram-changed', packageId, version });
    return { version, config: clean };
  }
  /** YAML equivalente, útil para exportar la configuración compartida a un proyecto local. */
  async toYaml(projectId: string, packageId: string): Promise<string> {
    return serializeDiagramConfig((await this.read(projectId))[packageId] ?? {}, packageId);
  }
}
