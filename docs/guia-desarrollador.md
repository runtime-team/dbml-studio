# Guía de desarrollo

Requiere [Bun](https://bun.sh) 1.x.

```sh
bun install
bun test              # toda la suite
bunx tsc --noEmit     # tipos (también: bun run typecheck)
bun run build         # empaqueta la interfaz en dist/
bun run server        # API + WebSocket (+ interfaz de dist/ si existe)
bun run dev           # Vite en :5173 con proxy de /api y /ws a :3001
bun run dev:all       # inicia API y Vite juntos; Ctrl+C detiene ambos
```

## Estructura

| Ruta | Contenido |
|---|---|
| `src/project/` | `loader` (manifiesto), `compiler` (esquema lógico, diagnósticos), `dependencies`, `build` (caché incremental), `diagram-config` (parches), `export`, `definition`, `diagnostics`, `save` |
| `src/diagram/` | `model` (diagramas), `layout`, `svg`, `pdf`, `navigation` |
| `server.ts` | servidor HTTP, archivos estáticos y WebSocket; expone `/api/shared/*` |
| `src/collaboration/database.ts` | conexión y migraciones libSQL |
| `src/collaboration/` | `access`, `sessions`, `documents`, `diagram-state`, `comments`, `history`, `diff`, `audit`, `ratelimit`, `events`, `shared-build`, `services`, `api`, `socket`, `client`, `links` |
| `src/ui/` | `workspace` (pestañas, menús, inspector), `canvas`, `inspector`, `switcher`, `code-editor` (CodeMirror 6 y resaltado DBML), `shared`, `comments`, `history`, `sharing`, `editor`, `logic` |
| `scripts/` | `create-user`, `import-project` |
| `tests/` | ver más abajo |
| `docs/ejemplos/` | proyectos de ejemplo verificados por `tests/examples.test.ts` |

Convenciones: TypeScript estricto, mensajes y documentación en español, las funciones puras (layout, parches, enlaces, lógica de UI) separadas de los componentes para poder probarlas sin navegador.

## Variables de entorno

`LIBSQL_URL` (por defecto `file:.data/shared.sqlite`), `LIBSQL_AUTH_TOKEN` (base remota), `PORT` (3001), `DBML_SHARED_DB` (ruta alternativa de base libSQL local), `DBML_ALLOWED_ORIGINS`, `DBML_ALLOW_REGISTRATION` (por defecto habilitado; use `0` para deshabilitar) y `DBML_HOST` (por defecto `0.0.0.0`).
## Pruebas

| Archivo | Cubre |
|---|---|
| `compiler`, `diagnostics`, `projects`, `loader` | proyectos de un archivo y de varios, paquetes con varios archivos, importaciones válidas e inválidas, ambigüedad, duplicados, ciclos, manifiesto |
| `tableref`, `diagram` | TableRef Full/Compact/Connector, varias instancias visuales, relaciones múltiples, cardinalidades, grafo de dependencias |
| `layout`, `svg`, `pdf` | layout determinista y sin solapes, posiciones persistidas, escala (400 tablas), SVG/PDF, referencias de conectores |
| `navigation` | navegación entre paquetes e inversa, historial, selector rápido, enlaces directos |
| `build` | caché e incrementalidad, última versión válida, SQL sin duplicados, determinismo, compatibilidad con DBML estándar, parches |
| `local-api` | módulos de compatibilidad de archivos, importación y exportación; no se montan en el servidor web |
| `examples` | todos los ejemplos documentados y un proyecto de 400 tablas |
| `comments-history`, `acceptance`, `security` | comentarios, historial, los 12 criterios de la Fase 8 con WebSocket real, autorización y límites |
| `access`, `sessions`, `socket`, `reconnect`, `shared-api`, `collaboration` | componentes de colaboración |
| `ui.test.tsx` | lógica de UI y render de componentes con ARIA |

Las pruebas de WebSocket levantan servidores reales en puertos efímeros. La prueba de enlaces simbólicos se omite si el sistema no permite crearlos (Windows sin privilegios).

## API HTTP

### Persistencia

El servidor no expone rutas HTTP para leer o escribir proyectos en carpetas. Las cuentas, proyectos, documentos, configuraciones, comentarios, historial y sesiones se guardan mediante libSQL. Los comandos CLI `check`, `export` e `import-project` siguen aceptando manifiestos de archivo como entrada.
### Modo compartido (`/api/shared/…`)

Identidad: `Authorization: Bearer <sesión>` es obligatorio; `x-share-token: <enlace>` agrega acceso compartido a una cuenta autenticada. Errores: `{ "error": "…" }` con 400/401/403/404/409/413/415/429/500.

| Ruta | Permiso | Descripción |
|---|---|---|
| `GET config` · `POST login` · `POST register` · `POST logout` · `GET me` | — | cuentas y sesión; el registro recibe `username`, `password` y `confirmPassword` |
| `GET projects` · `POST projects` | sesión | mis proyectos / crear |
| `GET projects/:id` | leer | datos del proyecto, rol, documentos |
| `POST projects/:id/rename` | admin | renombrar |
| `POST projects/:id/packages/:package/rename` | editar | `{ packageId }`; actualiza documentos, importaciones relativas, diagramas y comentarios |
| `GET projects/:id/diagrams` | leer | `{ ok, stale, diagrams, diagnostics, graph, changedPackages }` |
| `POST projects/:id/diagram` | editar | `{ packageId, patch }`; versión por paquete |
| `GET projects/:id/definition?table=` | leer | definición de tabla |
| `POST projects/:id/documents` · `GET …/documents/:doc` · `POST …/documents/:doc/delete` | editar / leer / editar | archivos |
| `GET/POST projects/:id/links` · `POST …/links/:link/revoke` | admin | enlaces |
| `GET/POST projects/:id/members` · `POST …/members/:user/remove` | admin | miembros (`username` o `userId`, `role`) |
| `GET projects/:id/audit` | admin | registro administrativo |
| `GET/POST projects/:id/comments` · `POST …/:c/resolve\|edit\|delete` | leer / comentar | comentarios |
| `GET/POST projects/:id/revisions` · `GET …/:r` · `GET …/:r/diff?against=` · `POST …/:r/restore` | leer / editar | versiones |
| `GET projects/:id/export/<…>` | leer | exportación |

### WebSocket (`/ws`)

El primer mensaje debe ser `{ type: 'open', projectId, documentId?, sessionToken, linkToken? }`; se requiere una sesión de usuario. Con `documentId` se sincroniza el texto (`state`, `update`, `presence`); sin él es un canal del proyecto. El servidor envía `state`, `ready`, `hello` (con `peerId`), `presence`, `project-changed` y `event` (`diagram-changed`, `comments-changed`, `package-renamed`, `history-changed`, `documents-changed`). Los errores llegan como `{ type: 'error', message }`.

## Cómo añadir…

- **Un diagnóstico**: añade el código en `Codes` (`diagnostics.ts`), emítelo con archivo, línea y `suggestion`, documenta el código en la [referencia](referencia-sintaxis.md) y cubre el caso en `diagnostics.test.ts`.
- **Un tipo de objetivo de comentario**: `TARGET_TYPES` en `comments.ts`, `targetExists` y las etiquetas en `src/ui/comments.tsx`.
- **Una acción de menú**: `nodeMenu` / `packageMenu` en `workspace.tsx`; las que modifican el diagrama deben usar `props.editable` para deshabilitarse.
- **Un campo del parche visual**: `validatePatch` y `applyDiagramPatch` en `diagram-config.ts` (validación estricta: el parche llega de clientes no confiables) y `serializeDiagramConfig`.

## Notas operativas

- El servidor escucha en `0.0.0.0` por defecto, apto para contenedores. Para exponerlo hace falta TLS delante (proxy inverso), `DBML_ALLOWED_ORIGINS` y revisar los límites de [§18.9 del manual](manual-usuario.md#189-seguridad-y-límites).
- La capa de persistencia usa `@libsql/client`; `LIBSQL_URL` selecciona un archivo local o una base remota. Las migraciones aditivas se ejecutan antes de iniciar el servidor.
- Los procesos que cargan `@dbml/core` deben terminar con `process.exit` (deja un manejador abierto).
- En este repositorio, `.gitignore` excluye `.data/`, `dist/` y `output/`.
