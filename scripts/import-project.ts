/**
 * Crea un proyecto compartido a partir de un proyecto local.
 * Uso: bun run import-project <dbml.project.yaml> <usuario-propietario> [nombre]
 */
import { basename } from 'node:path';
import { createServices } from '../src/collaboration/services';
import { loadProject } from '../src/project/loader';
import { LibsqlDatabase } from '../src/collaboration/database';

const [manifest, username, ...nameParts] = process.argv.slice(2);
if (!manifest || !username) { console.error('Uso: bun run import-project <dbml.project.yaml> <usuario> [nombre]'); process.exit(1); }
const db = LibsqlDatabase.fromEnvironment();
try {
  const services = await createServices(db);
  const owner = await services.sessions.findByUsername(username);
  if (!owner) throw new Error(`No existe la cuenta ${username}. Créala con: bun run create-user ${username}`);
  const project = await loadProject(manifest);
  const id = await services.access.createProject(owner, nameParts.join(' ') || project.manifest.name);
  const principal = { userId: owner };
  let files = 0;
  for (const pkg of project.packages) {
    for (const [file, content] of pkg.files) { await services.documents.create(id, principal, pkg.id, basename(file), content); files++; }
    if (pkg.diagram?.layout || pkg.diagram?.external) await services.diagrams.patch(id, principal, pkg.id, {
      layout: pkg.diagram.layout, views: pkg.diagram.external ? { upsert: pkg.diagram.external.map((v, i) => ({ ...v, id: v.id ?? `v${i}` })) } : undefined,
    });
  }
  await services.history.record(id, principal, 'Importado desde un proyecto local');
  await services.audit.record(id, owner, 'project.import', manifest, { files });
  console.log(`Proyecto compartido creado: ${id} (${project.packages.length} paquetes, ${files} archivos)\nAbre /projects/${id}`);
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { await db.close(); }
// El compilador de DBML deja un manejador abierto: se termina de forma explícita, igual que en la CLI.
process.exit(process.exitCode ?? 0);
