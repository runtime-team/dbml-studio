import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
const bun = process.execPath;
const apiPort = Number(process.env.PORT ?? '3001');
const docsPort = Number(process.env.DBML_DOCS_PORT ?? '5174');

if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  throw new Error(`PORT debe ser un número entre 1 y 65535; recibido: ${process.env.PORT}`);
}

const childEnv = { ...process.env, PORT: String(apiPort) };
if (!Number.isInteger(docsPort) || docsPort < 1 || docsPort > 65535 || docsPort === apiPort || docsPort === 5173) {
  throw new Error(`DBML_DOCS_PORT debe ser un puerto valido y distinto de ${apiPort} y 5173; recibido: ${process.env.DBML_DOCS_PORT}`);
}

console.log('Iniciando DBML Studio en modo desarrollo…');
console.log(`API y WebSocket: http://127.0.0.1:${apiPort}`);
console.log('Interfaz:         http://127.0.0.1:5173');
console.log(`Documentacion:    http://127.0.0.1:5173/docs/ (VitePress :${docsPort})`);
console.log('Presiona Ctrl+C para detener los tres servicios.');

const children: { name: string; process: ReturnType<typeof Bun.spawn> }[] = [];
let shuttingDown = false;
let interrupted = false;

const stopChildren = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child.process.exitCode === null) child.process.kill(signal);
};

process.on('SIGINT', () => { interrupted = true; stopChildren('SIGINT'); });
process.on('SIGTERM', () => { interrupted = true; stopChildren('SIGTERM'); });

try {
  children.push({
    name: 'API',
    process: Bun.spawn([bun, 'server.ts'], {
      cwd: projectRoot,
      env: childEnv,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      windowsHide: true,
    }),
  });
  children.push({
    name: 'Vite',
    process: Bun.spawn([bun, resolve(projectRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
      cwd: projectRoot,
      env: childEnv,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      windowsHide: true,
    }),
  });
  children.push({
    name: 'Docs',
    process: Bun.spawn([bun, resolve(projectRoot, 'node_modules/vitepress/bin/vitepress.js'), 'dev', 'docs', '--host', '127.0.0.1', '--port', String(docsPort), '--strictPort'], {
      cwd: projectRoot,
      env: childEnv,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      windowsHide: true,
    }),
  });
} catch (error) {
  stopChildren('SIGTERM');
  await Promise.all(children.map((child) => child.process.exited));
  throw error;
}

const firstExit = await Promise.race(children.map(async (child) => ({ name: child.name, code: await child.process.exited })));
if (!shuttingDown) {
  console.error(`${firstExit.name} terminó (código ${firstExit.code}); cerrando el otro servicio.`);
  const port = firstExit.name === 'API' ? apiPort : firstExit.name === 'Docs' ? docsPort : 5173;
  console.error(`El puerto :${port} ya está ocupado o el servicio falló al iniciar. Cierra esa instancia y vuelve a ejecutar bun run dev:all.`);
  stopChildren('SIGTERM');
}
await Promise.all(children.map((child) => child.process.exited));
process.exitCode = interrupted ? 130 : firstExit.code;
