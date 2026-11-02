# Producto

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Bun, TypeScript, React y Tailwind CSS; el usuario delegó la selección de React.

## Users
Suposición: equipos técnicos que modelan bases de datos grandes, solos o en colaboración.

## Product Purpose
Organizar un esquema DBML global en paquetes y explorar sus diagramas y referencias sin duplicar tablas lógicas, y permitir que varias personas lo editen, comenten y versionen a la vez.

## Capabilities and Constraints
Proyectos multiarchivo, un diagrama por paquete, referencias externas (Full/Compact/Connector), conectores entre diagramas, navegación, exportación SVG/PDF/SQL y colaboración en tiempo real con permisos, comentarios e historial. DBML estándar y su sistema de módulos (`use`/`reuse`) deben seguir funcionando; no se añade sintaxis nueva al lenguaje.

## Product Principles
- Mantener una sola identidad lógica por tabla; las vistas, comentarios y posiciones son metadatos.
- Hacer visibles el origen y las relaciones de cada representación.
- Ofrecer diagnósticos accionables (archivo, línea, código y sugerencia) y navegación útil en proyectos grandes.
- La autorización se decide en el servidor; el estado personal nunca se confunde con el compartido.
