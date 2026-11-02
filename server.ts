import { existsSync, statSync } from 'node:fs';
import { resolve, extname, normalize, sep } from 'node:path';
import { createServices } from './src/collaboration/services';
import { createSharedApi } from './src/collaboration/api';
import { createCollaborationSocket } from './src/collaboration/socket';
import { LibsqlDatabase } from './src/collaboration/database';

const port = Number(process.env.PORT ?? 3001);
const db = LibsqlDatabase.fromEnvironment();

const services = await createServices(db, { registration: process.env.DBML_ALLOW_REGISTRATION !== '0' });
const sharedApi = await createSharedApi(services.access, services.sessions, services.documents, services);

// Orígenes que pueden abrir el WebSocket: la interfaz de desarrollo (Vite), este servidor y los que se añadan por entorno.
const extraOrigins = (process.env.DBML_ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean);
const origins = ['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...extraOrigins];
// El WebSocket comparte puerto con la API y la interfaz (/ws): así funciona igual en producción y detrás de un proxy.
const socket = createCollaborationSocket({ access: services.access, sessions: services.sessions, documents: services.documents, events: services.events, origins });

const dist = resolve('dist');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/** Sirve la interfaz compilada (`bun run build`) con respaldo SPA para rutas como /projects/<id>/packages/<paquete>. */
async function serveStatic(pathname: string): Promise<Response> {
  const requested = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = resolve(dist, requested);
  if (file !== dist && !file.startsWith(dist + sep)) return new Response('Acceso denegado', { status: 403 });
  const candidates = requested ? [file, resolve(file, 'index.html'), `${file}.html`] : [resolve(dist, 'index.html')];
  const target = candidates.find(candidate => candidate.startsWith(dist + sep) && existsSync(candidate) && statSync(candidate).isFile()) ?? resolve(dist, 'index.html');
  if (!existsSync(target)) return new Response('Interfaz no compilada: ejecuta `bun run build` o usa `bun run dev`.', { status: 404 });
  return new Response(Bun.file(target), { headers: { 'content-type': types[extname(target)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'" } });
}

const server = Bun.serve({
  hostname: process.env.DBML_HOST ?? '0.0.0.0',
  port,
  websocket: socket.websocket,
  async fetch(request, instance) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return socket.handleUpgrade(request, instance);
    if (url.pathname.startsWith('/api/shared/')) return sharedApi(request, instance.requestIP(request)?.address ?? 'local');
    if (url.pathname.startsWith('/api/')) return new Response('No encontrado', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Método no permitido', { status: 405 });
    return serveStatic(url.pathname);
  },
});

// Las ediciones pendientes se registran como revisión antes de salir.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await services.history.flushAll(); }
  finally { server.stop(true); await db.close(); process.exit(0); }
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
console.log(`DBML Studio: http://localhost:${port} (interfaz, API y WebSocket en /ws)`);
