import { SessionStore } from '../src/collaboration/sessions';
import { LibsqlDatabase, migrateDatabase } from '../src/collaboration/database';

const username = process.argv[2];
if (!username) { console.error('Uso: bun run create-user <usuario> (contraseña por stdin)'); process.exit(1); }
const password = (await Bun.stdin.text()).replace(/\r?\n$/, '');
const db = LibsqlDatabase.fromEnvironment();
try { await migrateDatabase(db); const id = await new SessionStore(db).createAccount(username, password); console.log(`Cuenta creada: ${id}`); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { await db.close(); }
