import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LibsqlDatabase } from './database';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface Session { token: string; expiresAt: number }

/** Account identities and opaque, revocable sessions; raw credentials never enter project ACLs. */
export class SessionStore {
  private decoy?: Promise<string>;
  /** `hashCost` solo debería reducirse en pruebas; el valor por defecto de argon2id es el recomendado. */
  constructor(private db: LibsqlDatabase, private now: () => number = Date.now, private hashCost: { memoryCost?: number; timeCost?: number } = {}) {}
  async createAccount(username: string, password: string): Promise<string> {
    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(normalized) || password.length < 12 || password.length > 1024) throw new Error('Usuario o contraseña inválidos');
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id', ...this.hashCost });
    const id = randomUUID();
    await this.db.query('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)').run(id, normalized, passwordHash);
    return id;
  }
  async login(username: string, password: string): Promise<(Session & { userId: string; username: string }) | undefined> {
    if (password.length > 1024) return undefined;
    const user = await this.db.query('SELECT id, username, password_hash FROM accounts WHERE username=?').get(username.trim().toLowerCase()) as { id: string; username: string; password_hash: string } | null;
    // Se verifica siempre un hash para que la respuesta no revele si la cuenta existe por su tiempo.
    const hash = user?.password_hash ?? await (this.decoy ??= Bun.password.hash(randomBytes(16).toString('hex'), { algorithm: 'argon2id', ...this.hashCost }));
    const valid = await Bun.password.verify(password, hash);
    if (!user || !valid) return undefined;
    await this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
    const token = randomBytes(32).toString('base64url'), expiresAt = this.now() + 1000 * 60 * 60 * 24;
    await this.db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), user.id, expiresAt);
    return { token, expiresAt, userId: user.id, username: user.username };
  }
  async resolve(token: string | undefined): Promise<string | undefined> {
    if (!token || token.length > 256) return undefined;
    const row = await this.db.query('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(token), this.now()) as { user_id: string } | null;
    return row?.user_id;
  }
  async revoke(token: string): Promise<void> { await this.db.query('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token)); }
  /** Nombres visibles de las cuentas (autores, presencia, invitaciones). */
  async usernames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, 500);
    if (!unique.length) return new Map();
    const rows = await this.db.query(`SELECT id, username FROM accounts WHERE id IN (${unique.map(() => '?').join(',')})`).all(...unique) as { id: string; username: string }[];
    return new Map(rows.map(r => [r.id, r.username]));
  }
  async findByUsername(username: string): Promise<string | undefined> {
    return (await this.db.query('SELECT id FROM accounts WHERE username=?').get(username.trim().toLowerCase()) as { id: string } | null)?.id;
  }
}
