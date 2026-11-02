import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project/loader';

test('carga paquetes y archivos de forma determinista', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbml-studio-'));
  try {
    await mkdir(join(dir, 'ventas'));
    await writeFile(join(dir, 'dbml.project.yaml'), 'name: ejemplo\nversion: 1\nsource:\n  packages: [ventas]\n');
    await writeFile(join(dir, 'ventas', 'b.dbml'), 'Table b { id int }');
    await writeFile(join(dir, 'ventas', 'a.dbml'), 'Table a { id int }');
    const project = await loadProject(join(dir, 'dbml.project.yaml'));
    expect([...project.packages[0]!.files.keys()].map(p => p.split(/[\\/]/).pop())).toEqual(['a.dbml', 'b.dbml']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rechaza rutas fuera de la raíz', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbml-studio-'));
  try {
    await writeFile(join(dir, 'dbml.project.yaml'), 'name: ejemplo\nversion: 1\nsource:\n  packages: [../otro]\n');
    await expect(loadProject(join(dir, 'dbml.project.yaml'))).rejects.toThrow('Ruta de paquete inválida');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rechaza paquete vacío y rutas de paquete duplicadas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbml-studio-'));
  try {
    await mkdir(join(dir, 'vacio'));
    await writeFile(join(dir, 'dbml.project.yaml'), 'name: ejemplo\nversion: 1\nsource:\n  packages: [vacio]\n');
    await expect(loadProject(join(dir, 'dbml.project.yaml'))).rejects.toThrow('no contiene archivos DBML');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.dbml'), 'Table a { id int }');
    await writeFile(join(dir, 'src', 'b.dbml'), 'Table b { id int }');
    await writeFile(join(dir, 'dbml.project.yaml'), 'name: ejemplo\nversion: 1\nsource:\n  packages: [src, ./src]\n');
    await expect(loadProject(join(dir, 'dbml.project.yaml'))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rechaza paquetes que son enlaces simbólicos fuera de la raíz', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbml-studio-'));
  const outside = await mkdtemp(join(tmpdir(), 'dbml-external-'));
  try {
    await writeFile(join(outside, 'secret.dbml'), 'Table secret { id int }');
    // Crear enlaces simbólicos exige privilegios en Windows; sin ellos no se puede reproducir el escenario.
    try { await symlink(outside, join(dir, 'escaped'), 'junction'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    await writeFile(join(dir, 'dbml.project.yaml'), 'name: ejemplo\nversion: 1\nsource:\n  packages: [escaped]\n');
    await expect(loadProject(join(dir, 'dbml.project.yaml'))).rejects.toThrow('fuera de la raíz');
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

