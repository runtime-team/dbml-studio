import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadProject } from './src/project/loader';
import { ProjectBuilder } from './src/project/build';
import { exportFromBuild } from './src/project/export';
import { formatDiagnostic, toDiagnostics } from './src/project/diagnostics';

const USAGE = `Uso: bun run index.ts <check|export> [dbml.project.yaml] [--a3] [--portrait] [--dialect=postgres|mysql|mssql|oracle]`;

async function main() {
  const args = process.argv.slice(2);
  const command = args.find(a => !a.startsWith('--'));
  const rest = args.filter(a => a !== command);
  const flags = rest.filter(a => a.startsWith('--')), manifest = rest.find(a => !a.startsWith('--')) ?? 'dbml.project.yaml';
  if (!['check', 'export'].includes(command ?? '')) { console.error(USAGE); process.exitCode = 1; return; }

  const project = await loadProject(manifest);
  const build = new ProjectBuilder().build(project);
  for (const d of build.diagnostics) console[d.severity === 'warning' ? 'warn' : 'error'](`${d.severity === 'warning' ? 'Advertencia' : 'Error'}: ${formatDiagnostic(d)}`);
  if (!build.ok || !build.compiled) { process.exitCode = 1; return; }
  const errors = build.diagnostics.filter(d => d.severity !== 'warning').length;
  const tables = build.compiled.schema.schemas.flatMap(s => s.tables).length;

  if (command === 'check') {
    console.log(`Proyecto ${project.manifest.name}: ${project.packages.length} paquetes, ${tables} tablas, ${build.diagrams.length} diagramas, ${build.diagnostics.length - errors} advertencia(s), ${errors} error(es).`);
    if (errors) process.exitCode = 1;
    return;
  }
  if (errors) { console.error('No se exporta: corrige primero los errores anteriores.'); process.exitCode = 1; return; }

  const output = resolve(resolve(manifest, '..'), project.manifest.output?.directory ?? 'output');
  await mkdir(output, { recursive: true });
  const formats = project.manifest.output?.formats ?? ['svg'];
  const size = flags.includes('--a3') ? 'A3' : 'A4';
  const orientation = flags.includes('--portrait') ? 'portrait' : 'landscape';
  const dialect = flags.find(f => f.startsWith('--dialect='))?.split('=')[1] ?? project.manifest.options?.sqlDialect ?? 'postgres';
  const written: string[] = [];
  const emit = async (spec: Parameters<typeof exportFromBuild>[1], filename: string) => {
    const file = await exportFromBuild(build, spec, project.manifest.name);
    await writeFile(resolve(output, filename), file.body); written.push(filename);
  };
  for (const diagram of build.diagrams) {
    const name = encodeURIComponent(diagram.packageId);
    if (formats.includes('svg')) await emit({ format: 'svg', packageId: diagram.packageId }, `${name}.svg`);
    if (formats.includes('pdf')) await emit({ format: 'pdf', packageId: diagram.packageId, size, orientation }, `${name}.pdf`);
  }
  if (formats.includes('pdf') && build.diagrams.length) await emit({ format: 'pdf', size, orientation }, 'proyecto.pdf');
  await emit({ format: 'sql', dialect }, 'schema.sql');
  await emit({ format: 'dbml' }, 'schema.dbml');
  console.log(`Exportación terminada en ${output}: ${written.join(', ')}`);
}
main().then(() => process.exit(process.exitCode ?? 0)).catch(error => {
  for (const d of toDiagnostics(error)) console.error(formatDiagnostic(d));
  process.exit(1);
});
