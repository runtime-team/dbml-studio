/** Enlaces estables a proyectos, paquetes, tablas y conectores. Solo usan identificadores lógicos, nunca posiciones ni archivos. */
export interface ProjectLocation { projectId: string; packageId?: string; tableId?: string; connectorId?: string }

export function buildProjectPath(location: ProjectLocation): string {
  let path = `/projects/${encodeURIComponent(location.projectId)}`;
  if (location.packageId) path += `/packages/${encodeURIComponent(location.packageId)}`;
  const query = new URLSearchParams();
  if (location.tableId) query.set('table', location.tableId);
  if (location.connectorId) query.set('connector', location.connectorId);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export function parseProjectPath(pathname: string, search = ''): ProjectLocation | undefined {
  const match = /^\/projects\/([^/]+)(?:\/packages\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return undefined;
  const decode = (value: string | undefined) => { try { return value === undefined ? undefined : decodeURIComponent(value); } catch { return undefined; } };
  const params = new URLSearchParams(search);
  const projectId = decode(match[1]);
  if (!projectId) return undefined;
  return { projectId, packageId: decode(match[2]) || undefined, tableId: params.get('table') || undefined, connectorId: params.get('connector') || undefined };
}

/** Enlace de acceso: el secreto viaja en el fragmento (`#share=`), que el navegador no envía al servidor ni a otros sitios. */
export function withShareToken(url: string, token: string): string { return `${url.split('#')[0]}#share=${encodeURIComponent(token)}`; }
export function readShareToken(hash: string): string | undefined { return new URLSearchParams(hash.replace(/^#/, '')).get('share') ?? undefined; }
