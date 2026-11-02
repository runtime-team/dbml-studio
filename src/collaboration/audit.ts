import { randomUUID } from 'node:crypto';
import type { AccessStore } from './access';
import { AccessDenied } from './errors';
import type { LibsqlDatabase } from './database';

export interface AuditEntry { id: string; projectId: string | null; actorId: string | null; action: string; target: string | null; detail: unknown; at: number }

/** Registro append-only de acciones administrativas y eventos de seguridad. No hay API de borrado ni edición. */
export class AuditLog {
  constructor(private db: LibsqlDatabase, private access: AccessStore, private now: () => number = Date.now) {}
  async record(projectId: string | null, actorId: string | undefined, action: string, target?: string, detail?: unknown): Promise<void> {
    const text = detail === undefined ? null : JSON.stringify(detail).slice(0, 2000);
    await this.db.query('INSERT INTO audit_log (id, project_id, actor_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, actorId ?? null, action, target?.slice(0, 500) ?? null, text, this.now());
  }
  /** Solo los administradores del proyecto pueden consultar su registro. */
  async list(projectId: string, actorId: string | undefined, limit = 200): Promise<AuditEntry[]> {
    if (!await this.access.can(projectId, actorId, 'admin')) throw new AccessDenied();
    const rows = await this.db.query('SELECT id, project_id AS projectId, actor_id AS actorId, action, target, detail, at FROM audit_log WHERE project_id=? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(projectId, Math.max(1, Math.min(limit, 1000))) as (Omit<AuditEntry, 'detail'> & { detail: string | null })[];
    return rows.map(row => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
  }
}
