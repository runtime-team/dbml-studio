import { randomUUID } from 'node:crypto';
import type { AccessStore } from './access';
import { AccessDenied, BadRequest, NotFound } from './errors';
import type { ProjectEvents } from './events';
import type { Principal } from './documents';
import type { SessionStore } from './sessions';
import type { LibsqlDatabase } from './database';

export const TARGET_TYPES = ['project', 'package', 'table', 'column', 'relationship', 'connector'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];
export const COMMENT_LIMITS = { body: 4000, target: 2000, perProject: 5000 } as const;

export interface CommentView { id: string; authorId: string | null; authorName: string | null; body: string; createdAt: number; editedAt: number | null }
export interface ThreadView {
  id: string; targetType: TargetType; targetId: string; packageId: string | null;
  resolved: boolean; resolvedBy: string | null; resolvedAt: number | null; createdAt: number;
  comments: CommentView[];
}
export interface CommentFilter { targetType?: TargetType; targetId?: string; packageId?: string; status?: 'open' | 'resolved' | 'all' }

interface Row { id: string; thread_id: string; parent_id: string | null; target_type: TargetType; target_id: string; package_id: string | null; author_id: string | null; body: string; created_at: number; edited_at: number | null; resolved: number; resolved_by: string | null; resolved_at: number | null }

/**
 * Discusiones asociadas a entidades lógicas mediante identificadores estables (tabla, columna, relación,
 * conector, paquete o proyecto), nunca a posiciones del diagrama; por eso sobreviven a cambios de layout.
 * Los comentarios son metadatos: no participan en el esquema ni en la generación SQL.
 */
export class CommentStore {
  constructor(private db: LibsqlDatabase, private access: AccessStore, private events?: ProjectEvents, private sessions?: SessionStore, private now: () => number = Date.now) {}

  private cleanBody(body: unknown): string {
    if (typeof body !== 'string') throw new BadRequest('El comentario debe ser texto');
    const text = body.trim();
    if (!text) throw new BadRequest('El comentario no puede estar vacío');
    if (text.length > COMMENT_LIMITS.body) throw new BadRequest(`El comentario excede ${COMMENT_LIMITS.body} caracteres`);
    return text;
  }
  private async row(projectId: string, id: string): Promise<Row> {
    const row = await this.db.query('SELECT * FROM comments WHERE id=? AND project_id=? AND deleted=0').get(id, projectId) as Row | null;
    if (!row) throw new NotFound('Comentario inexistente');
    return row;
  }

  /** Crea una discusión (con `targetType`/`targetId`) o responde a una existente (con `parentId`, hereda el objetivo). */
  async create(projectId: string, principal: Principal, input: { targetType?: unknown; targetId?: unknown; packageId?: unknown; body: unknown; parentId?: unknown }): Promise<ThreadView> {
    if (!await this.access.can(projectId, principal.userId, 'comment', principal.linkToken)) throw new AccessDenied();
    const total = (await this.db.query('SELECT COUNT(*) AS n FROM comments WHERE project_id=? AND deleted=0').get(projectId) as { n: number }).n;
    if (total >= COMMENT_LIMITS.perProject) throw new BadRequest('El proyecto alcanzó el máximo de comentarios');
    const body = this.cleanBody(input.body);
    const id = randomUUID(), at = this.now();
    // Los enlaces de solo lectura no otorgan permiso para comentar; un autor siempre es una cuenta.
    if (!principal.userId) throw new AccessDenied('Inicia sesión para comentar');
    let threadId: string = id;
    let target: { type: TargetType; id: string; packageId: string | null };
    if (input.parentId !== undefined && input.parentId !== null) {
      if (typeof input.parentId !== 'string') throw new BadRequest('parentId inválido');
      const parent = await this.row(projectId, input.parentId);
      threadId = parent.thread_id;
      target = { type: parent.target_type, id: parent.target_id, packageId: parent.package_id };
      // Responder reabre una discusión resuelta.
      await this.db.query('UPDATE comments SET resolved=0, resolved_by=NULL, resolved_at=NULL WHERE id=? AND project_id=?').run(threadId, projectId);
    } else {
      if (typeof input.targetType !== 'string' || !(TARGET_TYPES as readonly string[]).includes(input.targetType)) throw new BadRequest(`targetType debe ser uno de: ${TARGET_TYPES.join(', ')}`);
      if (typeof input.targetId !== 'string' || !input.targetId || input.targetId.length > COMMENT_LIMITS.target) throw new BadRequest('targetId inválido');
      if (input.packageId != null && (typeof input.packageId !== 'string' || input.packageId.length > 80)) throw new BadRequest('packageId inválido');
      // Los comentarios de proyecto se anclan al proyecto, no a un identificador libre.
      target = { type: input.targetType as TargetType, id: input.targetType === 'project' ? projectId : input.targetId, packageId: (input.packageId as string | undefined) ?? null };
    }
    await this.db.query('INSERT INTO comments (id, project_id, thread_id, parent_id, target_type, target_id, package_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, threadId, (input.parentId as string | undefined) ?? null, target.type, target.id, target.packageId, principal.userId, body, at);
    this.events?.emit(projectId, { type: 'comments-changed' });
    return this.thread(projectId, threadId);
  }

  private async thread(projectId: string, threadId: string): Promise<ThreadView> {
    const rows = await this.db.query('SELECT * FROM comments WHERE project_id=? AND thread_id=? AND deleted=0 ORDER BY created_at, rowid').all(projectId, threadId) as Row[];
    const threads = await this.build(projectId, rows);
    if (!threads[0]) throw new NotFound('Discusión inexistente');
    return threads[0];
  }

  private async build(projectId: string, rows: Row[]): Promise<ThreadView[]> {
    const names = this.sessions ? await this.sessions.usernames(rows.map(r => r.author_id ?? '')) : new Map<string, string>();
    const byThread = new Map<string, ThreadView>();
    for (const row of rows) {
      let thread = byThread.get(row.thread_id);
      if (!thread) {
        const root = row.id === row.thread_id ? row : undefined;
        thread = { id: row.thread_id, targetType: row.target_type, targetId: row.target_id, packageId: row.package_id, resolved: false, resolvedBy: null, resolvedAt: null, createdAt: row.created_at, comments: [] };
        if (root) { thread.resolved = !!root.resolved; thread.resolvedBy = root.resolved_by; thread.resolvedAt = root.resolved_at; }
        byThread.set(row.thread_id, thread);
      }
      if (row.id === row.thread_id) { thread.resolved = !!row.resolved; thread.resolvedBy = row.resolved_by; thread.resolvedAt = row.resolved_at; thread.createdAt = row.created_at; }
      thread.comments.push({ id: row.id, authorId: row.author_id, authorName: row.author_id ? names.get(row.author_id) ?? null : null, body: row.body, createdAt: row.created_at, editedAt: row.edited_at });
    }
    void projectId;
    return [...byThread.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async list(projectId: string, principal: Principal, filter: CommentFilter = {}): Promise<ThreadView[]> {
    if (!await this.access.can(projectId, principal.userId, 'read', principal.linkToken)) throw new AccessDenied();
    if (filter.targetType && !(TARGET_TYPES as readonly string[]).includes(filter.targetType)) throw new BadRequest('targetType inválido');
    const where = ['project_id = ?', 'deleted = 0'], params: (string | number)[] = [projectId];
    // Se filtra por hilo (la raíz fija el objetivo y el estado) y se devuelve la discusión completa.
    const roots = await this.db.query(`SELECT thread_id FROM comments WHERE ${where.join(' AND ')} AND id = thread_id
      ${filter.targetType ? 'AND target_type = ?' : ''} ${filter.targetId ? 'AND target_id = ?' : ''} ${filter.packageId ? 'AND package_id = ?' : ''}
      ${filter.status === 'resolved' ? 'AND resolved = 1' : filter.status === 'all' ? '' : 'AND resolved = 0'} ORDER BY created_at LIMIT 500`)
      .all(...params, ...[filter.targetType, filter.targetId, filter.packageId].filter((v): v is string => !!v)) as { thread_id: string }[];
    if (!roots.length) return [];
    const rows = await this.db.query(`SELECT * FROM comments WHERE project_id = ? AND deleted = 0 AND thread_id IN (${roots.map(() => '?').join(',')}) ORDER BY created_at, rowid`).all(projectId, ...roots.map(r => r.thread_id)) as Row[];
    return this.build(projectId, rows);
  }

  /** Cantidad de discusiones abiertas por objetivo, para marcar elementos comentados en el diagrama. */
  async counts(projectId: string, principal: Principal): Promise<Record<string, number>> {
    if (!await this.access.can(projectId, principal.userId, 'read', principal.linkToken)) throw new AccessDenied();
    const rows = await this.db.query('SELECT target_type AS type, target_id AS id, COUNT(*) AS n FROM comments WHERE project_id=? AND deleted=0 AND id=thread_id AND resolved=0 GROUP BY target_type, target_id').all(projectId) as { type: string; id: string; n: number }[];
    return Object.fromEntries(rows.map(r => [`${r.type}|${r.id}`, r.n]));
  }

  /** Resolver o reabrir. Pueden hacerlo quien abrió la discusión y quienes editan el proyecto. */
  async resolve(projectId: string, principal: Principal, threadId: string, resolved: boolean): Promise<ThreadView> {
    if (!await this.access.can(projectId, principal.userId, 'comment', principal.linkToken) || !principal.userId) throw new AccessDenied();
    const root = await this.row(projectId, threadId);
    if (root.id !== root.thread_id) throw new BadRequest('Solo se resuelven discusiones, no respuestas');
    if (root.author_id !== principal.userId && !await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    if (resolved) await this.db.query('UPDATE comments SET resolved=1, resolved_by=?, resolved_at=? WHERE id=? AND project_id=?').run(principal.userId, this.now(), threadId, projectId);
    else await this.db.query('UPDATE comments SET resolved=0, resolved_by=NULL, resolved_at=NULL WHERE id=? AND project_id=?').run(threadId, projectId);
    this.events?.emit(projectId, { type: 'comments-changed' });
    return this.thread(projectId, threadId);
  }

  async edit(projectId: string, principal: Principal, commentId: string, body: unknown): Promise<ThreadView> {
    if (!principal.userId || !await this.access.can(projectId, principal.userId, 'comment', principal.linkToken)) throw new AccessDenied();
    const row = await this.row(projectId, commentId);
    if (row.author_id !== principal.userId) throw new AccessDenied('Solo el autor puede editar su comentario');
    await this.db.query('UPDATE comments SET body=?, edited_at=? WHERE id=? AND project_id=?').run(this.cleanBody(body), this.now(), commentId, projectId);
    this.events?.emit(projectId, { type: 'comments-changed' });
    return this.thread(projectId, row.thread_id);
  }

  /** Elimina (oculta) un comentario; si es la raíz, toda la discusión. Autor o administrador. */
  async delete(projectId: string, principal: Principal, commentId: string): Promise<void> {
    if (!principal.userId) throw new AccessDenied();
    const row = await this.row(projectId, commentId);
    if (row.author_id !== principal.userId && !await this.access.can(projectId, principal.userId, 'admin')) throw new AccessDenied();
    if (row.id === row.thread_id) await this.db.query('UPDATE comments SET deleted=1 WHERE project_id=? AND thread_id=?').run(projectId, row.thread_id);
    else await this.db.query('UPDATE comments SET deleted=1 WHERE id=? AND project_id=?').run(commentId, projectId);
    this.events?.emit(projectId, { type: 'comments-changed' });
  }
}
