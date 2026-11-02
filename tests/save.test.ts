import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revision, saveSource, SaveConflict } from '../src/project/save';

test('guarda una revisión vigente y rechaza una edición obsoleta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbml-save-'));
  try {
    const file = join(dir, 'test.dbml'); await writeFile(file, 'original');
    const old = revision('original');
    await saveSource(file, 'nueva', old);
    await expect(saveSource(file, 'obsoleta', old)).rejects.toBeInstanceOf(SaveConflict);
    expect(await readFile(file, 'utf8')).toBe('nueva');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
