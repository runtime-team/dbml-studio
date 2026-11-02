import type { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

export interface RegisteredLocalProject { name: string; manifestPath: string; registeredAt: number; lastOpenedAt: number }

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

/** Historial de proyectos locales, compartido entre navegadores mediante la SQLite del servidor. */
export class LocalProjectRegistry {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS local_recent_projects (
      path_key TEXT PRIMARY KEY,
      manifest_path TEXT NOT NULL,
      name TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS local_recent_projects_opened ON local_recent_projects(last_opened_at DESC);`);
  }

  remember(manifestPath: string, name: string): void {
    const absolutePath = resolve(manifestPath);
    const key = pathKey(absolutePath);
    const openedAt = this.now();
    this.db.query(`INSERT INTO local_recent_projects (path_key, manifest_path, name, registered_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path_key) DO UPDATE SET manifest_path=excluded.manifest_path, name=excluded.name, last_opened_at=excluded.last_opened_at`)
      .run(key, absolutePath, name, openedAt, openedAt);
    this.db.query(`DELETE FROM local_recent_projects WHERE path_key NOT IN (
      SELECT path_key FROM local_recent_projects ORDER BY last_opened_at DESC LIMIT 30
    )`).run();
  }

  list(limit = 20): RegisteredLocalProject[] {
    const safeLimit = Math.max(1, Math.min(30, Math.trunc(limit)));
    return this.db.query(`SELECT name, manifest_path AS manifestPath, registered_at AS registeredAt, last_opened_at AS lastOpenedAt
      FROM local_recent_projects ORDER BY last_opened_at DESC LIMIT ?`).all(safeLimit) as RegisteredLocalProject[];
  }

  remove(manifestPath: string): void {
    this.db.query('DELETE FROM local_recent_projects WHERE path_key = ?').run(pathKey(manifestPath));
  }
}
