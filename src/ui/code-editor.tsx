import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { Annotation, EditorState } from '@codemirror/state';
import { indentUnit, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { EditorView, keymap } from '@codemirror/view';
import { useEffect, useRef } from 'react';

interface Props {
  value: string;
  ariaLabel: string;
  focusLineRequest?: { fileKey: string; line: number; nonce: number };
  onChange(value: string): void;
}

interface DbmlState { blockComment: boolean }

const keywords = new Set(['table', 'enum', 'tablegroup', 'ref', 'project', 'use', 'indexes', 'index', 'note', 'setting', 'settings', 'as']);
const properties = new Set(['pk', 'primary', 'key', 'not', 'null', 'unique', 'increment', 'default', 'ref', 'note', 'name', 'type', 'delete', 'update', 'cascade', 'restrict', 'set', 'no', 'action']);
const types = new Set(['int', 'integer', 'smallint', 'bigint', 'serial', 'varchar', 'char', 'text', 'boolean', 'bool', 'date', 'datetime', 'timestamp', 'decimal', 'numeric', 'float', 'double', 'real', 'json', 'jsonb', 'uuid', 'blob', 'binary', 'enum']);

const dbml = new LanguageSupport(StreamLanguage.define<DbmlState>({
  startState: () => ({ blockComment: false }),
  token(stream, state) {
    if (state.blockComment) {
      const end = stream.string.indexOf('*/', stream.pos);
      if (end < 0) stream.skipToEnd();
      else { stream.pos = end + 2; state.blockComment = false; }
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//') || stream.match('--')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) {
      state.blockComment = true;
      const end = stream.string.indexOf('*/', stream.pos);
      if (end >= 0) { stream.pos = end + 2; state.blockComment = false; }
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/`(?:[^`\\]|\\.)*`?/)) return 'string';
    if (stream.match(/\b\d+(?:\.\d+)?\b/)) return 'number';
    if (stream.match(/[<>!=~]+/)) return 'operator';
    if (stream.match(/[{}()[\],.:;]/)) return 'punctuation';
    if (stream.match(/[A-Za-z_][\w$]*/)) {
      const word = stream.current().toLowerCase();
      if (keywords.has(word)) return 'keyword';
      if (word === 'true' || word === 'false' || word === 'null') return 'bool';
      if (properties.has(word)) return 'propertyName';
      if (types.has(word)) return 'typeName';
    }
    stream.next();
    return null;
  },
}));

const externalChange = Annotation.define<boolean>();
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', color: '#1e3128', backgroundColor: '#fff' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Courier New", monospace', lineHeight: '1.55' },
  '.cm-content': { padding: '12px 0', caretColor: '#168a6b' },
  '.cm-gutters': { backgroundColor: '#f7faf8', color: '#71847a', borderRight: '1px solid #e6eee9' },
  '.cm-activeLineGutter': { backgroundColor: '#edf5f0' },
  '.cm-activeLine': { backgroundColor: '#f8fbf9' },
  '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#b9dccb' },
}, { dark: false });

export function CodeEditor({ value, ariaLabel, focusLineRequest, onChange }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const parent = mount.current;
    if (!parent) return;
    const editor = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [keymap.of([indentWithTab]), basicSetup, dbml, indentUnit.of('  '), EditorState.tabSize.of(2), EditorView.lineWrapping, editorTheme, EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }), EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) onChangeRef.current(update.state.doc.toString());
        })],
      }),
      parent,
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = undefined; };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: externalChange.of(true) });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !focusLineRequest) return;
    const target = editor.state.doc.line(Math.min(Math.max(Math.floor(focusLineRequest.line), 1), editor.state.doc.lines));
    editor.dispatch({ selection: { anchor: target.from, head: target.to }, scrollIntoView: true });
    editor.focus();
  }, [focusLineRequest]);

  return <div className="dbml-codemirror" ref={mount} />;
}
