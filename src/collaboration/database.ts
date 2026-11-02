import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';

type Executor = Pick<Client, 'execute'>;
export interface DbResult { changes: number; lastInsertRowid?: number | bigint }

/** Async SQL surface shared by the project stores. Queries can target a remote Turso/libSQL URL or a local libSQL file. */
export class LibsqlDatabase {
  private transactionContext = new AsyncLocalStorage<Executor>();

  constructor(readonly client: Client) {}

  static connect(url: string, authToken?: string): LibsqlDatabase {
    return new LibsqlDatabase(createClient({ url, ...(authToken ? { authToken } : {}) }));
  }

  static fromEnvironment(): LibsqlDatabase {
    if (process.env.LIBSQL_URL) return LibsqlDatabase.connect(process.env.LIBSQL_URL, process.env.LIBSQL_AUTH_TOKEN);
    const path = resolve(process.env.DBML_SHARED_DB ?? '.data/shared.sqlite');
    mkdirSync(dirname(path), { recursive: true });
    return LibsqlDatabase.connect(pathToFileURL(path).href);
  }

  private executor(): Executor { return this.transactionContext.getStore() ?? this.client; }

  query(sql: string) {
    return {
      get: async (...args: unknown[]) => {
        const result = await this.executor().execute({ sql, args: args as never });
        return result.rows[0] ?? null;
      },
      all: async (...args: unknown[]) => {
        const result = await this.executor().execute({ sql, args: args as never });
        return result.rows;
      },
      run: async (...args: unknown[]): Promise<DbResult> => {
        const result = await this.executor().execute({ sql, args: args as never });
        return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
      },
    };
  }

  async exec(sql: string): Promise<void> { await this.client.executeMultiple(sql); }

  transaction<T>(callback: () => T | Promise<T>) {
    return async (): Promise<T> => {
      const transaction = await this.client.transaction('write');
      try {
        const value = await this.transactionContext.run(transaction, callback);
        await transaction.commit();
        return value;
      } catch (error) {
        try { await transaction.rollback(); } catch { /* Preserve the operation error; closing below releases the transaction. */ }
        throw error;
      } finally {
        transaction.close();
      }
    };
  }

  async close(): Promise<void> { this.client.close(); }
}

/** Create/migrate every table before the API starts serving requests. Existing SQLite data remains readable by libSQL. */
export async function migrateDatabase(db: LibsqlDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT 'Proyecto');
    CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL REFERENCES shared_projects(id), user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(project_id,user_id));
    CREATE TABLE IF NOT EXISTS share_links (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES shared_projects(id), token_hash TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER, created_by TEXT);
    CREATE TABLE IF NOT EXISTS shared_documents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES shared_projects(id), package_id TEXT NOT NULL, name TEXT NOT NULL, state BLOB NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id, package_id, name));
    CREATE TABLE IF NOT EXISTS diagram_configs (project_id TEXT NOT NULL REFERENCES shared_projects(id), package_id TEXT NOT NULL, config TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id, package_id));
    CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES shared_projects(id), thread_id TEXT NOT NULL, parent_id TEXT, target_type TEXT NOT NULL, target_id TEXT NOT NULL, package_id TEXT, author_id TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL, edited_at INTEGER, resolved INTEGER NOT NULL DEFAULT 0, resolved_by TEXT, resolved_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS comments_target ON comments(project_id, target_type, target_id);
    CREATE INDEX IF NOT EXISTS comments_thread ON comments(project_id, thread_id);
    CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, project_id TEXT, actor_id TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_project ON audit_log(project_id, at);
    CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES shared_projects(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, author_id TEXT, authors TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL, restored_from TEXT, snapshot TEXT NOT NULL, hash TEXT NOT NULL, affected TEXT NOT NULL, UNIQUE(project_id, seq));
  `);

  await ensureColumn(db, 'shared_projects', 'name', "TEXT NOT NULL DEFAULT 'Proyecto'");
  await ensureColumn(db, 'share_links', 'expires_at', 'INTEGER');
  await ensureColumn(db, 'share_links', 'created_at', 'INTEGER');
  await ensureColumn(db, 'share_links', 'created_by', 'TEXT');
  await ensureColumn(db, 'shared_documents', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'comments', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
}

async function ensureColumn(db: LibsqlDatabase, table: string, column: string, declaration: string): Promise<void> {
  const columns = await db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(item => item.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
