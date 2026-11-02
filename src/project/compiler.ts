import { Parser, ModelExporter, Filepath } from '@dbml/core';
import { posix, relative, sep } from 'node:path';
import type { Project } from './loader';
import { Codes, ProjectCompileError, type Diagnostic, type PackageId, type TableId } from './diagnostics';

export { ProjectCompileError } from './diagnostics';
export type { Diagnostic } from './diagnostics';

export interface TableDeclaration { tableId: TableId; packageId: PackageId; file: string; line: number; column: number }
export interface ImportEdge { from: string; to: string; fromPackage: PackageId; toPackage?: PackageId; line: number; column: number; keyword: 'use' | 'reuse'; specifier: string }
export type SqlDialect = 'postgres' | 'mysql' | 'mssql' | 'oracle';

/** Nodos del AST oficial que necesitamos; el paquete no exporta tipos para ellos. */
interface Pos { line: number; column: number; offset: number }
interface AstNode { start: number; end: number; startPos: Pos }
interface TableAst extends AstNode { type?: { value: string }; name?: AstNode }
interface UseAst extends AstNode { importPath?: AstNode }
interface FileAst { declarations: TableAst[]; uses?: UseAst[]; source: string }

const ENTRY = '/__dbml_studio_entry__.dbml';

function fileKey(project: Project, file: string): string {
  const name = relative(project.root, file).split(sep).join('/');
  if (name.startsWith('../')) throw new Error(`Ruta DBML incompatible: ${name}`);
  if (name.includes("'")) throw new Error(`Ruta DBML incompatible: ${name}`);
  return name;
}

/** Resuelve una ruta de importación como lo hace el módulo oficial: relativa al archivo y con extensión `.dbml` opcional. */
export function resolveImport(from: string, specifier: string): string {
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  return joined.endsWith('.dbml') ? joined : `${joined}.dbml`;
}

/** Componentes fuertemente conexos con más de un nodo (o con autociclo) de un grafo dirigido. */
export function findCycles<T extends string>(nodes: T[], edges: Map<T, T[]>): T[][] {
  const index = new Map<T, number>(), low = new Map<T, number>(), onStack = new Set<T>(), stack: T[] = [], result: T[][] = [];
  let counter = 0;
  const visit = (root: T) => {
    // Iterativo: los proyectos grandes no deben agotar la pila de llamadas.
    const work: { node: T; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter); low.set(root, counter++); stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const neighbours = edges.get(frame.node) ?? [];
      if (frame.next < neighbours.length) {
        const next = neighbours[frame.next++]!;
        if (!index.has(next)) { index.set(next, counter); low.set(next, counter++); stack.push(next); onStack.add(next); work.push({ node: next, next: 0 }); }
        else if (onStack.has(next)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: T[] = [];
          let member: T;
          do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== frame.node);
          if (component.length > 1 || (edges.get(frame.node) ?? []).includes(frame.node)) result.push(component.sort());
        }
      }
    }
  };
  for (const node of [...nodes].sort()) if (!index.has(node)) visit(node);
  return result;
}

/** Compiles all project sources into one official DBML model using the module system. */
export function compileProject(project: Project) {
  const parser = new Parser();
  const sources: string[] = [];
  const sourceOwners = new Map<string, PackageId>();
  for (const pkg of project.packages) {
    for (const [file, source] of pkg.files) {
      const name = fileKey(project, file);
      parser.setDbmlSource(`/${name}`, source);
      sources.push(name);
      sourceOwners.set(name, pkg.id);
    }
  }
  sources.sort();
  if (sources.includes('__dbml_studio_entry__.dbml')) throw new Error('El nombre de entrada está reservado.');
  parser.setDbmlSource(ENTRY, sources.map(path => `reuse * from './${path}'`).join('\n'));

  const astOf = (source: string): FileAst => parser.DBMLCompiler.parse.ast(new Filepath(`/${source}`)) as unknown as FileAst;

  /** Todas las declaraciones de tablas, conservando duplicados para poder diagnosticarlos. */
  const scanDeclarations = (): TableDeclaration[] => {
    const found: TableDeclaration[] = [];
    for (const source of sources) {
      let ast: FileAst;
      try { ast = astOf(source); } catch { continue; }
      for (const node of ast.declarations ?? []) {
        if (node.type?.value.toLowerCase() !== 'table') continue;
        let name: unknown;
        try { name = parser.DBMLCompiler.nodeFullname(node as never).getValue(); } catch { continue; }
        if (!Array.isArray(name) || !name.length) continue;
        const pos = (node.name ?? node).startPos;
        found.push({ tableId: name.length === 1 ? `public.${name[0]}` : name.join('.'), packageId: sourceOwners.get(source)!, file: source, line: pos.line + 1, column: pos.column + 1 });
      }
    }
    return found;
  };

  const scanImports = (): ImportEdge[] => {
    const edges: ImportEdge[] = [];
    const known = new Set(sources);
    for (const source of sources) {
      let ast: FileAst;
      try { ast = astOf(source); } catch { continue; }
      for (const use of ast.uses ?? []) {
        const text = ast.source.slice(use.start, use.end);
        const specifier = (use.importPath ? ast.source.slice(use.importPath.start, use.importPath.end) : text.match(/from\s+(['"][^'"]+['"])/)?.[1] ?? '').replace(/^['"]|['"]$/g, '');
        if (!specifier) continue;
        const to = resolveImport(source, specifier);
        edges.push({ from: source, to, fromPackage: sourceOwners.get(source)!, toPackage: known.has(to) ? sourceOwners.get(to) : undefined, line: use.startPos.line + 1, column: use.startPos.column + 1, keyword: /^\s*reuse\b/.test(text) ? 'reuse' : 'use', specifier });
      }
    }
    return edges;
  };

  const normalize = (diag: Diagnostic, declarations: () => TableDeclaration[]): Diagnostic[] => {
    const path = diag.filepath?.replace(/^\//, '');
    const base: Diagnostic = { ...diag, severity: 'error', filepath: path, packageId: path ? sourceOwners.get(path) : undefined };
    if (diag.code === 3003) {
      const duplicated = /Table '([^']+)' already exists in schema '([^']+)'/.exec(diag.message);
      if (duplicated) {
        const id = `${duplicated[2]}.${duplicated[1]}`;
        const all = declarations().filter(d => d.tableId === id);
        if (all.length > 1) {
          const [first, ...rest] = all;
          return rest.map(d => ({ code: Codes.duplicateTable, severity: 'error', packageId: d.packageId, filepath: d.file, location: { start: { line: d.line, column: d.column } },
            message: `La tabla '${id}' ya está definida en ${first!.file}:${first!.line} (paquete ${first!.packageId}).`,
            suggestion: `Una tabla se define una sola vez. Elimina esta definición y usa \`use * from '${posix.relative(posix.dirname(d.file), first!.file.replace(/\.dbml$/, '')) || '.'}'\` para referenciarla, o cambia su nombre.` }));
        }
      }
    }
    if (diag.code === 4000 && path) {
      const missing = /^Table '([^']+)' does not exist in Schema '([^']+)'/.exec(diag.message);
      if (missing) {
        const [, name, schema] = missing as unknown as [string, string, string];
        const candidates = declarations().filter(d => d.tableId.endsWith(`.${name}`));
        const other = candidates.filter(d => d.tableId !== `${schema}.${name}`);
        const same = candidates.filter(d => d.tableId === `${schema}.${name}`);
        if (same.length === 1) {
          const target = same[0]!;
          const rel = posix.relative(posix.dirname(path), target.file.replace(/\.dbml$/, ''));
          return [{ ...base, code: Codes.missingImport, message: `La tabla '${name}' está definida en ${target.file} (paquete ${target.packageId}), pero este archivo no la importa.`, suggestion: `Añade \`use * from '${rel.startsWith('.') ? rel : `./${rel}`}'\` al inicio de ${path}.` }];
        }
        if (other.length > 1 || (other.length === 1 && schema !== other[0]!.tableId.split('.')[0])) {
          const options = other.map(d => d.tableId).join(', ');
          return [{ ...base, code: other.length > 1 ? Codes.ambiguousName : diag.code, message: other.length > 1 ? `El nombre '${name}' es ambiguo: existe como ${options}.` : diag.message, suggestion: `Califica la referencia con su esquema (${options}) e importa el archivo que la define.` }];
        }
        if (!candidates.length) return [{ ...base, suggestion: `No existe ninguna tabla llamada '${name}' en el proyecto. Comprueba el nombre o define la tabla en un paquete.` }];
      }
    }
    if (diag.code === 4000 || diag.code === 3002) return [{ ...base, suggestion: base.suggestion ?? 'Revisa que el elemento exista y que el archivo lo importe con `use`.' }];
    return [base];
  };

  let database: ReturnType<Parser['parseDbmlProject']>;
  try { database = parser.parseDbmlProject(ENTRY); }
  catch (error) {
    if (error && typeof error === 'object' && 'diags' in error && Array.isArray(error.diags)) {
      let cache: TableDeclaration[] | undefined;
      const declarations = () => cache ??= scanDeclarations();
      const diagnostics = (error.diags as Diagnostic[]).flatMap(d => normalize(d, declarations));
      // El compilador oficial informa los duplicados contra la entrada sintética; los reubicamos en el archivo real.
      throw new ProjectCompileError(diagnostics.filter((d, i) => diagnostics.findIndex(o => o.filepath === d.filepath && o.code === d.code && o.message === d.message && o.location?.start?.line === d.location?.start?.line) === i));
    }
    throw error;
  }

  const declarations = scanDeclarations();
  const owners = new Map<TableId, PackageId>();
  const declared = new Map<TableId, TableDeclaration>();
  for (const declaration of declarations) {
    if (owners.has(declaration.tableId)) {
      const first = declared.get(declaration.tableId)!;
      throw new ProjectCompileError([{ code: Codes.duplicateTable, severity: 'error', packageId: declaration.packageId, filepath: declaration.file, location: { start: { line: declaration.line, column: declaration.column } }, message: `La tabla '${declaration.tableId}' ya está definida en ${first.file}:${first.line}.`, suggestion: 'Una tabla se define una sola vez; usa `use` para referenciarla desde otros archivos.' }]);
    }
    owners.set(declaration.tableId, declaration.packageId);
    declared.set(declaration.tableId, declaration);
  }

  const imports = scanImports();
  const fileGraph = new Map<string, string[]>();
  for (const edge of imports) fileGraph.set(edge.from, [...(fileGraph.get(edge.from) ?? []), edge.to]);
  const warnings: Diagnostic[] = findCycles(sources, fileGraph).map(cycle => {
    const first = cycle[0]!;
    const edge = imports.find(e => e.from === first && cycle.includes(e.to))!;
    return { code: Codes.importCycle, severity: 'warning' as const, packageId: sourceOwners.get(first), filepath: first, location: { start: { line: edge.line, column: edge.column } },
      message: `Ciclo de importación entre archivos: ${[...cycle, first].join(' → ')}.`,
      suggestion: 'El compilador lo resuelve sin duplicar tablas, pero conviene mover las tablas compartidas a un archivo común que no importe a los demás.' };
  });

  return {
    database,
    schema: database.export(),
    owners,
    /** Dónde se declara cada tabla (archivo, línea y columna), útil para «ver definición». */
    declarations: declared,
    imports,
    warnings,
    sources,
    exportSql: (format: SqlDialect = 'postgres') => ModelExporter.export(database, format),
    /** DBML estándar aplanado en un solo documento, sin `use` ni estructura de paquetes: el esquema lógico completo. */
    exportDbml: () => ModelExporter.export(database, 'dbml'),
  };
}

export type CompiledProject = ReturnType<typeof compileProject>;
