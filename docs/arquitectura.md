# Arquitectura

Este documento resume la auditoría del repositorio, las decisiones de diseño, el flujo de compilación y los riesgos conocidos. Distingue lo implementado de lo no implementado.

## 1. Auditoría técnica (Fase 1)

| Elemento | Estado |
|---|---|
| Lenguaje y entorno | TypeScript estricto sobre Bun; React 19 y Tailwind (solo su base) en la interfaz; Vite para empaquetar |
| Parser, AST y análisis semántico | `@dbml/core` (oficial). Se reutiliza tal cual; DBML Studio no tiene parser propio |
| Sistema de módulos | `use` / `reuse` oficiales. Se reutilizan; no hay sistema de importación paralelo |
| Modelo semántico | `Database` del compilador oficial → `database.export()` |
| Generador SQL | `ModelExporter` oficial (PostgreSQL, MySQL, SQL Server, Oracle) |
| Renderizador | propio: layout + SVG (`src/diagram`); PDF con `pdfkit` y `svg-to-pdfkit` |
| Colaboración | Yjs (CRDT), WebSocket de Bun, libSQL (`@libsql/client`) |
| Pruebas | `bun test` (unitarias, integración, API, WebSocket real y render de componentes) |

## 2. Decisiones de diseño

**No se extendió la gramática de DBML.** La especificación sugería `Package`, `Import`, `Diagram`, `external` y `Connector` como sintaxis nueva, pero también exigía no crear un sistema de importación paralelo ni romper DBML estándar. El módulo oficial ya resuelve las importaciones; un paquete es un directorio (como en Go) y lo puramente visual (representaciones externas, conectores, posiciones) vive en `diagram.yaml`, que no pertenece al lenguaje. Ventajas: compatibilidad total con herramientas DBML, cero mantenimiento de parser, el esquema lógico no depende de ninguna extensión. Coste: la configuración visual es un archivo aparte, no sintaxis inline.

**Cuatro modelos relacionados por identificadores estables**, sin mezclarse:

| Modelo | Dónde | Contenido |
|---|---|---|
| Project Model | `src/project/loader.ts` | manifiesto, paquetes, archivos, exclusiones, opciones |
| Schema Model | `src/project/compiler.ts` | `Database` oficial + `owners` (tabla→paquete), `declarations` (tabla→archivo/línea), importaciones |
| Diagram Model | `src/diagram/model.ts` | nodos, relaciones, conectores, diagnósticos y huella por paquete |
| Navigation Model | `src/diagram/navigation.ts` | índice global de referencias, historial, destinos |

Los identificadores (`PackageId`, `TableId`, `NodeId`, `ConnectorId`…) están en `src/project/diagnostics.ts`. Una tabla tiene un `TableId` y puede tener varios `NodeId`.

**El renderizador consume el Diagram Model, no el esquema SQL.** El SQL consume solo el esquema lógico; por eso un nodo externo o un conector nunca puede generar una tabla o restricción adicional (hay pruebas que lo verifican).

## 3. Flujo de compilación

```text
loadProject (manifiesto, descubrimiento, exclusiones, diagram.yaml)
   → compileProject: una entrada sintética `reuse` por archivo → parseDbmlProject (oficial)
        → diagnósticos normalizados (archivo real, línea, código, sugerencia)
        → declaraciones de tablas (AST) → owners / duplicados
        → importaciones (AST) → ciclos → advertencias
   → compileDiagramSet: un Diagram por paquete (tolerante a errores de configuración)
   → buildDependencyGraph (importaciones / FK / visual)
   ├→ exportSql (Schema Model)
   └→ layout → renderSvg → UI interactiva | exportación SVG/PDF
```

`ProjectBuilder` (`src/project/build.ts`) añade la caché: el análisis del parser —lo costoso— se reutiliza mientras no cambie el contenido de las fuentes; un cambio solo visual (posiciones, vistas) reconstruye únicamente los diagramas. Cada diagrama lleva una **huella** (`hash`), de modo que se sabe qué paquetes cambiaron (`changedPackages`). Si las fuentes dejan de compilar, se conserva la **última versión válida** y se informan los errores.

### Layout (`src/diagram/layout.ts`)

Capas por camino más largo (tablas referenciadas a la izquierda), ciclos rotos con aristas de retroceso del DFS (iterativo), ordenación por baricentro (4 pasadas) para reducir cruces, columnas partidas a 1500 px de alto, nodos aislados en cuadrícula. Los nodos con posición guardada no se mueven; un nodo nuevo con vecino fijado se coloca a su lado en el primer hueco libre; el resto, debajo. Es determinista (orden por id). Las aristas son curvas de Bézier ancladas en la fila de la columna de la clave.

### PDF (`src/diagram/pdf.ts`)

Se reparte por geometría del layout completo (las posiciones se trasladan, no se recalculan) para no cortar tablas; escala mínima 0,58. **Dos pasadas**: la primera mide en qué página empieza cada paquete y la segunda imprime esas páginas en los conectores. El texto se limita a caracteres WinAnsi de las fuentes estándar (no hay flechas Unicode).

## 4. Compatibilidad y riesgos

- **DBML estándar**: Table, Ref, TableGroup, Enum, índices, notas y `use`/`reuse` se conservan (pruebas de regresión). El esquema lógico es idéntico si un modelo está en un archivo o repartido en paquetes.
- **Entrada sintética**: los archivos se alimentan al parser oficial mediante un archivo sintético con un `reuse` por archivo. Es una técnica no documentada oficialmente; si una versión futura de `@dbml/core` cambia su API de `setDbmlSource`/`parseDbmlProject`, habrá que adaptar `compiler.ts`. Hay pruebas que lo detectarían.
- **AST interno**: la extracción de declaraciones e importaciones usa nodos del AST oficial (`declarations`, `uses`, `importPath`) que no son API pública estable.
- **Comportamiento cambiado**: el diagrama de un paquete ya no dibuja automáticamente las tablas de otros paquetes que lo referencian (antes sí). Se añaden con una vista externa; siguen en el inspector. Motivo: escalabilidad.
- **`diagram.yaml` reescrito por la interfaz** pierde los comentarios YAML manuales.
- **Errores no relacionados**: `@dbml/core` deja un manejador abierto, por lo que los procesos que lo usan (CLI, scripts) terminan con `process.exit` explícito.

## 5. Colaboración (Fase 8)

```text
Navegador ──HTTP──▶ API compartida ─▶ servicios (acceso, documentos, diagramas, comentarios, historial, auditoría)
   │                                         │              ▲
   └──WebSocket──▶ socket ──── eventos ──────┘              │ libSQL
              (Yjs: texto, presencia, avisos)          ProjectBuilder por proyecto
```

- **Documentos fuente**: cada archivo DBML es un `Y.Doc` con un `Y.Text`; el servidor persiste el estado completo en libSQL y lo reenvía a los demás. Se eligió Yjs (consolidado) en lugar de implementar OT/CRDT propio.
- **Un solo esquema por proyecto**: `SharedBuilds` mantiene un `ProjectBuilder` por proyecto alimentado con los documentos persistidos y la configuración visual compartida. Se recompila bajo demanda (el cliente espera una pausa tras los cambios) y la caché evita reanalizar contenido idéntico. La compilación **incremental real** (por archivo) no se implementa; la reutilización es por contenido completo del proyecto.
- **Estado compartido de diagramas**: posiciones y vistas viajan como **parches validados** que el servidor fusiona por clave (no es un CRDT: dos cambios al mismo nodo se resuelven por última escritura). Un parche que introduciría errores se rechaza.
- **Estado personal**: zoom, pestaña, selección y paneles son locales y no tienen API de persistencia.
- **Comentarios**: anclados a identificadores lógicos; independientes del esquema.
- **Historial**: instantáneas completas (archivos + configuración visual) con hash; la revisión automática se agrupa tras una pausa; restaurar crea una revisión nueva y oculta (no borra) los archivos ausentes. No hay poda: el límite es 5000 revisiones por proyecto.
- **Seguridad**: autorización por operación en servidor; contraseñas argon2id; tokens solo como hash; enlaces con caducidad y revocación; límites de tamaño y frecuencia; auditoría; verificación de origen en WebSocket; revalidación de accesos al revocar.

### Limitaciones conocidas de la colaboración

- Proceso único conectado a libSQL; sin alta disponibilidad ni escalado horizontal. Los límites de frecuencia están en memoria.
- Sin TLS propio: requiere proxy inverso. No hay invitaciones por correo (se invita por nombre de usuario de una cuenta existente) ni recuperación de contraseña.
- Los cursores remotos del editor usan una capa espejo sobre un `textarea`; en textos con líneas muy largas o fuentes distintas puede desalinearse levemente. No es un editor de código con resaltado.
- El texto se fusiona automáticamente, pero la fusión no valida semántica: dos cambios compatibles a nivel CRDT pueden producir DBML inválido; el diagrama conserva entonces la última versión válida.
- No se validó en un navegador real durante el desarrollo: la interfaz se cubrió con compilación, pruebas de render y de API/WebSocket. Falta una revisión visual y de usabilidad manual.

## 6. Fuera de alcance

Importar desde SQL/otros formatos, alta de cuentas con correo, roles personalizados, PNG, exportación a DBML estándar «aplanado» (el SQL cubre ese caso), edición del manifiesto desde la interfaz y poda del historial.
