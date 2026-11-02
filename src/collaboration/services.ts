import { AccessStore } from './access';
import { AuditLog } from './audit';
import { CommentStore } from './comments';
import { DiagramStore } from './diagram-state';
import { SharedDocuments } from './documents';
import { ProjectEvents } from './events';
import { HistoryStore } from './history';
import { RateLimiter } from './ratelimit';
import { SessionStore } from './sessions';
import { SharedBuilds } from './shared-build';
import { LibsqlDatabase, migrateDatabase } from './database';

export interface Limits { login: RateLimiter; write: RateLimiter; read: RateLimiter; export: RateLimiter }
export interface Services {
  db: LibsqlDatabase; access: AccessStore; sessions: SessionStore; documents: SharedDocuments; events: ProjectEvents; audit: AuditLog;
  diagrams: DiagramStore; builds: SharedBuilds; comments: CommentStore; history: HistoryStore; limits: Limits;
  /** Permite `POST /api/shared/register`. El registro permanece abierto mientras no se configure lo contrario. */
  registration: boolean;
}
export interface ServiceOptions {
  now?: () => number; idleMs?: number; passwordCost?: { memoryCost?: number; timeCost?: number }; registration?: boolean; limits?: Partial<Limits>;
  access?: AccessStore; sessions?: SessionStore; documents?: SharedDocuments;
}

/** Cablea los servicios sobre libSQL. La migración se completa antes de atender solicitudes. */
export async function createServices(db: LibsqlDatabase, options: ServiceOptions = {}): Promise<Services> {
  await migrateDatabase(db);
  const now = options.now ?? Date.now;
  const events = new ProjectEvents();
  const access = options.access ?? new AccessStore(db, now);
  const sessions = options.sessions ?? new SessionStore(db, now, options.passwordCost);
  const documents = options.documents ?? new SharedDocuments(db, access);
  const audit = new AuditLog(db, access, now);
  const diagrams = new DiagramStore(db, access, events, now);
  const builds = new SharedBuilds(access, documents, diagrams);
  const comments = new CommentStore(db, access, events, sessions, now);
  const history = new HistoryStore(db, access, documents, diagrams, events, audit, { idleMs: options.idleMs, now });
  // Cada edición recibida programa una única revisión automática cuando cesa la actividad.
  events.on((projectId, event) => { if (event.type === 'doc-edited') history.touch(projectId, event.userId); });
  const limits: Limits = {
    login: options.limits?.login ?? new RateLimiter(8, 0.1, now),
    write: options.limits?.write ?? new RateLimiter(60, 2, now),
    read: options.limits?.read ?? new RateLimiter(300, 20, now),
    export: options.limits?.export ?? new RateLimiter(6, 0.2, now),
  };
  return { db, access, sessions, documents, events, audit, diagrams, builds, comments, history, limits, registration: options.registration ?? true };
}
