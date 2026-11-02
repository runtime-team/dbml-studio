import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AccessStore } from '../src/collaboration/access';

test('permisos de proyecto y enlaces revocables se aplican por rol', () => {
  const db = new Database(':memory:');
  try {
    const access = new AccessStore(db), project = access.createProject('owner');
    access.setMember(project, 'owner', 'commenter', 'commenter');
    expect(access.can(project, 'commenter', 'comment')).toBe(true);
    expect(access.can(project, 'commenter', 'edit')).toBe(false);
    expect(() => access.setMember(project, 'commenter', 'other', 'editor')).toThrow('Acceso denegado');
    const view = access.createLink(project, 'owner', 'view');
    expect(access.can(project, undefined, 'read', view.token)).toBe(true);
    expect(access.can(project, undefined, 'edit', view.token)).toBe(false);
    const edit = access.createLink(project, 'owner', 'edit');
    expect(access.can(project, undefined, 'edit', edit.token)).toBe(false);
    expect(access.can(project, 'authenticated', 'edit', edit.token)).toBe(true);
    access.revokeLink(project, 'owner', edit.id);
    expect(access.can(project, 'authenticated', 'edit', edit.token)).toBe(false);
    const restricted = access.createLink(project, 'owner', 'restricted');
    expect(access.can(project, 'stranger', 'read', restricted.token)).toBe(false);
    expect(access.can(project, 'commenter', 'read', restricted.token)).toBe(true);
    expect(access.can('another-project', 'commenter', 'read', view.token)).toBe(false);
  } finally { db.close(); }
});
