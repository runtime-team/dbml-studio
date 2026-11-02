# Manual de usuario de DBML Studio

DBML Studio organiza esquemas [DBML](https://dbml.dbdiagram.io/docs/) grandes en **proyectos**, **paquetes** y **diagramas interconectados**, y permite trabajar sobre ellos en equipo. Este manual describe únicamente funciones que existen y están cubiertas por las pruebas automáticas; los ejemplos de `docs/ejemplos/` se compilan en cada ejecución de la suite.

## Índice

1. [Introducción](#1-introducción)
2. [Instalación y ejecución](#2-instalación-y-ejecución)
3. [Creación de proyectos](#3-creación-de-proyectos)
4. [Configuración del manifiesto](#4-configuración-del-manifiesto)
5. [Creación de paquetes](#5-creación-de-paquetes)
6. [Organización de archivos DBML](#6-organización-de-archivos-dbml)
7. [Relaciones entre paquetes](#7-relaciones-entre-paquetes)
8. [TableRef: tablas externas](#8-tableref-tablas-externas)
9. [Modos Full, Compact y Connector](#9-modos-full-compact-y-connector)
10. [Conectores entre diagramas](#10-conectores-entre-diagramas)
11. [Navegación mediante pestañas](#11-navegación-mediante-pestañas)
12. [Selector rápido](#12-selector-rápido)
13. [Menús contextuales](#13-menús-contextuales)
14. [Inspector de referencias](#14-inspector-de-referencias)
15. [Posiciones y disposición del diagrama](#15-posiciones-y-disposición-del-diagrama)
16. [Edición y guardado](#16-edición-y-guardado)
17. [Exportación SVG, PDF y SQL](#17-exportación-svg-pdf-y-sql)
18. [Colaboración en tiempo real](#18-colaboración-en-tiempo-real)
19. [Ejemplos completos](#19-ejemplos-completos)
20. [Solución de problemas](#20-solución-de-problemas)

---

## 1. Introducción

La idea central es **un proyecto, un esquema lógico global, varios paquetes y un diagrama principal por paquete**:

- Cada tabla se define **una sola vez**. Una tabla de un paquete puede *aparecer* en el diagrama de otro como una representación visual, sin duplicar su definición ni generar SQL adicional.
- El SQL se genera exclusivamente del esquema lógico global, nunca de los diagramas.
- Las posiciones, los modos de representación y los comentarios son metadatos: no cambian el esquema.

DBML Studio usa el compilador oficial `@dbml/core` y su [sistema de módulos](https://dbml.dbdiagram.io/syntax/module-system/) (`use` / `reuse`). **No añade palabras clave nuevas al lenguaje DBML**: un paquete es un directorio, las importaciones son las oficiales y la configuración visual vive en un archivo YAML aparte (ver [arquitectura](arquitectura.md) para el motivo). Por eso cualquier archivo DBML estándar sigue funcionando.

## 2. Instalación y ejecución

Requisitos: [Bun](https://bun.sh) 1.x.

```sh
bun install
```

**Interfaz web en desarrollo** (API y Vite en una sola terminal):

```sh
# Inicia API/WebSocket, la aplicacion y VitePress
bun run dev:all       # abre http://127.0.0.1:5173
```

El enlace **Documentacion** del editor abre este sitio en `/docs/`. Para trabajar solo en la documentacion ejecuta `bun run docs:dev` y abre `http://127.0.0.1:5174/docs/`. `bun run build` tambien genera el sitio estatico para servirlo desde el servidor de la aplicacion.

Si prefieres abrirlos por separado:

```sh
bun run server
bun run dev            # en otra terminal

# Una sola terminal: compila la interfaz y la sirve el propio servidor
bun run build
bun run server         # abre http://localhost:3001
```

La interfaz requiere una cuenta. En el primer acceso, selecciona **Crear una cuenta**, elige un usuario y escribe dos veces una contraseña de al menos 12 caracteres. Después inicia sesión y crea un proyecto desde *Mis proyectos*. Todos los documentos DBML, diagramas, cuentas, sesiones, comentarios y versiones se guardan en libSQL.

No se necesita elegir ni montar carpetas para editar desde la web. Los archivos DBML son documentos almacenados en la base y se sincronizan al escribir. Las contraseñas se guardan como hashes Argon2id; nunca se almacenan en texto plano.

Configura `LIBSQL_URL` y `LIBSQL_AUTH_TOKEN` para usar una base remota. En desarrollo, si no se especifica `LIBSQL_URL`, se crea una base libSQL local en `.data/shared.sqlite`. Para usar ese modo en un contenedor, conserva `.data` en un volumen; con una base remota no se necesita volumen de datos local.

**Línea de comandos** (sin interfaz):

```sh
bun run index.ts check  docs/ejemplos/multiples-paquetes/dbml.project.yaml
bun run index.ts export docs/ejemplos/multiples-paquetes/dbml.project.yaml --a3 --portrait
```

`check` valida y muestra diagnósticos; termina con código distinto de cero si hay errores. `export` escribe los SVG/PDF indicados en el manifiesto y `schema.sql` (ver [§17](#17-exportación-svg-pdf-y-sql)).

Variables de entorno: `PORT` (3001; API, interfaz y WebSocket `/ws`), `LIBSQL_URL` (por defecto `file:.data/shared.sqlite`), `LIBSQL_AUTH_TOKEN` (opcional para una base remota), `DBML_SHARED_DB` (ruta local alternativa), `DBML_ALLOWED_ORIGINS`, `DBML_ALLOW_REGISTRATION` (el registro se deshabilita con `0`) y `DBML_HOST` (por defecto `0.0.0.0`).

Para contenerizar, publica `PORT` y configura el acceso a la base por variables de entorno. Si usas una base libSQL local, monta su directorio en un volumen persistente.
## 3. Creación de proyectos

En el editor web, un proyecto es un registro en libSQL; sus paquetes y archivos DBML se guardan como documentos. La estructura siguiente corresponde a proyectos de entrada para la CLI y a los ejemplos del repositorio:

```text
mi-proyecto/
├── dbml.project.yaml
├── catalogos/
│   ├── paises.dbml
│   └── estados.dbml
├── ventas/
│   ├── pedidos.dbml
│   └── diagram.yaml        (opcional)
└── output/                 (generado; se excluye automáticamente)
```

El proyecto mínimo está en `docs/ejemplos/proyecto-basico`:

```yaml
name: tienda-basica
version: 1
source:
  packages: [tienda]
```

## 4. Configuración del manifiesto

```yaml
name: sistema-empresarial      # obligatorio
version: 1                     # obligatorio; la única versión admitida
source:
  root: .                      # opcional: base de los paquetes, relativa al manifiesto
  packages: [catalogos, ventas]  # opcional: si se omite, se descubren
  exclude: ["*.borrador.dbml", legado]   # opcional: patrones con * como comodín
output:
  directory: output            # opcional (por defecto output)
  formats: [svg, pdf]          # svg y/o pdf
options:
  sqlDialect: postgres         # postgres | mysql | mssql | oracle
```

- **Descubrimiento**: sin `source.packages`, cada subdirectorio directo de la raíz que contenga archivos `.dbml` es un paquete, en orden alfabético. Se ignoran `node_modules`, `docs`, `output`, `dist`, `out`, `coverage`, las carpetas que empiezan por punto, el directorio de salida y lo que coincida con `exclude`.
- **Exclusiones**: `exclude` se aplica a nombres de directorios (al descubrir) y de archivos `.dbml`.
- **Seguridad**: un paquete debe estar dentro de la raíz; las rutas fuera de ella o los enlaces simbólicos que escapan se rechazan.
- **Duplicados**: listar el mismo paquete dos veces, o dos rutas que apuntan al mismo directorio, es un error.
- **Opciones de compilación**: `options.sqlDialect` fija el dialecto de `schema.sql` (se puede cambiar con `--dialect=` en la CLI).

Un manifiesto inválido produce un diagnóstico con código `STU020`.

## 5. Creación de paquetes

> **Regla principal:** cada paquete corresponde a exactamente **un diagrama principal**.

Un paquete es un directorio. Todos los `.dbml` situados directamente en él (no en subcarpetas) contribuyen al mismo modelo lógico y se leen en orden alfabético. Un paquete debe contener al menos un archivo `.dbml`.

El identificador del paquete es el nombre de su directorio (`ventas`). Un paquete **no** equivale a un esquema SQL: `ventas` puede definir tablas en el esquema `public` o en cualquier otro. Para usar esquemas SQL, califica las tablas en el DBML (`Table s1.x { … }`).

## 6. Organización de archivos DBML

Un archivo accede a tablas definidas en otros archivos —del mismo paquete o de otro— con la importación oficial `use`:

```dbml
use * from '../catalogos/paises'

Table pedidos {
  id int [pk]
  pais_id int [ref: > paises.id]
}
```

Reglas (provienen del módulo oficial):

- La ruta es relativa al archivo que importa; la extensión `.dbml` es opcional.
- `use` importa para usar la tabla en este archivo; `reuse` además la reexporta.
- Importar no duplica entidades: la tabla sigue existiendo una sola vez en el esquema global.
- Sin `use`, una referencia a una tabla de otro archivo falla con un diagnóstico que **sugiere la línea exacta** a añadir (código `STU003`).
- Si el mismo nombre existe en varios esquemas, la referencia es ambigua (`STU002`): califícala (`s1.x`) e importa el archivo que la define.
- Definir dos veces la misma tabla en cualquier paquete es el error `STU001`, que indica ambas ubicaciones.

El proyecto `docs/ejemplos/multiples-paquetes` contiene tres paquetes (uno de ellos con dos archivos) y un borrador excluido.

## 7. Relaciones entre paquetes

Una relación entre tablas de paquetes distintos es una clave foránea normal (`ref: > paises.id`). Para que el compilador la resuelva, el archivo importa la tabla referenciada.

Se distinguen tres tipos de dependencia, visibles en el panel **Dependencias** de la barra lateral:

| Tipo | Origen |
|---|---|
| Importaciones | `use` / `reuse` entre archivos de paquetes distintos |
| Claves foráneas | el paquete que guarda la FK depende del que define la tabla |
| Referencias visuales | el diagrama de un paquete muestra tablas de otro |

Importante:

- Que dos paquetes se referencien mutuamente **no es un error**. Las claves foráneas cruzadas son válidas.
- Un ciclo de importación entre *archivos* se informa como **advertencia** (`STU004`), porque el compilador lo resuelve sin duplicar nada; conviene mover lo compartido a un archivo común.
- Por defecto, el diagrama de un paquete muestra sus tablas y las tablas que ellas referencian (como externas). Las tablas de otros paquetes que *lo* referencian no se dibujan —un catálogo usado por 50 paquetes no inunda su diagrama—: consúltalas en el [inspector](#14-inspector-de-referencias) o añádelas con una vista externa.

## 8. TableRef: tablas externas

Una **tabla externa** (TableRef) es una representación visual de una tabla definida en otro paquete. Mantiene su identidad lógica (`public.paises`), conserva relaciones y cardinalidades, permite ir al paquete propietario y **no genera tablas ni restricciones SQL**. Se dibuja con borde discontinuo, el nombre del paquete propietario y una flecha de navegación.

Se crean automáticamente al declarar una relación hacia otro paquete. Para controlar su aspecto, crea `diagram.yaml` dentro del paquete:

```yaml
package: ventas
external:
  - id: resumen
    table: public.paises
    display: compact
    show: [id, nombre]
  - id: completa
    table: public.paises
    display: full
```

Una misma tabla lógica puede tener **varias representaciones** (aquí, dos); cada una debe tener un `id` distinto. Consulta `docs/ejemplos/referencias-externas`.

## 9. Modos Full, Compact y Connector

| Modo | Qué muestra | Parámetros |
|---|---|---|
| `full` | todas las columnas | — |
| `compact` | solo las columnas elegidas | `show: [col, …]` (obligatorio) |
| `connector` | un símbolo que apunta al diagrama propietario | `label` (opcional), `relationship` (opcional) |

Puedes cambiar el modo editando `diagram.yaml` o, en la interfaz, con el menú contextual de la tabla externa: **Mostrar Full**, **Mostrar Compact**, **Elegir columnas visibles…** y **Mostrar Connector**. La interfaz escribe el cambio en `diagram.yaml` (o en el estado compartido en modo colaborativo).

Se validan los nombres de tabla y columnas y que un conector tenga una relación con una tabla local. Un error de configuración se muestra como problema del paquete y el resto del diagrama se genera igualmente.

## 10. Conectores entre diagramas

Un conector es el equivalente de un *off-page connector* de un diagrama de flujo: representa una relación que continúa en otro diagrama.

```yaml
package: ventas
external:
  - id: envio
    table: public.paises
    display: connector
    label: CAT-01
```

Cada conector tiene un identificador estable (`connector:<nodo>:<relación>`) y guarda: relación lógica original, tabla y paquete de origen, tabla y paquete de destino, **cardinalidad** (`*:1`), **opcionalidad** (obligatoria u opcional, según si la columna de la FK admite nulos), etiqueta visual y destino de navegación.

- Si hay varias relaciones entre las mismas tablas, el campo opcional `relationship` (el identificador exacto de la relación) elige cuál representa el conector; sin él se crea un conector por cada relación.
- Un conector **no crea** relaciones SQL ni tablas.
- Para ir al diagrama destino: doble clic o Enter sobre el conector, o *Ir al diagrama destino* en su menú.
- En las exportaciones, el conector imprime `CAT-01`, `Paquete: catalogos`, `Tabla: paises`, su cardinalidad y, en PDF, la página donde empieza el diagrama destino (`CAT-01 · p. 1`). El número de página se calcula al exportar y no forma parte de la identidad del conector.

Ejemplo completo: `docs/ejemplos/conectores`.

## 11. Navegación mediante pestañas

Cada paquete es una pestaña (y una entrada en la barra lateral). Al activarla se muestra su diagrama.

- Cada pestaña **recuerda su zoom y su posición de desplazamiento** mientras la página sigue abierta.
- Las pestañas muestran una insignia con el número de errores (o una advertencia) de su paquete.
- Teclado: ←/→ mueven el foco entre pestañas, Inicio/Fin saltan a los extremos; Menú (o Mayús+F10) abre su menú contextual.
- **Historial**: los botones Anterior/Siguiente (o Alt+←/Alt+→) recorren los destinos visitados, incluida la tabla seleccionada.
- Al navegar a una tabla (por un conector, el inspector o el selector) se **activa la pestaña del propietario, se centra el visor y se resalta** la tabla.
- La URL refleja el paquete y la tabla (`?package=ventas&table=public.pedidos` en la interfaz web).

## 12. Selector rápido

**Ctrl+K** (o **Cmd+K**) abre el selector. Escribe para buscar paquetes y tablas (coincidencia por prefijo, subcadena o letras en orden); **↑/↓** recorren los resultados, **Enter** abre, **Esc** cierra. El paquete activo aparece marcado y los paquetes con errores muestran su número.

## 13. Menús contextuales

Se abren con clic derecho, con la tecla **Menú** o con **Mayús+F10** sobre el elemento enfocado. Dentro del menú: **↑/↓** recorren, **Inicio/Fin** saltan, **Enter** o **Espacio** activan, **Esc** cierra y devuelve el foco.

| Elemento | Opciones |
|---|---|
| Paquete (pestaña, barra lateral, fondo) | Abrir · Copiar identificador · Exportar SVG · Exportar PDF · Ver errores |
| Tabla | Ver definición · Ver relaciones · Ver referencias entrantes · Ir al paquete propietario · Copiar identificador |
| Tabla externa | Mostrar Full · Mostrar Compact · Elegir columnas visibles… · Mostrar Connector · Ir a definición original (además de las de tabla) |
| Conector | Ir al diagrama destino · Ver relación · Mostrar tabla externa · Copiar referencia |

Las opciones que modifican el diagrama se deshabilitan si no tienes permiso de edición.

## 14. Inspector de referencias

El panel derecho muestra la tabla o relación seleccionada:

- columnas con sus marcas **PK**, **FK** y **NN** (no nulo) y su tipo;
- **Relaciones salientes**: tablas a las que esta tabla hace referencia;
- **Referencias entrantes**: tablas de cualquier paquete que la referencian (también las que no se dibujan en este diagrama). Cada fila navega al paquete de la otra tabla;
- **Referencias externas**: paquetes cuyos diagramas muestran esta tabla;
- **Conectores** del nodo, con su cardinalidad y opcionalidad;
- **Ver definición**: el bloque `Table … { … }` original con su archivo y línea.

Esto es *navegación inversa*; no implica relaciones SQL bidireccionales. Al seleccionar una relación (clic en una línea) se ven sus extremos, cardinalidades y qué lado guarda la FK.

El inspector derecho se puede ocultar desde su encabezado. La barra estrecha **Inspector** permanece al borde derecho para volver a abrirlo, y la preferencia se guarda en el navegador. En pantallas estrechas, esa barra se mueve debajo del área de trabajo.

## 15. Posiciones y disposición del diagrama

- La disposición inicial es **automática y determinista**: capas que colocan las tablas referenciadas a la izquierda, ordenadas para reducir cruces, sin superposiciones. Las líneas salen de la fila de la columna que originó la relación, de modo que varias relaciones entre las mismas tablas se distinguen.
- **Arrastra** una tabla para moverla (se ajusta a una cuadrícula de 8 px) o enfócala y usa **Alt+flechas** (Mayús para pasos mayores). El fondo se arrastra para desplazarse; **Ctrl+rueda** hace zoom.
- La primera vez que mueves algo se **fija la disposición actual** de todas las tablas; así añadir o quitar tablas después no redistribuye el diagrama: las nuevas se colocan junto a sus vecinas.
- Las posiciones se guardan en el campo `layout` de `diagram.yaml`, por identificador de nodo (`node:<paquete>:<tabla>[:<vista>]`):

  ```yaml
  layout:
    "node:ventas:public.pedidos": { x: 440, y: 96 }
  ```
- **Reorganizar** descarta las posiciones guardadas.
- Al guardar desde la interfaz, `diagram.yaml` se reescribe con claves ordenadas; los comentarios YAML manuales no se conservan.

## 16. Edición y guardado

El editor usa CodeMirror 6 con resaltado DBML, números de línea, búsqueda, plegado, cierre de llaves e indentación. Al abrir un archivo, su estado se descarga desde libSQL y se sincroniza en tiempo real con otras sesiones.

- **Ocultar editor** amplía el visor. Para volver a abrirlo, selecciona un archivo en la barra lateral.
- El panel muestra el estado de sincronización, cursores y selecciones remotas.
- Los cambios del editor se guardan en libSQL mediante sincronización CRDT; no se escriben archivos en carpetas locales.
- Para renombrar un paquete, abre su menú contextual y elige **Cambiar nombre**. El cambio actualiza las importaciones DBML relativas, conserva diagramas y comentarios, y se registra en el historial.
- Mientras el texto no compile, el diagrama muestra la **última versión válida** con un aviso, y el panel **Problemas** lista cada error con archivo, línea, columna, código y sugerencia. Un clic en el problema abre el archivo en esa línea.
- Las posiciones, vistas externas y conectores del diagrama también se guardan en libSQL y se comparten con las personas autorizadas.
## 17. Exportación SVG, PDF y SQL

**Desde la interfaz** (botón *Exportar*): SVG o PDF del paquete activo, PDF de todos los paquetes, esquema SQL y DBML estándar aplanado; para PDF eliges tamaño (A4/A3) y orientación.

**Desde la terminal:**

```sh
bun run index.ts export docs/ejemplos/multiples-paquetes/dbml.project.yaml --a3 --portrait --dialect=mysql
```

Escribe en el directorio `output` un SVG y/o PDF por paquete según `output.formats`, `proyecto.pdf` con todos los diagramas (si hay PDF) `schema.sql` y `schema.dbml`.

- Un diagrama grande se reparte en varias páginas **sin cortar tablas**, conservando su disposición. La escala mínima es 0,58; una sola tabla extremadamente alta puede reducirse más.
- Una página de **Referencias** lista las relaciones que cruzan páginas y los conectores con su paquete, tabla, cardinalidad y página destino.
- El PDF incluye marcadores (uno por paquete). El texto usa fuentes estándar de PDF (WinAnsi).
- `schema.sql` contiene cada tabla una sola vez, con independencia de cuántas representaciones visuales tenga.
- `schema.dbml` es el esquema lógico completo como **DBML estándar en un solo documento** (sin `use` ni paquetes). Volver a compilarlo produce exactamente el mismo SQL; sirve para llevar el modelo a otras herramientas DBML. La estructura de paquetes y la configuración visual no forman parte del esquema y no se incluyen.

## 18. Colaboración en tiempo real

Permite que varias personas trabajen sobre el mismo proyecto y el mismo modelo lógico, con permisos, comentarios e historial. **Es un servidor de un solo proceso pensado para redes de confianza o detrás de un proxy con TLS; lee [§18.9](#189-seguridad-y-límites) antes de exponerlo.**

### 18.1 Cuentas y proyectos

El registro web está habilitado por defecto. Crea una cuenta con nombre de usuario y contraseña confirmada (mínimo 12 caracteres), inicia sesión y crea proyectos desde **Mis proyectos**. Se puede deshabilitar el registro definiendo `DBML_ALLOW_REGISTRATION=0`.

- La contraseña se guarda en libSQL como hash Argon2id; las sesiones también quedan registradas en la base y se guardan como hashes.
- También puedes crear una cuenta por terminal con `bun run create-user <usuario>` (la contraseña se lee por stdin).
- `bun run import-project <dbml.project.yaml> <usuario> [nombre]` copia archivos y diagramas de un manifiesto de entrada a un proyecto en libSQL.
- Abre `http://localhost:3001/` (o `:5173/`) para iniciar sesión y ver tus proyectos.
### 18.2 Roles

| Rol | Puede |
|---|---|
| **Propietario** | todo, incluida la administración del acceso |
| **Editor** | modificar archivos DBML y diagramas, guardar y restaurar versiones |
| **Comentarista** | leer y comentar |
| **Lector** | solo leer y exportar |

Los permisos se comprueban **en el servidor** en cada operación, no solo en la interfaz.

### 18.3 Compartir y permisos

Con rol de propietario, **Compartir** permite:

- renombrar el proyecto;
- **invitar por nombre de usuario** con un rol y cambiar o quitar roles;
- crear **enlaces** de tres tipos: *Solo invitados*, *Con el enlace y sesión iniciada: lectura* y *Con el enlace y sesión iniciada: edición*, opcionalmente con caducidad;
- **revocar** un enlace (deja de funcionar de inmediato, incluso para conexiones abiertas);
- consultar el **registro de acciones administrativas**.

El enlace con su secreto se muestra **una sola vez** al crearlo: el servidor solo guarda su hash. El secreto viaja en el fragmento de la URL (`#share=…`), que el navegador no envía al servidor ni a otros sitios; la página lo guarda para la pestaña y lo retira de la barra de direcciones. Todos los tipos de enlace requieren una sesión; según el permiso configurado, la cuenta debe ser miembro del proyecto o usar el enlace para obtener acceso.

### 18.4 Enlaces directos

Cada proyecto tiene una URL estable e independiente de nombres de archivo y posiciones:

```text
/projects/<id>                                      proyecto
/projects/<id>/packages/ventas                      un paquete (la pestaña activa queda en la URL)
/projects/<id>/packages/ventas?table=public.pedidos una tabla (se centra y resalta)
/projects/<id>/packages/ventas?connector=<id>       un conector
```

El menú contextual (*Copiar enlace a la tabla*) y el inspector copian estos enlaces. Quien los abra necesita permiso; Atrás y Adelante del navegador recorren los paquetes visitados.

### 18.5 Edición simultánea

- Los archivos se sincronizan con **Yjs (CRDT)** por WebSocket: dos personas pueden editar a la vez el mismo archivo sin perder cambios; el cursor local se mantiene cuando llegan cambios remotos.
- Verás los **cursores y selecciones remotos** con el nombre y un color de cada persona, los avatares de quienes están conectados, puntos de color en los paquetes y archivos activos, y el estado de la conexión.
- Si se interrumpe la conexión, sigue editando: al reconectar (con espera creciente) se envía lo pendiente **sin duplicar cambios**.
- Cada cambio de texto dispara una compilación única tras una pausa breve, para todos; no hay copias del esquema por usuario.
- **Errores de sintaxis no bloquean la edición**: el diagrama conserva la última versión válida y el panel de problemas muestra el error.

### 18.6 Estado compartido y estado personal

| Compartido (se guarda y lo ve todo el mundo) | Personal (solo tu navegador) |
|---|---|
| Posiciones de tablas | Zoom y desplazamiento |
| Modos Full/Compact/Connector y conectores | Pestaña activa |
| Archivos DBML | Selección y paneles abiertos |
| Comentarios y versiones | Preferencias locales |

Dos personas moviendo tablas distintas a la vez no se pisan: el servidor fusiona cada cambio por tabla.

### 18.7 Comentarios

Desde el inspector (o **Comentarios** en la barra superior) se comentan el **proyecto, un paquete, una tabla, una columna, una relación o un conector**. Puedes responder, **resolver o reabrir** una discusión (la persona que la abrió o quien edita), editar tu comentario y eliminarlo (tú o un administrador). Cada comentario muestra autor y fecha, y las tablas con discusiones abiertas llevan una insignia; un clic en el elemento citado navega a él.

Los comentarios se anclan a identificadores lógicos, no a posiciones, así que **sobreviven a cambios de disposición**; si el elemento desaparece, la discusión sigue visible marcada como «ya no existe». Los comentarios no afectan al esquema SQL.

### 18.8 Versiones e historial

- Las ediciones se agrupan en una **revisión automática** tras una pausa (se atribuye a quien editó). **Guardar versión** crea una con mensaje.
- Cada revisión guarda **los archivos DBML y la configuración visual juntos**, con autor, fecha y **paquetes afectados**.
- Selecciona una versión para **compararla** con el estado actual o con otra: verás líneas añadidas y eliminadas por archivo y los diagramas con tablas movidas o vistas cambiadas.
- **Restaurar** aplica esa versión y crea una **revisión nueva y auditable**; antes se guarda el estado actual, de modo que nada se pierde. Los archivos que no existían en la versión restaurada se ocultan y pueden recuperarse restaurando una versión que los contenga. Quienes están conectados reciben los cambios en vivo.
- Resolver un conflicto de sincronización: los textos se fusionan automáticamente (CRDT). Si dos personas cambian la misma línea verás ambos cambios en el texto; revísalo y, si hace falta, vuelve a una versión anterior desde el historial.

### 18.9 Seguridad y límites

- Contraseñas con argon2id; sesiones y enlaces solo como hashes; el inicio de sesión no revela si una cuenta existe.
- Aislamiento entre proyectos comprobado: una cuenta o enlace de un proyecto no accede a otro.
- Límites: documentos de 1 M de caracteres, actualizaciones de 1 MB, 500 archivos por proyecto, 4000 caracteres por comentario, 5000 comentarios y 5000 revisiones por proyecto; cuerpos HTTP de 1,1 MB; frecuencia por cuenta/enlace/origen (inicio de sesión: 8 de ráfaga y 1 cada 10 s; escrituras: 60 de ráfaga y 2/s) y por conexión WebSocket (60 mensajes/s); 429 con `Retry-After` al excederla.
- WebSocket: origen verificado, mensajes validados, autorización revalidada en cada operación y al revocar accesos; las conexiones sin identificarse se cierran a los 10 s.
- Registro de auditoría: creación de proyecto, altas/bajas/cambios de roles, enlaces creados/revocados, creación/eliminación de archivos, versiones y restauraciones, e intentos de acceso fallidos o limitados.

**Para exponerlo en red:** coloca un proxy inverso con **TLS** (los tokens viajan en cabeceras), define `DBML_ALLOWED_ORIGINS` con el origen público y `DBML_HOST` solo si es necesario. Los límites de frecuencia viven en memoria y el servidor es de un solo proceso; no está dimensionado para un despliegue público masivo.

## 19. Ejemplos completos

Cada ejemplo está en `docs/ejemplos/<nombre>/` y se verifica automáticamente:

| Ejemplo | Muestra |
|---|---|
| `proyecto-basico` | un paquete, un archivo, relaciones simples |
| `multiples-paquetes` | descubrimiento automático, paquetes con varios archivos, `exclude`, FKs entre paquetes |
| `referencias-externas` | dos representaciones (compacta y completa) de la misma tabla |
| `conectores` | un conector `CAT-01` y una posición guardada |

```sh
bun run index.ts check docs/ejemplos/conectores/dbml.project.yaml
# Requiere una cuenta creada en la aplicación:
bun run import-project docs/ejemplos/conectores/dbml.project.yaml usuario-existente "Conectores"
```

## 20. Solución de problemas

| Síntoma | Causa y solución |
|---|---|
| `STU001` tabla duplicada | La tabla se define en dos archivos. Conserva una y usa `use` en el otro. |
| `STU003` falta importar | El mensaje incluye el `use * from '…'` exacto que debes añadir. |
| `STU002` nombre ambiguo | Existe en varios esquemas: califícalo (`esquema.tabla`). |
| `STU004` ciclo de importación | Advertencia; mueve lo compartido a un archivo que no importe a los demás. |
| `STU010`–`STU016` en `diagram.yaml` | Vista externa inválida (tabla o columna inexistente, `compact` sin `show`, conector sin relación…). El diagrama se genera sin esa vista. |
| `STU017` posición inválida | `x` e `y` deben ser números entre 0 y 1000000. |
| `STU018` / `STU020` | Configuración de diagrama o manifiesto con formato inválido. |
| «Se muestra la última versión válida» | Hay errores de compilación; abre **Problemas**. |
| Se pierde la conexión del editor | Comprueba que el servidor y `/ws` sigan disponibles; al reconectar, el estado se recupera desde libSQL. |
| «Configuración rechazada» | El cambio de modo generaría un error (p. ej. conector sin relación). |
| «Sin acceso a este proyecto» | Inicia sesión con una cuenta autorizada y comprueba que el enlace de acceso siga vigente. |
| 429 «Demasiadas solicitudes» | Espera los segundos de `Retry-After`. |
| Sin conexión (punto rojo) | Comprueba que el servidor siga en marcha; tus cambios se reenviarán al reconectar. |
| La interfaz no carga en `:3001` | Ejecuta `bun run build` primero, o usa `bun run dev`. |
| PDF ilegible | Usa A3; una tabla individual muy alta puede reducirse mucho. |

> Esta documentación no incluye capturas de pantalla: la interfaz se verificó con pruebas automáticas de renderizado y de API, y conviene una revisión visual en tu navegador.
