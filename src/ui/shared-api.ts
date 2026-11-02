import type { Diagram } from '../diagram/model';
import type { Diagnostic } from '../project/diagnostics';
import type { DependencyGraph } from '../project/dependencies';
import type { DiagramPatch } from '../project/diagram-config';
import { downloadResponse } from './download';

export interface SharedInfo {
  id: string; name: string; role?: 'owner' | 'editor' | 'commenter' | 'viewer'; editable: boolean; commentable: boolean; admin: boolean;
  documents: { id: string; packageId: string; name: string }[];
}
export interface BuildPayload { ok: boolean; stale: boolean; diagrams: Diagram[]; diagnostics: Diagnostic[]; graph: DependencyGraph | null; changedPackages: string[] }
export interface CommentView { id: string; authorId: string | null; authorName: string | null; body: string; createdAt: number; editedAt: number | null }
export interface ThreadView { id: string; targetType: 'project' | 'package' | 'table' | 'column' | 'relationship' | 'connector'; targetId: string; packageId: string | null; resolved: boolean; resolvedBy: string | null; resolvedAt: number | null; createdAt: number; comments: CommentView[] }
export interface RevisionRow { id: string; seq: number; kind: 'edit' | 'manual' | 'restore'; authorId: string | null; authorName?: string | null; authorNames?: string[]; authors: string[]; message: string; createdAt: number; affectedPackages: string[]; restoredFrom: string | null }
export interface DiffLine { type: 'same' | 'add' | 'del'; text: string }
export interface RevisionDiff {
  from: string; to: string; affectedPackages: string[];
  files: { packageId: string; name: string; status: 'added' | 'removed' | 'modified'; added: number; removed: number; hunks: { oldStart: number; newStart: number; lines: DiffLine[] }[] }[];
  diagrams: { packageId: string; movedNodes: number; viewsChanged: boolean }[];
}

/** Cliente HTTP de la API compartida. La identidad viaja en cabeceras, nunca en la URL. */
export class SharedClient {
  constructor(public token: string, public linkToken?: string) {}
  headers(json = false): Record<string, string> {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(this.linkToken ? { 'x-share-token': this.linkToken } : {}), ...(json ? { 'content-type': 'application/json' } : {}) };
  }
  async request<T = unknown>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/shared/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: this.headers(body !== undefined), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data: unknown = {};
    try { data = await response.json(); } catch { /* respuesta sin cuerpo */ }
    if (!response.ok) { const error = new Error((data as { error?: string }).error ?? `Error ${response.status}`) as Error & { status: number }; error.status = response.status; throw error; }
    return data as T;
  }
  project = (id: string) => `projects/${encodeURIComponent(id)}`;
  info = (id: string) => this.request<SharedInfo>(this.project(id));
  build = (id: string) => this.request<BuildPayload>(`${this.project(id)}/diagrams`);
  patch = (id: string, packageId: string, patch: DiagramPatch) => this.request<{ version: number }>(`${this.project(id)}/diagram`, { packageId, patch });
  definition = (id: string, table: string) => this.request<import('./inspector').Definition>(`${this.project(id)}/definition?table=${encodeURIComponent(table)}`);
  async download(id: string, name: string, params: Record<string, string> = {}) {
    const query = new URLSearchParams(params).toString();
    await downloadResponse(await fetch(`/api/shared/${this.project(id)}/export/${encodeURIComponent(name)}${query ? `?${query}` : ''}`, { headers: this.headers() }), name);
  }
}
