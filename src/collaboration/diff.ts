export interface DiffLine { type: 'same' | 'add' | 'del'; text: string }

const MAX_CELLS = 4_000_000;

/**
 * Diferencia por líneas (LCS). Se recortan prefijo y sufijo comunes y la parte central usa programación
 * dinámica; si fuera demasiado grande se informa como reemplazo completo en lugar de agotar memoria.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n'), b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = a.slice(0, start).map(text => ({ type: 'same' as const, text }));
  const tail = a.slice(a.length - end).map(text => ({ type: 'same' as const, text }));
  const x = a.slice(start, a.length - end), y = b.slice(start, b.length - end);
  if (!x.length || !y.length || x.length * y.length > MAX_CELLS) {
    return [...head, ...x.map(text => ({ type: 'del' as const, text })), ...y.map(text => ({ type: 'add' as const, text })), ...tail];
  }
  const width = y.length + 1;
  const table = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
    table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const middle: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { middle.push({ type: 'same', text: x[i]! }); i++; j++; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) middle.push({ type: 'del', text: x[i++]! });
    else middle.push({ type: 'add', text: y[j++]! });
  }
  while (i < x.length) middle.push({ type: 'del', text: x[i++]! });
  while (j < y.length) middle.push({ type: 'add', text: y[j++]! });
  return [...head, ...middle, ...tail];
}

export interface Hunk { oldStart: number; newStart: number; lines: DiffLine[] }

/** Agrupa los cambios con `context` líneas alrededor para mostrar solo lo relevante. */
export function toHunks(lines: DiffLine[], context = 2): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLine = 1, newLine = 1, current: Hunk | undefined, trailing = 0;
  const pending: { line: DiffLine; old: number; neu: number }[] = [];
  for (const line of lines) {
    if (line.type === 'same') {
      if (current && trailing < context) { current.lines.push(line); trailing++; }
      else {
        // Contexto previo del siguiente cambio: solo líneas que no pertenecen ya a un bloque.
        current = undefined;
        pending.push({ line, old: oldLine, neu: newLine });
        if (pending.length > context) pending.shift();
      }
      oldLine++; newLine++;
    } else {
      if (!current) {
        const lead = pending.splice(0);
        current = { oldStart: lead[0]?.old ?? oldLine, newStart: lead[0]?.neu ?? newLine, lines: lead.map(p => p.line) };
        hunks.push(current);
      }
      trailing = 0;
      current.lines.push(line);
      if (line.type === 'del') oldLine++; else newLine++;
    }
  }
  return hunks;
}
