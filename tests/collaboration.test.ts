import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as Y from 'yjs';
import { AccessStore } from '../src/collaboration/access';
import { SharedDocuments } from '../src/collaboration/documents';

test('fusiona ediciones concurrentes, persiste y rechaza escrituras de lectores', () => {
  const db = new Database(':memory:');
  try {
    const access = new AccessStore(db), project = access.createProject('owner');
    access.setMember(project, 'owner', 'editor', 'editor');
    access.setMember(project, 'owner', 'viewer', 'viewer');
    const store = new SharedDocuments(db, access);
    const id = store.create(project, { userId: 'owner' }, 'ventas', 'ventas.dbml', 'abc');
    const initial = store.read(project, id, { userId: 'viewer' });
    const a = new Y.Doc(), b = new Y.Doc(); Y.applyUpdate(a, initial); Y.applyUpdate(b, initial);
    const vector = Y.encodeStateVector(a);
    a.getText('source').insert(1, 'X'); b.getText('source').insert(2, 'Y');
    const updateA = Y.encodeStateAsUpdate(a, vector), updateB = Y.encodeStateAsUpdate(b, vector);
    expect(() => store.apply(project, id, { userId: 'viewer' }, updateA)).toThrow('Acceso denegado');
    store.apply(project, id, { userId: 'owner' }, updateA);
    store.apply(project, id, { userId: 'editor' }, updateB);
    const restored = new Y.Doc(); Y.applyUpdate(restored, new SharedDocuments(db, access).read(project, id, { userId: 'viewer' }));
    expect(restored.getText('source').toString()).toBe('aXbYc');
    expect(() => store.read('another', id, { userId: 'owner' })).toThrow('Acceso denegado');
    a.destroy(); b.destroy(); restored.destroy();
  } finally { db.close(); }
});
