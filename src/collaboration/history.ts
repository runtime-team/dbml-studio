import { createHash, randomUUID } from 'node:crypto';
import type { AccessStore } from './access';
import type { AuditLog } from './audit';
import type { DiagramStore } from './diagram-state';
import { diffLines, toHunks, type Hunk } from './diff';
import type { Principal, SharedDocuments } from './documents';
import { AccessDenied, BadRequest, NotFound } from './errors';
import type { ProjectEvents } from './events';
import type { DiagramConfig } from '../project/loader';
import type { LibsqlDatabase } from './database';

export type RevisionKind = 'edit' | 'manual' | 'restore';
export interface Snapshot { files: { packageId: string; name: string; content: string }[]; diagrams: Record<string, DiagramConfig> }
export interface RevisionSummary {
  id: string; seq: number; kind: RevisionKind; authorId: string | null; authors: string[]; message: string; createdAt: number;
  affectedPackages: string[]; restoredFrom: string | null;
}
export interface RevisionDetail extends RevisionSummary { snapshot: Snapshot }
export interface FileChange { packageId: string; name: string; status: 'added' | 'removed' | 'modified'; hunks: Hunk[]; added: number; removed: number }
export interface RevisionDiff {
  from: string; to: string;
  files: FileChange[];
  /** Cambios de configuración visual (posiciones y vistas externas) por paquete. */
  diagrams: { packageId: string; movedNodes: number; viewsChanged: boolean }[];
  affectedPackages: string[];
}

export const HISTORY_LIMITS = { revisions: 5000, snapshotBytes: 8_000_000 } as const;
const stable = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en'))) : v);
const digest = (snapshot: Snapshot) => createHash('sha1').update(stable(snapshot)).digest('hex');

interface Row { id: string; project_id: string; seq: number; kind: RevisionKind; author_id: string | null; authors: string; message: string; created_at: number; restored_from: string | null; snapshot: string; hash: string; affected: string }

/**
 * Historial por proyecto. Cada revisión guarda los archivos DBML y la configuración visual en una sola
 * instantánea, de modo que ambos permanecen coherentes. Restaurar crea una revisión nueva: el historial
 * nunca se reescribe ni se elimina.
 */
export class HistoryStore {
  private pending = new Map<string, { authors: Set<string>; last?: string; timer: ReturnType<typeof setTimeout> }>();
  constructor(
    private db: LibsqlDatabase, private access: AccessStore, private documents: SharedDocuments, private diagrams: DiagramStore,
    private events?: ProjectEvents, private audit?: AuditLog, private options: { idleMs?: number; now?: () => number } = {},
  ) {}
  private now() { return (this.options.now ?? Date.now)(); }

  /** Estado actual (documentos vigentes + configuración visual). */
  async capture(projectId: string, principal: Principal): Promise<Snapshot> {
    const files = (await this.documents.files(projectId, principal)).map(({ packageId, name, content }) => ({ packageId, name, content }));
    const configs = await this.diagrams.all(projectId, principal);
    const diagrams: Record<string, DiagramConfig> = {};
    for (const [pkg, config] of Object.entries(configs)) {
      const { version: _version, ...clean } = config;
      if ((clean.external?.length ?? 0) || Object.keys(clean.layout ?? {}).length) diagrams[pkg] = clean;
    }
    return { files, diagrams };
  }

  private async latest(projectId: string): Promise<Row | undefined> {
    return await this.db.query('SELECT * FROM revisions WHERE project_id=? ORDER BY seq DESC LIMIT 1').get(projectId) as Row | undefined ?? undefined;
  }
  private summary(row: Row): RevisionSummary {
    return { id: row.id, seq: row.seq, kind: row.kind, authorId: row.author_id, authors: JSON.parse(row.authors), message: row.message, createdAt: row.created_at, affectedPackages: JSON.parse(row.affected), restoredFrom: row.restored_from };
  }

  /** Paquetes cuyos archivos o configuración difieren entre dos instantáneas. */
  static affected(before: Snapshot | undefined, after: Snapshot): string[] {
    const result = new Set<string>();
    const files = (s?: Snapshot) => new Map((s?.files ?? []).map(f => [`${f.packageId}/${f.name}`, f.content] as const));
    const a = files(before), b = files(after);
    for (const key of new Set([...a.keys(), ...b.keys()])) if (a.get(key) !== b.get(key)) result.add(key.split('/')[0]!);
    for (const pkg of new Set([...Object.keys(before?.diagrams ?? {}), ...Object.keys(after.diagrams)])) if (stable(before?.diagrams[pkg] ?? null) !== stable(after.diagrams[pkg] ?? null)) result.add(pkg);
    return [...result].sort();
  }

  /** Registra una revisión si el estado cambió. Devuelve `undefined` cuando no hay nada nuevo que registrar. */
  private async insert(projectId: string, principal: Principal, input: { kind: RevisionKind; message: string; authors: string[]; authorId?: string; restoredFrom?: string; force?: boolean }): Promise<RevisionSummary | undefined> {
    const snapshot = await this.capture(projectId, principal);
    const text = JSON.stringify(snapshot);
    if (text.length > HISTORY_LIMITS.snapshotBytes) throw new BadRequest('El proyecto es demasiado grande para guardar una versión');
    const previous = await this.latest(projectId);
    const hash = digest(snapshot);
    if (previous?.hash === hash && !input.force) return undefined;
    const count = (await this.db.query('SELECT COUNT(*) AS n FROM revisions WHERE project_id=?').get(projectId) as { n: number }).n;
    if (count >= HISTORY_LIMITS.revisions) throw new BadRequest('El historial alcanzó el máximo de revisiones');
    const affected = HistoryStore.affected(previous ? JSON.parse(previous.snapshot) as Snapshot : undefined, snapshot);
    const id = randomUUID(), seq = (previous?.seq ?? 0) + 1;
    await this.db.query('INSERT INTO revisions (id, project_id, seq, kind, author_id, authors, message, created_at, restored_from, snapshot, hash, affected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, seq, input.kind, input.authorId ?? principal.userId ?? null, JSON.stringify([...new Set(input.authors)].slice(0, 20)), input.message.slice(0, 300), this.now(), input.restoredFrom ?? null, text, hash, JSON.stringify(affected));
    this.events?.emit(projectId, { type: 'history-changed', revisionId: id });
    return { id, seq, kind: input.kind, authorId: input.authorId ?? principal.userId ?? null, authors: [...new Set(input.authors)], message: input.message.slice(0, 300), createdAt: this.now(), affectedPackages: affected, restoredFrom: input.restoredFrom ?? null };
  }

  /** «Guardar versión»: revisión manual con mensaje. Si no hay cambios desde la última, no crea otra. */
  async record(projectId: string, principal: Principal, message: string): Promise<{ revision?: RevisionSummary; unchanged: boolean }> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    const text = String(message ?? '').trim();
    if (text.length > 300) throw new BadRequest('El mensaje excede 300 caracteres');
    const revision = await this.insert(projectId, principal, { kind: 'manual', message: text || 'Versión guardada', authors: principal.userId ? [principal.userId] : [] });
    await this.audit?.record(projectId, principal.userId, 'revision.create', revision?.id, { unchanged: !revision });
    return { revision, unchanged: !revision };
  }

  /**
   * Registro automático: cada edición reinicia un temporizador y, tras `idleMs` de calma, se guarda una
   * única revisión atribuida a quienes editaron. Así el historial no crece con cada pulsación.
   */
  touch(projectId: string, userId: string | undefined): void {
    const idle = this.options.idleMs ?? 30_000;
    const entry = this.pending.get(projectId);
    if (entry) clearTimeout(entry.timer);
    const authors = entry?.authors ?? new Set<string>();
    if (userId) authors.add(userId);
    const timer = setTimeout(() => { void this.flush(projectId); }, idle);
    (timer as { unref?: () => void }).unref?.();
    this.pending.set(projectId, { authors, last: userId ?? entry?.last, timer });
  }
  /** Guarda de inmediato la revisión automática pendiente de un proyecto (también al cerrar el servidor). */
  async flush(projectId: string): Promise<RevisionSummary | undefined> {
    const entry = this.pending.get(projectId);
    if (!entry) return undefined;
    clearTimeout(entry.timer); this.pending.delete(projectId);
    try {
      // La captura es interna: la autoría ya fue verificada en cada actualización recibida.
      const owner = await this.db.query('SELECT owner_id FROM shared_projects WHERE id=?').get(projectId) as { owner_id: string } | null;
      if (!owner) return undefined;
      const privileged: Principal = { userId: owner.owner_id };
      return await this.insert(projectId, privileged, { kind: 'edit', message: 'Cambios guardados automáticamente', authors: [...entry.authors], authorId: entry.last });
    } catch (error) { console.error('No se pudo registrar la revisión automática:', error); return undefined; }
  }
  async flushAll(): Promise<void> { await Promise.all([...this.pending.keys()].map(projectId => this.flush(projectId))); }

  async list(projectId: string, principal: Principal, options: { limit?: number; beforeSeq?: number } = {}): Promise<RevisionSummary[]> {
    if (!await this.access.can(projectId, principal.userId, 'read', principal.linkToken)) throw new AccessDenied();
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const rows = await this.db.query(`SELECT id, project_id, seq, kind, author_id, authors, message, created_at, restored_from, '' AS snapshot, hash, affected FROM revisions WHERE project_id=? ${options.beforeSeq ? 'AND seq < ?' : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...(options.beforeSeq ? [projectId, options.beforeSeq, limit] : [projectId, limit])) as Row[];
    return rows.map(row => this.summary(row));
  }
  async get(projectId: string, principal: Principal, revisionId: string): Promise<RevisionDetail> {
    if (!await this.access.can(projectId, principal.userId, 'read', principal.linkToken)) throw new AccessDenied();
    const row = await this.db.query('SELECT * FROM revisions WHERE id=? AND project_id=?').get(revisionId, projectId) as Row | null;
    if (!row) throw new NotFound('Revisión inexistente');
    return { ...this.summary(row), snapshot: JSON.parse(row.snapshot) as Snapshot };
  }

  /** Compara una revisión con otra o con el estado actual (`against = 'current'`). */
  async diff(projectId: string, principal: Principal, fromId: string, against: string = 'current'): Promise<RevisionDiff> {
    const from = (await this.get(projectId, principal, fromId)).snapshot;
    const to = against === 'current' ? await this.capture(projectId, principal) : (await this.get(projectId, principal, against)).snapshot;
    const key = (f: { packageId: string; name: string }) => `${f.packageId}/${f.name}`;
    const a = new Map(from.files.map(f => [key(f), f] as const)), b = new Map(to.files.map(f => [key(f), f] as const));
    const files: FileChange[] = [];
    for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const before = a.get(k), after = b.get(k);
      if (before?.content === after?.content) continue;
      const lines = diffLines(before?.content ?? '', after?.content ?? '');
      const f = (after ?? before)!;
      files.push({ packageId: f.packageId, name: f.name, status: !before ? 'added' : !after ? 'removed' : 'modified', hunks: toHunks(lines), added: lines.filter(l => l.type === 'add').length, removed: lines.filter(l => l.type === 'del').length });
    }
    const diagrams = [...new Set([...Object.keys(from.diagrams), ...Object.keys(to.diagrams)])].sort().flatMap(packageId => {
      const x = from.diagrams[packageId], y = to.diagrams[packageId];
      const layoutA = x?.layout ?? {}, layoutB = y?.layout ?? {};
      const moved = [...new Set([...Object.keys(layoutA), ...Object.keys(layoutB)])].filter(id => stable(layoutA[id] ?? null) !== stable(layoutB[id] ?? null)).length;
      const viewsChanged = stable(x?.external ?? []) !== stable(y?.external ?? []);
      return moved || viewsChanged ? [{ packageId, movedNodes: moved, viewsChanged }] : [];
    });
    return { from: fromId, to: against, files, diagrams, affectedPackages: HistoryStore.affected(from, to) };
  }

  /**
   * Restaura una revisión como cambio nuevo y auditable: primero guarda el estado actual si no estaba
   * registrado y después aplica la instantánea. Los documentos ausentes se ocultan (recuperables).
   */
  async restore(projectId: string, principal: Principal, revisionId: string): Promise<RevisionSummary> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    const target = await this.get(projectId, principal, revisionId);
    await this.flush(projectId);
    await this.insert(projectId, principal, { kind: 'edit', message: `Estado previo a restaurar la revisión #${target.seq}`, authors: principal.userId ? [principal.userId] : [] });
    const current = await this.documents.list(projectId, principal);
    const wanted = new Set(target.snapshot.files.map(f => `${f.packageId}/${f.name}`));
    for (const file of target.snapshot.files) {
      const existing = await this.documents.find(projectId, file.packageId, file.name);
      if (!existing) { const id = await this.documents.create(projectId, principal, file.packageId, file.name, file.content); this.events?.emit(projectId, { type: 'doc-updated', documentId: id, state: await this.documents.read(projectId, id, principal) }); }
      else {
        const state = await this.documents.setText(projectId, existing.id, principal, file.content);
        this.events?.emit(projectId, { type: 'doc-updated', documentId: existing.id, state });
      }
    }
    for (const doc of current) if (!wanted.has(`${doc.packageId}/${doc.name}`)) await this.documents.delete(projectId, principal, doc.id);
    const packages = new Set([...Object.keys(await this.diagrams.all(projectId, principal)), ...Object.keys(target.snapshot.diagrams)]);
    for (const pkg of packages) await this.diagrams.replace(projectId, principal, pkg, target.snapshot.diagrams[pkg]);
    this.events?.emit(projectId, { type: 'documents-changed' });
    const revision = (await this.insert(projectId, principal, { kind: 'restore', message: `Restauración de la revisión #${target.seq}`, authors: principal.userId ? [principal.userId] : [], restoredFrom: target.id, force: true }))!;
    await this.audit?.record(projectId, principal.userId, 'revision.restore', target.id, { fromSeq: target.seq, newSeq: revision.seq });
    return revision;
  }
}

