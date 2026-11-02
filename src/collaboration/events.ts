/** Eventos de proyecto que el transporte en tiempo real reenvía a los participantes autorizados. */
export type ProjectEvent =
  | { type: 'doc-updated'; documentId: string; state: Uint8Array }
  | { type: 'doc-edited'; documentId: string; userId?: string }
  | { type: 'documents-changed' }
  | { type: 'diagram-changed'; packageId: string; version: number }
  | { type: 'comments-changed' }
  | { type: 'package-renamed'; from: string; to: string }
  | { type: 'history-changed'; revisionId?: string }
  | { type: 'access-changed' };

type Listener = (projectId: string, event: ProjectEvent) => void;

/** Bus en proceso. Los fallos de un oyente nunca interrumpen la operación que emitió el evento. */
export class ProjectEvents {
  private listeners = new Set<Listener>();
  on(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(projectId: string, event: ProjectEvent): void {
    for (const listener of this.listeners) { try { listener(projectId, event); } catch (error) { console.error('Error en oyente de eventos:', error); } }
  }
}
