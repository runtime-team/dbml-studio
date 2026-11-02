# Ejemplos

Cada subdirectorio es un proyecto completo. `tests/examples.test.ts` los compila, genera sus SVG, PDF y SQL y comprueba sus propiedades principales, de modo que no pueden quedar desactualizados.

| Directorio | Qué enseña |
|---|---|
| `proyecto-basico/` | un paquete (`tienda`) con un archivo y relaciones simples |
| `multiples-paquetes/` | descubrimiento automático de paquetes, paquetes con varios archivos, `source.exclude` (el borrador roto se ignora) y claves foráneas entre paquetes mediante `use` |
| `referencias-externas/` | dos representaciones (`compact` y `full`) de la misma tabla en `ventas/diagram.yaml` |
| `conectores/` | un conector con etiqueta `CAT-01` y una posición guardada en `layout` |

```sh
bun run index.ts check  docs/ejemplos/multiples-paquetes/dbml.project.yaml
bun run index.ts export docs/ejemplos/conectores/dbml.project.yaml
DBML_PROJECT=docs/ejemplos/referencias-externas/dbml.project.yaml bun run server
```

Para probar la colaboración con uno de ellos:

```sh
printf 'una-contraseña-larga' | bun run create-user ana
bun run import-project docs/ejemplos/conectores/dbml.project.yaml ana "Demo"
```
