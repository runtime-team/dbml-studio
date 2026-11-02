import { relative, sep } from 'node:path';
import type { CompiledProject } from './compiler';
import type { Project } from './loader';

export interface Definition { tableId: string; packageId: string; file: string; line: number; endLine: number; source: string }

/** Bloque `Table … { … }` completo a partir de su línea de declaración (llaves equilibradas, ignorando cadenas y comentarios). */
export function extractBlock(source: string, startLine: number, maxLines = 400): { text: string; endLine: number } {
  const lines = source.split(/\r?\n/);
  let depth = 0, opened = false, inBlockComment = false;
  const out: string[] = [];
  for (let i = startLine - 1; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i]!;
    out.push(line);
    let quote = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!, next = line[c + 1];
      if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; c++; } continue; }
      if (quote) { if (ch === '\\') c++; else if (ch === quote) quote = ''; continue; }
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') { inBlockComment = true; c++; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return { text: out.join('\n'), endLine: i + 1 };
  }
  return { text: out.join('\n'), endLine: startLine - 1 + out.length };
}

/** Localiza la definición original de una tabla lógica en las fuentes del proyecto. */
export function findDefinition(project: Project, compiled: Pick<CompiledProject, 'declarations'>, tableId: string): Definition | undefined {
  const declaration = compiled.declarations.get(tableId);
  if (!declaration) return undefined;
  for (const pkg of project.packages) for (const [file, content] of pkg.files) {
    if (relative(project.root, file).split(sep).join('/') !== declaration.file) continue;
    const block = extractBlock(content, declaration.line);
    return { tableId, packageId: declaration.packageId, file: declaration.file, line: declaration.line, endLine: block.endLine, source: block.text };
  }
  return undefined;
}
