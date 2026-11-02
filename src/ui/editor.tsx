import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { PresenceMember } from '../collaboration/client';
import { colorFor } from './logic';

/** Traslada un índice de texto a través de un delta de Yjs (retain/insert/delete). */
export function transformIndex(index: number, delta: { retain?: number; insert?: string | object; delete?: number }[]): number {
  let position = 0, result = index;
  for (const op of delta) {
    if (op.retain) { position += op.retain; continue; }
    if (op.insert !== undefined) { const length = typeof op.insert === 'string' ? op.insert.length : 1; if (position <= index) result += length; position += length; continue; }
    if (op.delete) { if (position < index) result -= Math.min(op.delete, index - position); }
  }
  return Math.max(0, result);
}

interface Remote { key: string; name: string; color: string; anchor: number; head: number }

/** Dibuja cursores y selecciones remotos sobre una capa idéntica al textarea (mismas métricas), detrás de él. */
function Mirror({ text, remotes, scroll }: { text: string; remotes: Remote[]; scroll: { top: number; left: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (ref.current) { ref.current.scrollTop = scroll.top; ref.current.scrollLeft = scroll.left; } }, [scroll.top, scroll.left, text]);
  const pieces = useMemo(() => {
    const bounds = new Set<number>([0, text.length]);
    for (const r of remotes) { bounds.add(Math.min(r.anchor, text.length)); bounds.add(Math.min(r.head, text.length)); }
    const cuts = [...bounds].sort((a, b) => a - b);
    return cuts.slice(0, -1).map((start, i) => ({ start, end: cuts[i + 1]!, text: text.slice(start, cuts[i + 1]) }));
  }, [text, remotes]);
  return <div className="editor-mirror" ref={ref} aria-hidden="true">
    {pieces.map(piece => {
      const covering = remotes.filter(r => Math.min(r.anchor, r.head) <= piece.start && Math.max(r.anchor, r.head) >= piece.end && r.anchor !== r.head);
      const carets = remotes.filter(r => Math.min(r.head, text.length) === piece.start);
      return <Fragment key={piece.start}>
        {carets.map(r => <span key={r.key} className="remote-caret" style={{ borderColor: r.color }}><span style={{ background: r.color }}>{r.name}</span></span>)}
        <span style={covering.length ? { background: `${covering[0]!.color}33` } : undefined}>{piece.text}</span>
      </Fragment>;
    })}
    {remotes.filter(r => Math.min(r.head, text.length) === text.length).map(r => <span key={`end-${r.key}`} className="remote-caret" style={{ borderColor: r.color }}><span style={{ background: r.color }}>{r.name}</span></span>)}
    {'\n'}
  </div>;
}

/**
 * Editor de texto colaborativo sobre un `Y.Text`: conserva el cursor local al llegar cambios remotos
 * y muestra los cursores y selecciones de las demás conexiones del mismo archivo.
 */
export function CollabEditor({ doc, editable, members, selfPeerId, documentId, onSelection, label }: {
  doc: Y.Doc; editable: boolean; members: PresenceMember[]; selfPeerId?: string; documentId: string; onSelection(anchor: number, head: number, rel?: { anchor: unknown; head: unknown }): void; label: string;
}) {
  const ytext = useMemo(() => doc.getText('source'), [doc]);
  const [text, setText] = useState(() => ytext.toString());
  const area = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<{ start: number; end: number } | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });

  useEffect(() => {
    setText(ytext.toString());
    const observer = (event: Y.YTextEvent) => {
      const el = area.current;
      // Solo los cambios remotos desplazan el cursor; los locales ya lo dejaron en su sitio.
      if (el && !event.transaction.local && document.activeElement === el) {
        const delta = event.delta as { retain?: number; insert?: string | object; delete?: number }[];
        pending.current = { start: transformIndex(el.selectionStart, delta), end: transformIndex(el.selectionEnd, delta) };
      }
      setText(ytext.toString());
    };
    ytext.observe(observer);
    return () => ytext.unobserve(observer);
  }, [ytext]);
  useLayoutEffect(() => { if (pending.current && area.current) { area.current.setSelectionRange(pending.current.start, pending.current.end); pending.current = null; } }, [text]);

  const change = (value: string) => {
    const previous = ytext.toString();
    let start = 0; while (start < previous.length && start < value.length && previous[start] === value[start]) start++;
    let end = 0; while (end < previous.length - start && end < value.length - start && previous[previous.length - 1 - end] === value[value.length - 1 - end]) end++;
    doc.transact(() => { ytext.delete(start, previous.length - start - end); ytext.insert(start, value.slice(start, value.length - end)); });
  };

  const lastSent = useRef(0);
  const report = () => {
    const el = area.current; if (!el) return;
    const now = Date.now();
    if (now - lastSent.current < 80) return;
    lastSent.current = now;
    // Posiciones relativas: ancladas al carácter, no al desplazamiento, para que sigan correctas cuando otros editan.
    const relative = (index: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index));
    onSelection(el.selectionStart, el.selectionEnd, { anchor: relative(el.selectionStart), head: relative(el.selectionEnd) });
  };
  const remotes: Remote[] = members.filter(m => m.documentId === documentId && m.selection && m.peerId !== selfPeerId).slice(0, 8)
    .map((m, i) => {
      // Se prefieren las posiciones relativas, resueltas contra nuestro propio documento; si faltan, los desplazamientos absolutos.
      const resolve = (rel: unknown, fallback: number) => {
        try { const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), doc); return abs && abs.type === ytext ? abs.index : fallback; } catch { return fallback; }
      };
      const sel = m.selection!;
      return { key: m.peerId ?? String(i), name: m.name ?? 'Invitado', color: colorFor(m.userId ?? m.peerId), anchor: sel.rel ? resolve(sel.rel.anchor, sel.anchor) : sel.anchor, head: sel.rel ? resolve(sel.rel.head, sel.head) : sel.head };
    });

  return <div className="collab-editor">
    <Mirror text={text} remotes={remotes} scroll={scroll}/>
    <textarea ref={area} value={text} readOnly={!editable} spellCheck={false} aria-label={label} onChange={e => change(e.target.value)}
      onSelect={report} onKeyUp={report} onClick={report} onScroll={e => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}/>
  </div>;
}
