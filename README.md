# DBML Studio

Organiza esquemas DBML grandes en **proyectos**, **paquetes** y **diagramas interconectados**, con vistas externas, navegación, exportación SVG/PDF/SQL y colaboración en tiempo real. Proyectos, documentos y cuentas se almacenan en libSQL; la interfaz web no necesita carpetas de proyectos locales.

```sh
bun install
bun run index.ts check  docs/ejemplos/multiples-paquetes/dbml.project.yaml
bun run index.ts export docs/ejemplos/multiples-paquetes/dbml.project.yaml

bun run build && bun run server     # http://localhost:3001
# o, en desarrollo: bun run dev:all  (http://127.0.0.1:5173)
```

Al iniciar, crea una cuenta con usuario y contraseña, luego crea proyectos desde *Mis proyectos*. El registro está habilitado por defecto; `DBML_ALLOW_REGISTRATION=0` lo deshabilita. Las contraseñas se guardan con Argon2id.

Configura `LIBSQL_URL` y, para bases remotas, `LIBSQL_AUTH_TOKEN`. Por defecto se usa una base libSQL local en `.data/shared.sqlite`; al contenerizar, monta `.data` como volumen persistente o conecta el servidor a una URL remota. El servidor escucha en `0.0.0.0` y usa `PORT` (3001).

La CLI sigue aceptando manifiestos DBML en disco para `check` y `export`. La interfaz web no lee ni escribe esas carpetas: guarda documentos, diagramas, cuentas y permisos en libSQL.

La documentación web usa VitePress. `bun run dev:all` la sirve en `http://127.0.0.1:5173/docs/`; para trabajar solo en los documentos usa `bun run docs:dev` y abre `http://127.0.0.1:5174/docs/`. `bun run build` genera tanto la aplicación como el sitio de documentación.

## Documentación

- [Manual de usuario](docs/manual-usuario.md) — proyectos, paquetes, TableRef, conectores, navegación, exportación y colaboración.
- [Referencia de sintaxis](docs/referencia-sintaxis.md) — manifiesto, `diagram.yaml`, identificadores y códigos de diagnóstico.
- [Arquitectura](docs/arquitectura.md) — decisiones, flujo de compilación, riesgos y límites.
- [Guía de desarrollo](docs/guia-desarrollador.md) — estructura, pruebas y API.
- [Ejemplos](docs/ejemplos/README.md) — proyectos completos verificados automáticamente.

## Estado

- Las pruebas (`bun test`) cubren compilación, diagramas, exportación, API local y compartida, WebSocket real y render de componentes; `bunx tsc --noEmit` y `bun run build` pasan.
- La interfaz no se ha revisado manualmente en un navegador real: se recomienda una pasada visual antes de usarla en producción.
- La colaboración es un servidor de un solo proceso. Expón la aplicación a internet detrás de un proxy inverso con TLS (ver el [manual](docs/manual-usuario.md#189-seguridad-y-límites)).
