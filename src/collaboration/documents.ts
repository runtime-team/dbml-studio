import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { AccessStore } from './access';
import { AccessDenied, BadRequest, NotFound } from './errors';
import type { LibsqlDatabase } from './database';

export interface Principal { userId?: string; linkToken?: string }
export interface DocumentInfo { id: string; packageId: string; name: string }
export interface DocumentFile extends DocumentInfo { content: string }

export const DOCUMENT_LIMITS = { characters: 1_000_000, update: 1_000_000, state: 5_000_000, perProject: 500 } as const;
export const PACKAGE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
export const FILE_NAME = /^[a-zA-Z0-9_-]{1,120}\.dbml$/;

export const textOfState = (state: Uint8Array): string => {
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, state); return doc.getText('source').toString(); } finally { doc.destroy(); }
};

function rewritePackageReferences(content: string, sourcePath: string, oldPackageId: string, newPackageId: string): string {
  const sourceMoves = sourcePath.startsWith(`${oldPackageId}/`);
  const sourceAfterRename = sourceMoves ? `${newPackageId}${sourcePath.slice(oldPackageId.length)}` : sourcePath;
  return content.split('\n').map(line => {
    const match = /^(\s*(?:use|reuse)\b.*?\bfrom\s+)(['"])([^'"]+)\2/i.exec(line);
    if (!match) return line;
    const specifier = match[3]!;
    const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
    const targetPath = resolved.endsWith('.dbml') ? resolved : `${resolved}.dbml`;
    if (!sourceMoves && !targetPath.startsWith(`${oldPackageId}/`)) return line;
    const targetAfterRename = targetPath.startsWith(`${oldPackageId}/`) ? `${newPackageId}${targetPath.slice(oldPackageId.length)}` : targetPath;
    let nextSpecifier = posix.relative(posix.dirname(sourceAfterRename), targetAfterRename);
    if (!specifier.endsWith('.dbml')) nextSpecifier = nextSpecifier.replace(/\.dbml$/, '');
    if (specifier.startsWith('./') && !nextSpecifier.startsWith('.')) nextSpecifier = `./${nextSpecifier}`;
    return `${line.slice(0, match.index)}${match[1]}${match[2]}${nextSpecifier}${match[2]}${line.slice(match[0].length)}`;
  }).join('\n');
}

function replaceDocumentText(state: Uint8Array, text: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    const ytext = doc.getText('source'), previous = ytext.toString();
    let start = 0;
    while (start < previous.length && start < text.length && previous[start] === text[start]) start++;
    let end = 0;
    while (end < previous.length - start && end < text.length - start && previous[previous.length - 1 - end] === text[text.length - 1 - end]) end++;
    doc.transact(() => { ytext.delete(start, previous.length - start - end); ytext.insert(start, text.slice(start, text.length - end)); });
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}

/** Persistent CRDT documents. Callers must obtain userId from a verified session. */
export class SharedDocuments {
  constructor(private db: LibsqlDatabase, private access: AccessStore) {}
  async create(projectId: string, principal: Principal, packageId: string, name: string, content = ''): Promise<string> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    if (!PACKAGE_ID.test(packageId) || !FILE_NAME.test(name) || content.length > DOCUMENT_LIMITS.characters) throw new BadRequest('Documento inválido: usa letras, números, _ o - y extensión .dbml');
    const existing = await this.db.query('SELECT id, deleted FROM shared_documents WHERE project_id=? AND package_id=? AND name=?').get(projectId, packageId, name) as { id: string; deleted: number } | null;
    if (existing && !existing.deleted) throw new BadRequest(`Ya existe ${packageId}/${name}`);
    const count = (await this.db.query('SELECT COUNT(*) AS n FROM shared_documents WHERE project_id=? AND deleted=0').get(projectId) as { n: number }).n;
    if (count >= DOCUMENT_LIMITS.perProject) throw new BadRequest('El proyecto alcanzó el máximo de documentos');
    const doc = new Y.Doc(); doc.getText('source').insert(0, content);
    const state = Y.encodeStateAsUpdate(doc); doc.destroy();
    if (existing) { // Revive el documento eliminado con contenido nuevo (conserva su identificador).
      await this.db.query('UPDATE shared_documents SET state=?, deleted=0 WHERE id=?').run(state, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    await this.db.query('INSERT INTO shared_documents (id, project_id, package_id, name, state) VALUES (?, ?, ?, ?, ?)').run(id, projectId, packageId, name, state);
    return id;
  }
  private async row(projectId: string, documentId: string) {
    const row = await this.db.query('SELECT state, deleted FROM shared_documents WHERE id=? AND project_id=?').get(documentId, projectId) as { state: Uint8Array; deleted: number } | null;
    if (!row) throw new NotFound('Documento inexistente');
    return row;
  }
  async read(projectId: string, documentId: string, principal: Principal): Promise<Uint8Array> {
    if (!await this.access.can(projectId, principal.userId, 'read', principal.linkToken)) throw new AccessDenied();
    const row = await this.row(projectId, documentId);
    if (row.deleted) throw new NotFound('Documento inexistente');
    return new Uint8Array(row.state);
  }
  async list(projectId: string, principal: Principal): Promise<DocumentInfo[]> {
    if (!await this.access.can(projectId, principal.userId, 'read', principal.linkToken)) throw new AccessDenied();
    return await this.db.query('SELECT id, package_id AS packageId, name FROM shared_documents WHERE project_id=? AND deleted=0 ORDER BY package_id, name').all(projectId) as DocumentInfo[];
  }
  /** Archivos vigentes con su texto actual (compilación, historial y exportación). */
  async files(projectId: string, principal: Principal): Promise<DocumentFile[]> {
    if (!await this.access.can(projectId, principal.userId, 'read', principal.linkToken)) throw new AccessDenied();
    const rows = await this.db.query('SELECT id, package_id AS packageId, name, state FROM shared_documents WHERE project_id=? AND deleted=0 ORDER BY package_id, name').all(projectId) as (DocumentInfo & { state: Uint8Array })[];
    return rows.map(({ state, ...info }) => ({ ...info, content: textOfState(new Uint8Array(state)) }));
  }
  /** Busca por nombre, incluidos los eliminados. */
  async find(projectId: string, packageId: string, name: string): Promise<(DocumentInfo & { deleted: boolean }) | undefined> {
    const row = await this.db.query('SELECT id, package_id AS packageId, name, deleted FROM shared_documents WHERE project_id=? AND package_id=? AND name=?').get(projectId, packageId, name) as (DocumentInfo & { deleted: number }) | null;
    return row ? { id: row.id, packageId: row.packageId, name: row.name, deleted: !!row.deleted } : undefined;
  }
  /** Renames a package and repairs relative DBML imports in the same database transaction. */
  async renamePackage(projectId: string, principal: Principal, oldPackageId: string, newPackageId: string): Promise<Map<string, Uint8Array>> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    if (!PACKAGE_ID.test(oldPackageId) || !PACKAGE_ID.test(newPackageId)) throw new BadRequest('El nombre del paquete debe usar letras, números, guion o guion bajo.');
    if (oldPackageId === newPackageId) throw new BadRequest('El nuevo nombre debe ser distinto del actual.');
    return this.db.transaction(async () => {
      const rows = await this.db.query('SELECT id, package_id AS packageId, name, state, deleted FROM shared_documents WHERE project_id=?').all(projectId) as (DocumentInfo & { state: Uint8Array; deleted: number })[];
      if (!rows.some(row => row.packageId === oldPackageId && !row.deleted)) throw new NotFound('El paquete no existe.');
      if (rows.some(row => row.packageId === newPackageId) || await this.db.query('SELECT 1 FROM diagram_configs WHERE project_id=? AND package_id=?').get(projectId, newPackageId))
        throw new BadRequest('Ya existe un paquete con ese nombre.');

      const diagramConfig = await this.db.query('SELECT config FROM diagram_configs WHERE project_id=? AND package_id=?').get(projectId, oldPackageId) as { config: string } | null;
      let renamedConfig: string | undefined;
      if (diagramConfig) {
        const config = JSON.parse(diagramConfig.config) as { layout?: Record<string, unknown> };
        if (config.layout) {
          const prefix = `node:${oldPackageId}:`;
          const layout: Record<string, unknown> = {};
          for (const [nodeId, position] of Object.entries(config.layout)) {
            const nextId = nodeId.startsWith(prefix) ? `node:${newPackageId}:${nodeId.slice(prefix.length)}` : nodeId;
            if (layout[nextId] !== undefined) throw new BadRequest('El cambio de nombre produce posiciones de diagrama duplicadas.');
            layout[nextId] = position;
          }
          config.layout = layout;
        }
        renamedConfig = JSON.stringify(config);
      }

      const activeUpdates = new Map<string, Uint8Array>();
      for (const row of rows) {
        const sourcePath = `${row.packageId}/${row.name}`;
        const currentText = textOfState(new Uint8Array(row.state));
        const nextText = rewritePackageReferences(currentText, sourcePath, oldPackageId, newPackageId);
        if (nextText === currentText) continue;
        if (nextText.length > DOCUMENT_LIMITS.characters) throw new BadRequest(`La actualización de ${row.packageId}/${row.name} supera el límite de tamaño.`);
        const state = replaceDocumentText(new Uint8Array(row.state), nextText);
        if (state.byteLength > DOCUMENT_LIMITS.state) throw new BadRequest(`La actualización de ${row.packageId}/${row.name} supera el límite de estado.`);
        await this.db.query('UPDATE shared_documents SET state=? WHERE id=? AND project_id=?').run(state, row.id, projectId);
        if (!row.deleted) activeUpdates.set(row.id, state);
      }

      await this.db.query('UPDATE shared_documents SET package_id=? WHERE project_id=? AND package_id=?').run(newPackageId, projectId, oldPackageId);
      if (renamedConfig !== undefined)
        await this.db.query('UPDATE diagram_configs SET package_id=?, config=?, version=version+1, updated_by=?, updated_at=? WHERE project_id=? AND package_id=?').run(newPackageId, renamedConfig, principal.userId ?? null, Date.now(), projectId, oldPackageId);
      else await this.db.query('UPDATE diagram_configs SET package_id=? WHERE project_id=? AND package_id=?').run(newPackageId, projectId, oldPackageId);
      await this.db.query('UPDATE comments SET package_id=? WHERE project_id=? AND package_id=?').run(newPackageId, projectId, oldPackageId);
      await this.db.query("UPDATE comments SET target_id=? WHERE project_id=? AND target_type='package' AND target_id=?").run(newPackageId, projectId, oldPackageId);
      return activeUpdates;
    })();
  }
  async delete(projectId: string, principal: Principal, documentId: string): Promise<void> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    const result = await this.db.query('UPDATE shared_documents SET deleted=1 WHERE id=? AND project_id=? AND deleted=0').run(documentId, projectId);
    if (!result.changes) throw new NotFound('Documento inexistente');
  }
  async apply(projectId: string, documentId: string, principal: Principal, update: Uint8Array): Promise<Uint8Array> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    if (update.byteLength > DOCUMENT_LIMITS.update) throw new BadRequest('Actualización demasiado grande');
    return this.db.transaction(async () => {
      const doc = new Y.Doc();
      try {
        const current = await this.row(projectId, documentId);
        if (current.deleted) throw new NotFound('Documento inexistente');
        Y.applyUpdate(doc, current.state);
        Y.applyUpdate(doc, update);
        if (doc.getText('source').length > DOCUMENT_LIMITS.characters) throw new BadRequest('Documento demasiado grande');
        const state = Y.encodeStateAsUpdate(doc);
        if (state.byteLength > DOCUMENT_LIMITS.state) throw new BadRequest('Estado demasiado grande');
        await this.db.query('UPDATE shared_documents SET state=? WHERE project_id=? AND id=?').run(state, projectId, documentId);
        return state;
      } finally { doc.destroy(); }
    })();
  }
  /**
   * Reemplaza el texto con la menor edición posible (prefijo y sufijo comunes se conservan) para que
   * los cursores y ediciones concurrentes de otros participantes sobrevivan. Devuelve el estado completo.
   */
  async setText(projectId: string, documentId: string, principal: Principal, text: string): Promise<Uint8Array> {
    if (!await this.access.can(projectId, principal.userId, 'edit', principal.linkToken)) throw new AccessDenied();
    if (text.length > DOCUMENT_LIMITS.characters) throw new BadRequest('Documento demasiado grande');
    return this.db.transaction(async () => {
      const doc = new Y.Doc();
      try {
        const current = await this.row(projectId, documentId);
        Y.applyUpdate(doc, current.state);
        const ytext = doc.getText('source'), previous = ytext.toString();
        let start = 0; while (start < previous.length && start < text.length && previous[start] === text[start]) start++;
        let end = 0; while (end < previous.length - start && end < text.length - start && previous[previous.length - 1 - end] === text[text.length - 1 - end]) end++;
        doc.transact(() => { ytext.delete(start, previous.length - start - end); ytext.insert(start, text.slice(start, text.length - end)); });
        const state = Y.encodeStateAsUpdate(doc);
        await this.db.query('UPDATE shared_documents SET state=?, deleted=0 WHERE project_id=? AND id=?').run(state, projectId, documentId);
        return state;
      } finally { doc.destroy(); }
    })();
  }
}
