# Referencia de sintaxis

DBML Studio procesa los archivos `.dbml` con `@dbml/core`. Consulta la [sintaxis oficial de DBML](https://dbml.dbdiagram.io/docs/) y su [sistema de módulos](https://dbml.dbdiagram.io/syntax/module-system/).

## Lo que NO es una extensión del lenguaje

La especificación original proponía palabras clave `Package`, `Import`, `Diagram`, `external` y `Connector` dentro del DBML. Tras revisar el módulo oficial **no se implementaron como gramática nueva**, para no mantener un compilador paralelo ni romper la compatibilidad. Cada concepto se resuelve así:

| Concepto propuesto | Cómo se expresa realmente |
|---|---|
| `Package ventas` | el directorio `ventas/` listado en `source.packages` (o descubierto) |
| `Import catalogos` | `use * from '../catalogos/paises'` (sintaxis oficial; `reuse` también) |
| `Diagram Ventas { … }` | `ventas/diagram.yaml` (opcional); el diagrama existe siempre |
| `external catalogos.paises { display: compact; show: […] }` | entrada de `external` en `diagram.yaml` |
| `Connector pais { relationship; target; label }` | entrada `display: connector` con `label` y `relationship` |

## Manifiesto `dbml.project.yaml`

| Campo | Tipo | Descripción |
|---|---|---|
| `name` | cadena, obligatorio | nombre del proyecto |
| `version` | `1`, obligatorio | versión del formato |
| `source.root` | ruta, opcional | raíz de los paquetes, relativa al manifiesto (por defecto `.`) |
| `source.packages` | lista, opcional | directorios de paquetes; si se omite se descubren |
| `source.exclude` | lista, opcional | patrones (`*` comodín) de directorios y archivos a ignorar |
| `output.directory` | ruta, opcional | salida de la CLI (por defecto `output`); se excluye del descubrimiento |
| `output.formats` | lista, opcional | `svg` y/o `pdf` |
| `options.sqlDialect` | cadena, opcional | `postgres` (por defecto), `mysql`, `mssql`, `oracle` |

## `diagram.yaml`

Archivo opcional situado directamente en el directorio del paquete.

```yaml
package: ventas            # opcional; si existe debe coincidir con el paquete
external:                  # opcional: representaciones de tablas de otros paquetes
  - id: resumen            # recomendado; obligatorio si hay varias vistas de la misma tabla
    table: public.paises   # nombre lógico esquema.tabla (por defecto esquema public)
    display: compact       # full | compact | connector
    show: [id, nombre]     # solo compact; obligatorio en compact
    label: CAT-01          # solo connector: etiqueta impresa
    relationship: "relationship:%5B…"   # solo connector: identificador exacto de la relación
layout:                    # opcional: posiciones guardadas por nodo
  "node:ventas:public.pedidos": { x: 440, y: 96 }
```

- `table` debe existir, pertenecer a **otro** paquete y, para `connector`, tener una relación con una tabla local.
- `show` solo admite columnas existentes de la tabla.
- Sin `id`, los nodos de las vistas se numeran por posición (`…:0`, `…:1`); la interfaz usa `id` para poder modificar una vista de forma estable. **Declara siempre `id` si una tabla tiene varias vistas.**
- `layout`: `x` e `y` son números finitos entre 0 y 1000000. Los nodos sin posición se colocan automáticamente; las posiciones de nodos inexistentes se ignoran.

## Identificadores

| Identificador | Formato | Ejemplo |
|---|---|---|
| Paquete (`PackageId`) | nombre del directorio | `ventas` |
| Tabla (`TableId`) | `esquema.tabla` | `public.pedidos` |
| Columna (`ColumnId`) | `esquema.tabla.columna` | `public.pedidos.pais_id` |
| Relación (`RelationshipId`) | `relationship:` + JSON codificado (esquema, nombre, extremos) | `relationship:%5B%22public%22,…` |
| Diagrama (`DiagramId`) | `diagram:<paquete>` | `diagram:ventas` |
| Nodo (`NodeId`) | `node:<paquete>:<tabla>[:<vista>]` | `node:ventas:public.paises:resumen` |
| Conector (`ConnectorId`) | `connector:<nodo>:<relación>` | |
| Proyecto compartido (`ProjectId`) | UUID | |

Una tabla puede tener varios `NodeId` pero un único `TableId`. Ningún identificador lógico contiene posiciones visuales ni números de página.

## Códigos de diagnóstico

Los errores incluyen archivo (relativo a la raíz), línea, columna, código, descripción y, cuando se puede, **sugerencia**. Los códigos numéricos pertenecen al compilador oficial; los `STU…` son de DBML Studio.

| Código | Gravedad | Significado |
|---|---|---|
| `STU001` | error | tabla definida más de una vez |
| `STU002` | error | nombre de tabla ambiguo entre esquemas |
| `STU003` | error | referencia a una tabla de otro archivo sin `use` (sugiere la línea) |
| `STU004` | advertencia | ciclo de importación entre archivos |
| `STU010` | error | vista externa inválida o identificador de nodo duplicado |
| `STU011` | error | tabla externa inexistente |
| `STU012` | error | la tabla externa pertenece al propio paquete |
| `STU013` | error | columnas inexistentes en `show` |
| `STU014` | error | `compact` sin `show` |
| `STU015` | error | `relationship` inválido para el conector |
| `STU016` | error | conector sin relación con una tabla local |
| `STU017` | error | posición inválida en `layout` |
| `STU018` | error | `diagram.yaml` mal formado |
| `STU020` | error | manifiesto inválido |
| `STU021` | error | paquete duplicado o inválido |
| `STU022` | error | paquete sin archivos `.dbml` |

Los errores de `diagram.yaml` (`STU010`–`STU016`) se asocian al paquete y no impiden generar el resto de su diagrama.

## CLI

```text
bun run index.ts check  [dbml.project.yaml]
bun run index.ts export [dbml.project.yaml] [--a3] [--portrait] [--dialect=postgres|mysql|mssql|oracle]
bun run create-user <usuario>                       # contraseña por la entrada estándar
bun run import-project <dbml.project.yaml> <usuario> [nombre]
```

## API HTTP

Todas las respuestas son JSON salvo las exportaciones. Detalles en la [guía de desarrollo](guia-desarrollador.md#api-http).
