import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Trash2, UserPlus } from 'lucide-react';
import { SharedClient } from './shared-api';
import { buildProjectPath, withShareToken, type ProjectLocation } from '../collaboration/links';
import { timeAgo } from './logic';

interface Link { id: string; mode: string; revoked: number; expiresAt: number | null; createdAt: number | null }
interface Member { userId: string; role: string; username: string | null }
interface AuditEntry { id: string; action: string; target: string | null; at: number; actorName: string | null }

const MODES: Record<string, string> = { restricted: 'Solo invitados', view: 'Con el enlace y sesión iniciada: lectura', edit: 'Con el enlace y sesión iniciada: edición' };
const ROLES: Record<string, string> = { editor: 'Editor', commenter: 'Comentarista', viewer: 'Lector', owner: 'Propietario' };
const TTL: [string, number | undefined][] = [['Sin caducidad', undefined], ['1 hora', 3600], ['1 día', 86400], ['7 días', 604800], ['30 días', 2592000]];

interface Props { client: SharedClient; projectId: string; name: string; location: ProjectLocation; revision: number; onRenamed(): void; onNotice(text: string, kind?: 'info' | 'error'): void }

/** Administración del acceso: nombre, miembros y roles, enlaces revocables y registro de acciones administrativas. */
export function AccessPanel({ client, projectId, name, location, revision, onRenamed, onNotice }: Props) {
  const base = client.project(projectId);
  const [links, setLinks] = useState<Link[]>([]), [members, setMembers] = useState<Member[]>([]), [audit, setAudit] = useState<AuditEntry[]>([]);
  const [username, setUsername] = useState(''), [role, setRole] = useState('viewer');
  const [mode, setMode] = useState('view'), [ttl, setTtl] = useState(0);
  const [projectName, setProjectName] = useState(name);
  const [created, setCreated] = useState<string>();
  const fail = (e: unknown) => onNotice(e instanceof Error ? e.message : String(e), 'error');

  const refresh = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([client.request<{ links: Link[] }>(`${base}/links`), client.request<{ members: Member[] }>(`${base}/members`), client.request<{ entries: AuditEntry[] }>(`${base}/audit?limit=30`)]);
      setLinks(a.links); setMembers(b.members); setAudit(c.entries);
    } catch (e) { fail(e); }
  }, [client, base]);
  useEffect(() => { void refresh(); }, [refresh, revision]);
  const run = async (operation: () => Promise<unknown>, done?: string) => { try { await operation(); await refresh(); if (done) onNotice(done); } catch (e) { fail(e); } };
  const copy = (text: string, done: string) => navigator.clipboard.writeText(text).then(() => onNotice(done), () => onNotice('No se pudo copiar.', 'error'));

  return <section className="access" aria-label="Compartir y permisos">
    <h3><Link2 size={14}/> Compartir</h3>
    <div className="compose row"><input value={projectName} onChange={e => setProjectName(e.target.value)} maxLength={80} aria-label="Nombre del proyecto"/><button disabled={!projectName.trim() || projectName === name} onClick={() => void run(async () => { await client.request(`${base}/rename`, { name: projectName }); onRenamed(); }, 'Nombre actualizado.')}>Renombrar</button></div>
    <p className="empty small">Enlace directo a este proyecto (requiere sesión y permiso):</p>
    <div className="compose row"><input readOnly value={`${globalThis.location?.origin ?? ''}${buildProjectPath(location)}`} aria-label="Enlace directo" onFocus={e => e.currentTarget.select()}/><button onClick={() => void copy(`${globalThis.location.origin}${buildProjectPath(location)}`, 'Enlace copiado.')}><Copy size={13}/> Copiar</button></div>

    <h4>Miembros</h4>
    <ul className="members">{members.map(m => <li key={m.userId}><span>{m.username ?? m.userId.slice(0, 8)}</span>
      {m.role === 'owner' ? <em>{ROLES.owner}</em> : <>
        <select value={m.role} aria-label={`Rol de ${m.username ?? m.userId}`} onChange={e => void run(() => client.request(`${base}/members`, { userId: m.userId, role: e.target.value }), 'Rol actualizado.')}>{['editor', 'commenter', 'viewer'].map(r => <option key={r} value={r}>{ROLES[r]}</option>)}</select>
        <button className="icon" aria-label={`Quitar a ${m.username ?? m.userId}`} onClick={() => { if (confirm(`¿Quitar el acceso de ${m.username ?? m.userId}?`)) void run(() => client.request(`${base}/members/${m.userId}/remove`, {}), 'Miembro eliminado.'); }}><Trash2 size={13}/></button></>}
    </li>)}</ul>
    <div className="compose row"><input value={username} onChange={e => setUsername(e.target.value)} placeholder="Usuario a invitar" aria-label="Usuario a invitar"/>
      <select value={role} onChange={e => setRole(e.target.value)} aria-label="Rol">{['editor', 'commenter', 'viewer'].map(r => <option key={r} value={r}>{ROLES[r]}</option>)}</select>
      <button disabled={!username.trim()} onClick={() => void run(async () => { await client.request(`${base}/members`, { username, role }); setUsername(''); }, 'Invitación aplicada.')}><UserPlus size={13}/> Invitar</button></div>

    <h4>Enlaces compartidos</h4>
    <div className="compose row">
      <select value={mode} onChange={e => setMode(e.target.value)} aria-label="Tipo de enlace">{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={ttl} onChange={e => setTtl(Number(e.target.value))} aria-label="Vigencia">{TTL.map(([label], i) => <option key={label} value={i}>{label}</option>)}</select>
      <button onClick={() => void run(async () => { const r = await client.request<{ token: string }>(`${base}/links`, { mode, ttlSeconds: TTL[ttl]![1] }); setCreated(withShareToken(`${globalThis.location.origin}${buildProjectPath(location)}`, r.token)); })}>Crear enlace</button>
    </div>
    {mode === 'edit' && <p className="empty small">Quien use este enlace debe iniciar sesión; el enlace concede permiso de edición dentro del proyecto.</p>}
    {created && <div className="created-link" role="status"><p><strong>Copia el enlace ahora:</strong> no volverá a mostrarse.</p><div className="compose row"><input readOnly value={created} aria-label="Enlace creado" onFocus={e => e.currentTarget.select()}/><button onClick={() => void copy(created, 'Enlace copiado.')}><Copy size={13}/></button><button onClick={() => setCreated(undefined)}>Ocultar</button></div></div>}
    <ul className="links-list">{links.map(l => <li key={l.id} className={l.revoked ? 'revoked' : ''}>
      <span>{MODES[l.mode] ?? l.mode}{l.expiresAt ? <small> · {l.expiresAt < Date.now() ? 'caducado' : `caduca ${new Date(l.expiresAt).toLocaleString('es')}`}</small> : ''}{l.createdAt ? <small> · creado {timeAgo(l.createdAt)}</small> : ''}</span>
      {l.revoked ? <em>Revocado</em> : <button onClick={() => { if (confirm('El enlace dejará de funcionar de inmediato. ¿Revocar?')) void run(() => client.request(`${base}/links/${l.id}/revoke`, {}), 'Enlace revocado.'); }}>Revocar</button>}
    </li>)}</ul>

    <details className="audit"><summary>Registro de acciones ({audit.length})</summary>
      <ul>{audit.map(a => <li key={a.id}><time>{timeAgo(a.at)}</time> <b>{a.actorName ?? 'sistema'}</b> {a.action}{a.target ? ` · ${a.target}` : ''}</li>)}</ul>
    </details>
  </section>;
}
