import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AccessDenied, BadRequest, NotFound } from './errors';
import type { LibsqlDatabase } from './database';

export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
export type Action = 'read' | 'comment' | 'edit' | 'admin';
export type LinkMode = 'restricted' | 'view' | 'edit';
const permissions: Record<Role, Action[]> = {
  owner: ['read', 'comment', 'edit', 'admin'], editor: ['read', 'comment', 'edit'],
  commenter: ['read', 'comment'], viewer: ['read'],
};
const rank: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface LinkInfo { id: string; mode: LinkMode; revoked: number; expiresAt: number | null; createdAt: number | null; createdBy: string | null }
export interface ProjectInfo { id: string; name: string; ownerId: string }

/** Persistent project ACL and revocable bearer links. Identity must come from an authenticated session. */
export class AccessStore {
  constructor(private db: LibsqlDatabase, private now: () => number = Date.now) {}
  get database(): LibsqlDatabase { return this.db; }
  async createProject(ownerId: string, name = 'Proyecto'): Promise<string> {
    if (!ownerId) throw new AccessDenied('Se requiere un propietario autenticado');
    const clean = name.trim();
    if (!clean || clean.length > 80) throw new BadRequest('El nombre del proyecto debe tener entre 1 y 80 caracteres');
    const id = randomUUID();
    await this.db.transaction(async () => {
      await this.db.query('INSERT INTO shared_projects (id, owner_id, name) VALUES (?, ?, ?)').run(id, ownerId, clean);
      await this.db.query('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(id, ownerId, 'owner');
    })();
    return id;
  }
  async getProject(projectId: string): Promise<ProjectInfo | undefined> {
    return await this.db.query('SELECT id, name, owner_id AS ownerId FROM shared_projects WHERE id = ?').get(projectId) as ProjectInfo | undefined ?? undefined;
  }
  async renameProject(projectId: string, actorId: string | undefined, name: string): Promise<void> {
    if (!await this.can(projectId, actorId, 'admin')) throw new AccessDenied();
    const clean = name.trim();
    if (!clean || clean.length > 80) throw new BadRequest('El nombre del proyecto debe tener entre 1 y 80 caracteres');
    await this.db.query('UPDATE shared_projects SET name=? WHERE id=?').run(clean, projectId);
  }
  /** Proyectos de los que la cuenta es miembro. */
  async listProjectsFor(userId: string): Promise<{ id: string; name: string; role: Role }[]> {
    return await this.db.query('SELECT p.id AS id, p.name AS name, m.role AS role FROM project_members m JOIN shared_projects p ON p.id = m.project_id WHERE m.user_id = ? ORDER BY p.name, p.id').all(userId) as { id: string; name: string; role: Role }[];
  }
  private async memberRole(projectId: string, userId?: string): Promise<Role | undefined> {
    if (!userId) return undefined;
    return (await this.db.query('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId) as { role: Role } | null)?.role;
  }
  /** Rol efectivo (miembro o enlace). Los enlaces de edición solo otorgan edición a cuentas autenticadas. */
  async roleOf(projectId: string, userId: string | undefined, token?: string): Promise<Role | undefined> {
    if (!userId) return undefined;
    let role = await this.memberRole(projectId, userId);
    if (token) {
      const link = await this.db.query('SELECT mode, expires_at AS expiresAt FROM share_links WHERE project_id = ? AND token_hash = ? AND revoked = 0').get(projectId, hash(token)) as { mode: LinkMode; expiresAt: number | null } | null;
      const live = link && (link.expiresAt == null || link.expiresAt > this.now());
      const linkRole: Role | undefined = !live ? undefined : link.mode === 'view' ? 'viewer' : link.mode === 'edit' && userId ? 'editor' : undefined;
      if (linkRole && (!role || rank[linkRole] > rank[role])) role = linkRole;
    }
    return role;
  }
  async can(projectId: string, userId: string | undefined, action: Action, token?: string): Promise<boolean> {
    const role = await this.roleOf(projectId, userId, token);
    return !!role && permissions[role].includes(action);
  }
  async require(projectId: string, userId: string | undefined, action: Action, token?: string): Promise<void> {
    if (!await this.can(projectId, userId, action, token)) throw new AccessDenied();
  }
  async setMember(projectId: string, actorId: string, userId: string, role: Exclude<Role, 'owner'>): Promise<void> {
    if (!await this.can(projectId, actorId, 'admin')) throw new AccessDenied();
    const project = await this.db.query('SELECT owner_id FROM shared_projects WHERE id = ?').get(projectId) as { owner_id: string } | null;
    if (!userId || project?.owner_id === userId || !['editor', 'commenter', 'viewer'].includes(role)) throw new BadRequest('Miembro o rol inválido');
    await this.db.query('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(projectId, userId, role);
  }
  async createLink(projectId: string, actorId: string, mode: LinkMode, options: { ttlSeconds?: number } = {}): Promise<{ id: string; token: string; expiresAt: number | null }> {
    if (!await this.can(projectId, actorId, 'admin')) throw new AccessDenied();
    if (!['restricted', 'view', 'edit'].includes(mode)) throw new BadRequest('Modo de enlace inválido');
    const ttl = options.ttlSeconds;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 60 || ttl > 60 * 60 * 24 * 365)) throw new BadRequest('La vigencia debe estar entre 1 minuto y 1 año');
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    const expiresAt = ttl ? this.now() + ttl * 1000 : null;
    await this.db.query('INSERT INTO share_links (id, project_id, token_hash, mode, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, projectId, hash(token), mode, expiresAt, this.now(), actorId);
    return { id, token, expiresAt };
  }
  async revokeLink(projectId: string, actorId: string, linkId: string): Promise<void> {
    if (!await this.can(projectId, actorId, 'admin')) throw new AccessDenied();
    const result = await this.db.query('UPDATE share_links SET revoked=1 WHERE id=? AND project_id=?').run(linkId, projectId);
    if (!result.changes) throw new NotFound('Enlace inexistente');
  }
  async listLinks(projectId: string, actorId: string): Promise<LinkInfo[]> {
    if (!await this.can(projectId, actorId, 'admin')) throw new AccessDenied();
    return await this.db.query('SELECT id, mode, revoked, expires_at AS expiresAt, created_at AS createdAt, created_by AS createdBy FROM share_links WHERE project_id=? ORDER BY rowid').all(projectId) as LinkInfo[];
  }
  async listMembers(projectId: string, actorId: string): Promise<{ userId: string; role: Role }[]> {
    if (!await this.can(projectId, actorId, 'admin')) throw new AccessDenied();
    return await this.db.query('SELECT user_id AS userId, role FROM project_members WHERE project_id=? ORDER BY user_id').all(projectId) as { userId: string; role: Role }[];
  }
  async removeMember(projectId: string, actorId: string, userId: string): Promise<void> {
    if (!await this.can(projectId, actorId, 'admin')) throw new AccessDenied();
    const owner = await this.db.query('SELECT owner_id FROM shared_projects WHERE id=?').get(projectId) as { owner_id: string } | null;
    if (owner?.owner_id === userId) throw new BadRequest('No se puede eliminar al propietario');
    await this.db.query('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(projectId, userId);
  }
}
