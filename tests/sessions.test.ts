import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../src/collaboration/sessions';

test('sesiones verifican contraseña, expiran y se revocan', async () => {
  const db = new Database(':memory:');
  try {
    let now = 1000;
    const sessions = new SessionStore(db, () => now);
    const userId = await sessions.createAccount('Alice', 'una contraseña larga');
    expect(await sessions.login('alice', 'incorrecta')).toBeUndefined();
    const session = (await sessions.login('ALICE', 'una contraseña larga'))!;
    expect(sessions.resolve(session.token)).toBe(userId);
    expect(JSON.stringify(db.query('SELECT * FROM sessions').all())).not.toContain(session.token);
    sessions.revoke(session.token);
    expect(sessions.resolve(session.token)).toBeUndefined();
    const second = (await sessions.login('alice', 'una contraseña larga'))!;
    now = second.expiresAt;
    expect(sessions.resolve(second.token)).toBeUndefined();
  } finally { db.close(); }
});
