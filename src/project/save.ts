import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export function revision(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export class SaveConflict extends Error { constructor() { super('El archivo cambió en disco. Recarga el proyecto antes de guardar.'); } }

/** Lee el contenido actual o `''` si el archivo aún no existe (su revisión es `revision('')`). */
export async function readOrEmpty(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

/** Serialize saves from this server and reject stale editor revisions. Un archivo inexistente equivale a contenido vacío. */
const pending = new Map<string, Promise<void>>();
export async function saveSource(path: string, content: string, expectedRevision: string): Promise<void> {
  const previous = pending.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = await readOrEmpty(path);
    if (revision(current) !== expectedRevision) throw new SaveConflict();
    const temp = join(dirname(path), `.dbml-studio-${randomUUID()}.tmp`);
    try { await writeFile(temp, content, { flag: 'wx' }); await rename(temp, path); }
    finally { await unlink(temp).catch(() => {}); }
  });
  pending.set(path, operation);
  try { await operation; } finally { if (pending.get(path) === operation) pending.delete(path); }
}
