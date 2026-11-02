import { join } from 'node:path';
import type { DiagramConfig, Project } from '../src/project/loader';

/** Proyecto en memoria: `{ paquete: { 'archivo.dbml': contenido } }`. */
export function makeProject(packages: Record<string, Record<string, string>>, diagrams: Record<string, DiagramConfig> = {}, name = 'prueba'): Project {
  const root = join(process.cwd(), '.virtual-test-root');
  return {
    root,
    manifest: { name, version: 1, source: { packages: Object.keys(packages) } },
    packages: Object.entries(packages).map(([id, files]) => ({
      id, path: join(root, id), diagram: diagrams[id],
      files: new Map(Object.entries(files).map(([file, content]) => [join(root, id, file), content])),
    })),
  };
}

/** Tres paquetes con relaciones entre sí; sirve de base para varias pruebas. */
export const EMPRESA = {
  catalogos: {
    'paises.dbml': 'Table paises {\n  id int [pk]\n  nombre varchar [not null]\n  continente varchar\n}',
    'estados.dbml': "use * from './paises'\nTable estados {\n  id int [pk]\n  pais_id int [not null, ref: > paises.id]\n}",
  },
  empleados: {
    'empleados.dbml': "use * from '../catalogos/paises'\nTable empleados {\n  id int [pk]\n  pais_id int [ref: > paises.id]\n}",
  },
  ventas: {
    'ventas.dbml': "use * from '../catalogos/paises'\nuse * from '../empleados/empleados'\nTable pedidos {\n  id int [pk]\n  pais_id int [not null, ref: > paises.id]\n  vendedor_id int [ref: > empleados.id]\n}",
    'detalles.dbml': "use * from './ventas'\nTable detalles {\n  pedido_id int [ref: > pedidos.id]\n  cantidad int\n}",
  },
};

/** Texto de un PDF generado por pdfkit: cada bloque BT…ET escribe sus glifos como `<hex> Tj`. */
export function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  return [...raw.matchAll(/BT([\s\S]*?)ET/g)].map(block => [...block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)].map(m => {
    const hex = m[1]!;
    let text = '';
    for (let i = 0; i < hex.length; i += 2) text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return text;
  }).join('')).join('\n');
}
