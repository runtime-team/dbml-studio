import { AccessStore, type LinkMode, type Role } from './access';
import { SessionStore } from './sessions';
import { SharedDocuments, type Principal } from './documents';
import { createServices, type Services } from './services';
import { AccessDenied, BadRequest, HttpError, NotFound, TooMany } from './errors';
import { TARGET_TYPES } from './comments';
import { StudioError } from '../project/diagnostics';
import { exportFromBuild, ExportError } from '../project/export';
import { PACKAGE_ID } from './documents';
import { findDefinition } from '../project/definition';
import type { DiagramConfig } from '../project/loader';
import { readBoundedBody, RequestBodyTooLarge } from '../server/body';

const MAX_BODY = 1_100_000;
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/** Cuerpo JSON acotado por tamaño real (no por la cabecera `content-length`, que el cliente controla). */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Tipo inválido');
  let text: string;
  try { text = await readBoundedBody(request, MAX_BODY); }
  catch (error) { if (error instanceof RequestBodyTooLarge) throw new HttpError(413, error.message); throw error; }
  let value: unknown;
  try { value = text ? JSON.parse(text) : {}; } catch { throw new BadRequest('JSON inválido'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRequest('Se esperaba un objeto JSON');
  return value as Record<string, unknown>;
}
const str = (value: unknown, name: string, max = 200): string => {
  if (typeof value !== 'string' || !value || value.length > max) throw new BadRequest(`${name} inválido`);
  return value;
};
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { ...SECURITY_HEADERS, ...headers } });

/**
 * API HTTP de proyectos compartidos. Cada operación exige una sesión Bearer; el enlace `x-share-token`
 * agrega permisos de proyecto. El servidor aplica límites de frecuencia y registra acciones administrativas.
 */
export async function createSharedApi(access: AccessStore, sessions: SessionStore, documents: SharedDocuments, services?: Services) {
  const s = services ?? await createServices(access.database, { access, sessions, documents });
  const { events, audit, diagrams, builds, comments, history, limits } = s;
  const emit = (projectId: string, type: 'documents-changed' | 'access-changed') => events.emit(projectId, { type });

  return async (request: Request, clientIp = 'local'): Promise<Response> => {
    const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
    const bearer = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    const userId = await sessions.resolve(bearer);
    const linkToken = request.headers.get('x-share-token') ?? undefined;
    const principal: Principal = { userId, linkToken };
    // Los límites se aplican por cuenta, por enlace o, en último caso, por origen de red.
    const identity = userId ? `u:${userId}` : `ip:${clientIp}`;
    const method = request.method;
    const take = (limiter: typeof limits.read, key = identity, cost = 1) => { if (!limiter.take(key, cost)) throw new TooMany(limiter.retryAfter(key, cost)); };
    try {
      if (parts[0] !== 'api' || parts[1] !== 'shared') return new Response('No encontrado', { status: 404 });
      const route = parts.slice(2);
      take(method === 'GET' ? limits.read : limits.write);

      // ---- cuentas y sesiones ----
      if (route[0] === 'config' && method === 'GET') return json({ registration: s.registration });
      if (route[0] === 'login' && method === 'POST') {
        const body = await readJson(request);
        if (typeof body.username !== 'string' || typeof body.password !== 'string') throw new AccessDenied();
        const key = `${clientIp}|${body.username.trim().toLowerCase().slice(0, 64)}`;
        if (!limits.login.take(key)) { await audit.record(null, undefined, 'auth.rate-limited', body.username.slice(0, 64)); throw new TooMany(limits.login.retryAfter(key), 'Demasiados intentos de inicio de sesión'); }
        const session = await sessions.login(body.username, body.password);
        if (!session) { await audit.record(null, undefined, 'auth.failed', body.username.slice(0, 64)); throw new AccessDenied(); }
        return json(session);
      }
      if (route[0] === 'register' && method === 'POST') {
        if (!s.registration) throw new HttpError(403, 'El registro de cuentas está desactivado en este servidor');
        const body = await readJson(request);
        if (!limits.login.take(`register|${clientIp}`)) throw new TooMany(limits.login.retryAfter(`register|${clientIp}`));
        const username = str(body.username, 'Usuario', 64).trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new BadRequest('Usuario inválido');
        const password = str(body.password, 'Contraseña', 1024);
        if (password.length < 12) throw new BadRequest('La contraseña debe tener al menos 12 caracteres');
        if (typeof body.confirmPassword !== 'string' || body.confirmPassword !== password) throw new BadRequest('Las contraseñas no coinciden');
        try { await sessions.createAccount(username, password); }
        catch (error) {
          if (error instanceof Error && /UNIQUE constraint failed: accounts\.username/i.test(error.message)) throw new BadRequest('Ese nombre de usuario ya existe');
          throw error;
        }
        const session = await sessions.login(username, password);
        if (!session) throw new HttpError(500, 'No se pudo crear la sesión');
        return json(session, 201);
      }
      if (route[0] === 'logout' && method === 'POST') { if (bearer) await sessions.revoke(bearer); return json({ ok: true }); }
      if (route[0] === 'me' && method === 'GET') {
        if (!userId) throw new HttpError(401, 'Sesión no iniciada');
        return json({ userId, username: (await sessions.usernames([userId])).get(userId) ?? null });
      }
      if (!userId) throw new HttpError(401, 'Inicia sesión para continuar');
      if (route[0] === 'projects' && route.length === 1) {
        if (method === 'GET') return json({ projects: await access.listProjectsFor(userId) });
        if (method === 'POST') {
          const body = await readJson(request);
          const id = await access.createProject(userId, typeof body.name === 'string' ? body.name : 'Proyecto');
          await audit.record(id, userId, 'project.create');
          return json({ id }, 201);
        }
      }
      if (route[0] !== 'projects' || !route[1]) return new Response('No encontrado', { status: 404 });
      const projectId = route[1];
      const rest = route.slice(2);
      const need = async (action: 'read' | 'comment' | 'edit' | 'admin') => {
        if (!await access.can(projectId, userId, action, linkToken)) throw new AccessDenied();
      };
      const admin = async () => { if (!userId || !await access.can(projectId, userId, 'admin')) throw new AccessDenied(); return userId; };

      // ---- proyecto ----
      if (!rest.length && method === 'GET') {
        await need('read');
        const [role, project, editable, commentable, isAdmin, projectDocuments] = await Promise.all([
          access.roleOf(projectId, userId, linkToken), access.getProject(projectId), access.can(projectId, userId, 'edit', linkToken),
          access.can(projectId, userId, 'comment', linkToken), access.can(projectId, userId, 'admin'), documents.list(projectId, principal),
        ]);
        return json({ id: projectId, name: project?.name ?? projectId, role, editable, commentable, admin: isAdmin, documents: projectDocuments });
      }
      if (rest[0] === 'rename' && method === 'POST') {
        const actor = await admin(); const body = await readJson(request);
        await access.renameProject(projectId, actor, str(body.name, 'Nombre', 80));
        await audit.record(projectId, actor, 'project.rename', undefined, { name: body.name });
        return json({ renamed: true });
      }
      if (rest[0] === 'packages' && rest.length === 3 && rest[2] === 'rename' && method === 'POST') {
        await need('edit');
        const oldPackageId = str(rest[1], 'Paquete', 80);
        const body = await readJson(request);
        const newPackageId = str(body.packageId, 'Paquete', 80);
        await history.flush(projectId);
        const updatedStates = await documents.renamePackage(projectId, principal, oldPackageId, newPackageId);
        try { await history.record(projectId, principal, `Paquete renombrado: ${oldPackageId} → ${newPackageId}`); }
        catch (error) { console.error('No se pudo registrar la revisión del cambio de nombre del paquete:', error); }
        try { await audit.record(projectId, userId, 'package.rename', oldPackageId, { packageId: newPackageId }); }
        catch (error) { console.error('No se pudo registrar la auditoría del cambio de nombre del paquete:', error); }
        for (const [documentId, state] of updatedStates) events.emit(projectId, { type: 'doc-updated', documentId, state });
        events.emit(projectId, { type: 'package-renamed', from: oldPackageId, to: newPackageId });
        events.emit(projectId, { type: 'comments-changed' });
        emit(projectId, 'documents-changed');
        return json({ renamed: true, packageId: newPackageId });
      }

      // ---- diagramas ----
      if (rest[0] === 'diagrams' && rest.length === 1 && method === 'GET') {
        await need('read');
        const result = await builds.build(projectId, principal);
        return json({ ok: result.ok, stale: result.stale, diagrams: result.diagrams, diagnostics: result.diagnostics, graph: result.graph ?? null, changedPackages: result.changedPackages });
      }
      if (rest[0] === 'definition' && rest.length === 1 && method === 'GET') {
        await need('read');
        const build = await builds.build(projectId, principal);
        const definition = build.compiled && findDefinition(build.project, build.compiled, url.searchParams.get('table') ?? '');
        if (!definition) throw new NotFound('Definición no encontrada');
        return json(definition);
      }
      if (rest[0] === 'diagram' && rest.length === 1 && method === 'POST') {
        await need('edit');
        const body = await readJson(request);
        const packageId = str(body.packageId, 'packageId', 80);
        if (!PACKAGE_ID.test(packageId)) throw new BadRequest('Paquete inválido');
        const saved = await diagrams.patch(projectId, principal, packageId, body.patch, async config => {
          // No se acepta una configuración que introduzca errores nuevos en ese diagrama.
          const before = new Set((await builds.build(projectId, principal)).diagnostics.filter(d => d.severity !== 'warning' && d.packageId === packageId).map(d => d.message));
          const after = (await builds.build(projectId, principal, { ...await builds.overrides(projectId), [packageId]: config as DiagramConfig })).diagnostics.filter(d => d.severity !== 'warning' && d.packageId === packageId);
          const added = after.filter(d => !before.has(d.message));
          if (added.length) throw new BadRequest(`Configuración rechazada: ${added.map(d => d.message).join('; ')}`);
        });
        return json({ version: saved.version });
      }

      // ---- documentos ----
      if (rest[0] === 'documents') {
        if (rest.length === 1 && method === 'POST') {
          await need('edit');
          const body = await readJson(request);
          if (typeof body.packageId !== 'string' || typeof body.name !== 'string' || typeof body.content !== 'string') throw new BadRequest('Solicitud inválida');
          const id = await documents.create(projectId, principal, body.packageId, body.name, body.content);
          await audit.record(projectId, userId, 'document.create', `${body.packageId}/${body.name}`);
          emit(projectId, 'documents-changed');
          return json({ id }, 201);
        }
        if (rest.length === 2 && method === 'GET') { await need('read'); return json({ state: Buffer.from(await documents.read(projectId, rest[1]!, principal)).toString('base64') }); }
        if (rest.length === 3 && rest[2] === 'delete' && method === 'POST') {
          await need('edit'); await documents.delete(projectId, principal, rest[1]!);
          await audit.record(projectId, userId, 'document.delete', rest[1]);
          emit(projectId, 'documents-changed');
          return json({ deleted: true });
        }
      }

      // ---- enlaces y miembros ----
      if (rest[0] === 'links') {
        if (rest.length === 1 && method === 'POST') {
          const actor = await admin(); const body = await readJson(request);
          const link = await access.createLink(projectId, actor, body.mode as LinkMode, { ttlSeconds: typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined });
          await audit.record(projectId, actor, 'link.create', link.id, { mode: body.mode, expiresAt: link.expiresAt });
          return json(link, 201);
        }
        if (rest.length === 1 && method === 'GET') { const actor = await admin(); return json({ links: await access.listLinks(projectId, actor) }); }
        if (rest.length === 3 && rest[2] === 'revoke' && method === 'POST') {
          const actor = await admin(); await access.revokeLink(projectId, actor, rest[1]!);
          await audit.record(projectId, actor, 'link.revoke', rest[1]);
          emit(projectId, 'access-changed');
          return json({ revoked: true });
        }
      }
      if (rest[0] === 'members') {
        if (rest.length === 1 && method === 'GET') {
          const actor = await admin(); const members = await access.listMembers(projectId, actor);
          const names = await sessions.usernames(members.map(m => m.userId));
          return json({ members: members.map(m => ({ ...m, username: names.get(m.userId) ?? null })) });
        }
        if (rest.length === 1 && method === 'POST') {
          const actor = await admin(); const body = await readJson(request);
          // Se puede invitar por nombre de usuario o por identificador de cuenta.
          const target = typeof body.username === 'string' ? await sessions.findByUsername(body.username) : typeof body.userId === 'string' ? body.userId : undefined;
          if (!target) throw new NotFound('No existe una cuenta con ese usuario');
          await access.setMember(projectId, actor, target, body.role as Exclude<Role, 'owner'>);
          await audit.record(projectId, actor, 'member.set', target, { role: body.role });
          emit(projectId, 'access-changed');
          return json({ updated: true });
        }
        if (rest.length === 3 && rest[2] === 'remove' && method === 'POST') {
          const actor = await admin(); await access.removeMember(projectId, actor, rest[1]!);
          await audit.record(projectId, actor, 'member.remove', rest[1]);
          emit(projectId, 'access-changed');
          return json({ removed: true });
        }
      }
      if (rest[0] === 'audit' && rest.length === 1 && method === 'GET') {
        const actor = await admin(); const entries = await audit.list(projectId, actor, Number(url.searchParams.get('limit') ?? 200) || 200);
        const names = await sessions.usernames(entries.map(e => e.actorId ?? ''));
        return json({ entries: entries.map(e => ({ ...e, actorName: e.actorId ? names.get(e.actorId) ?? null : null })) });
      }

      // ---- comentarios ----
      if (rest[0] === 'comments') {
        if (rest.length === 1 && method === 'GET') {
          await need('read');
          const type = url.searchParams.get('targetType') ?? undefined;
          if (type && !(TARGET_TYPES as readonly string[]).includes(type)) throw new BadRequest('targetType inválido');
          const status = url.searchParams.get('status') ?? 'open';
          if (!['open', 'resolved', 'all'].includes(status)) throw new BadRequest('status inválido');
          const [threads, counts] = await Promise.all([comments.list(projectId, principal, { targetType: type as never, targetId: url.searchParams.get('targetId') ?? undefined, packageId: url.searchParams.get('packageId') ?? undefined, status: status as 'open' | 'resolved' | 'all' }), comments.counts(projectId, principal)]);
          return json({ threads, counts });
        }
        if (rest.length === 1 && method === 'POST') { const body = await readJson(request); return json({ thread: await comments.create(projectId, principal, { ...body, body: body.body }) }, 201); }
        if (rest.length === 3 && rest[2] === 'resolve' && method === 'POST') { const body = await readJson(request); return json({ thread: await comments.resolve(projectId, principal, rest[1]!, body.resolved !== false) }); }
        if (rest.length === 3 && rest[2] === 'edit' && method === 'POST') { const body = await readJson(request); return json({ thread: await comments.edit(projectId, principal, rest[1]!, body.body) }); }
        if (rest.length === 3 && rest[2] === 'delete' && method === 'POST') { await comments.delete(projectId, principal, rest[1]!); return json({ deleted: true }); }
      }

      // ---- historial ----
      if (rest[0] === 'revisions') {
        if (rest.length === 1 && method === 'GET') {
          await need('read');
          const revisions = await history.list(projectId, principal, { limit: Number(url.searchParams.get('limit') ?? 50) || 50, beforeSeq: Number(url.searchParams.get('before') ?? 0) || undefined });
          const names = await sessions.usernames(revisions.flatMap(r => [r.authorId ?? '', ...r.authors]));
          return json({ revisions: revisions.map(r => ({ ...r, authorName: r.authorId ? names.get(r.authorId) ?? null : null, authorNames: r.authors.map(a => names.get(a) ?? a) })) });
        }
        if (rest.length === 1 && method === 'POST') { await need('edit'); const body = await readJson(request); return json(await history.record(projectId, principal, typeof body.message === 'string' ? body.message : ''), 201); }
        if (rest.length === 2 && method === 'GET') { await need('read'); const { snapshot, ...summary } = await history.get(projectId, principal, rest[1]!); return json({ ...summary, files: snapshot.files.map(f => ({ packageId: f.packageId, name: f.name, size: f.content.length })) }); }
        if (rest.length === 3 && rest[2] === 'diff' && method === 'GET') { await need('read'); return json(await history.diff(projectId, principal, rest[1]!, url.searchParams.get('against') ?? 'current')); }
        if (rest.length === 3 && rest[2] === 'restore' && method === 'POST') { await need('edit'); return json({ revision: await history.restore(projectId, principal, rest[1]!) }, 201); }
      }

      // ---- exportación ----
      if (rest[0] === 'export' && rest.length === 2 && method === 'GET') {
        await need('read'); take(limits.export);
        const build = await builds.build(projectId, principal);
        const name = decodeURIComponent(rest[1]!);
        const spec = name === 'schema.sql' ? { format: 'sql' as const, dialect: url.searchParams.get('dialect') }
          : name === 'schema.dbml' ? { format: 'dbml' as const }
          : name === 'all.pdf' ? { format: 'pdf' as const }
          : /^[\w-]{1,80}\.(svg|pdf)$/.test(name) ? { format: name.endsWith('.svg') ? 'svg' as const : 'pdf' as const, packageId: name.replace(/\.(svg|pdf)$/, '') }
          : undefined;
        if (!spec) throw new NotFound('Exportación inexistente');
        const file = await exportFromBuild(build, { ...spec, size: url.searchParams.get('size'), orientation: url.searchParams.get('orientation') }, (await access.getProject(projectId))?.name);
        return new Response(file.body as BodyInit, { headers: { ...SECURITY_HEADERS, 'content-type': file.contentType, 'content-disposition': `attachment; filename="${file.filename}"` } });
      }
      return new Response('No encontrado', { status: 404 });
    } catch (error) {
      if (error instanceof TooMany) return json({ error: error.message }, 429, { 'retry-after': String(error.retryAfterSeconds) });
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof ExportError) return json({ error: error.message }, 422);
      // Los errores de dominio informan su mensaje; los inesperados no filtran detalles internos.
      if (error instanceof StudioError) return json({ error: error.message, diagnostics: error.diagnostics }, 400);
      console.error('Error no controlado en la API compartida:', error);
      return json({ error: 'Error interno' }, 500);
    }
  };
}
