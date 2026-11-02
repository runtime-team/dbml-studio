import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileProject } from '../src/project/compiler';
import { compileDiagramSet } from '../src/diagram/model';
import { buildReferenceIndex } from '../src/diagram/navigation';
import { buildDependencyGraph } from '../src/project/dependencies';
import { allColumnsOf, colorFor, defaultCompactColumns, displayPatch, initials, isSaveShortcut, problemsByPackage, sourceFileForPackage, timeAgo, viewIdOf } from '../src/ui/logic';
import { applyDiagramPatch } from '../src/project/diagram-config';
import { transformIndex } from '../src/ui/editor';
import { targetExists } from '../src/ui/comments';
import { ContextMenu } from '../src/ui/context-menu';
import { Switcher } from '../src/ui/switcher';
import { Problems } from '../src/ui/problems';
import { Inspector } from '../src/ui/inspector';
import { Workspace } from '../src/ui/workspace';
import { ProjectManager } from '../src/ui/project-manager';
import { DiagramCanvas } from '../src/ui/canvas';
import { EMPRESA, makeProject } from './helpers';

function build(diagrams: Record<string, any> = {}) {
  const project = makeProject(EMPRESA, diagrams);
  const compiled = compileProject(project);
  const set = compileDiagramSet(project, compiled);
  return { ...set, compiled, graph: buildDependencyGraph(compiled, set.diagrams) };
}
const noop = async () => {};

describe('lógica de la interfaz', () => {
  test('displayPatch conserva la posición de un nodo cuando su identificador cambia', () => {
    const { diagrams } = build();
    const ventas = diagrams.find(d => d.packageId === 'ventas')!;
    const paises = ventas.nodes.find(n => n.tableId === 'public.paises')!;
    expect(viewIdOf(paises, 'ventas')).toBe('main');
    const { patch, nodeId } = displayPatch(ventas, paises, 'compact', allColumnsOf(diagrams, paises.tableId));
    expect(nodeId).toBe('node:ventas:public.paises:main');
    expect(patch.renameNodes).toEqual({ [paises.id]: nodeId });
    expect(patch.views!.upsert![0]).toMatchObject({ table: 'public.paises', display: 'compact', id: 'main', show: ['id'] });
    // Aplicado a la configuración, el diagrama resultante tiene el nodo con su posición.
    const config = applyDiagramPatch({ layout: { [paises.id]: { x: 40, y: 56 } } }, patch, 'ventas');
    expect(config.layout).toEqual({ [nodeId]: { x: 40, y: 56 } });
    const rebuilt = build({ ventas: config }).diagrams.find(d => d.packageId === 'ventas')!;
    expect(rebuilt.nodes.find(n => n.id === nodeId)).toMatchObject({ display: 'compact', columns: ['id'] });
    expect(rebuilt.layout).toEqual({ [nodeId]: { x: 40, y: 56 } });
  });

  test('un nodo con vista configurada reutiliza su id y el modo conector conserva la etiqueta', () => {
    const { diagrams } = build({ ventas: { external: [{ table: 'public.paises', display: 'connector', id: 'enlace', label: 'CAT-01' }] } });
    const ventas = diagrams.find(d => d.packageId === 'ventas')!;
    const node = ventas.nodes.find(n => n.tableId === 'public.paises')!;
    expect(viewIdOf(node, 'ventas')).toBe('enlace');
    const { patch } = displayPatch(ventas, node, 'full', allColumnsOf(diagrams, node.tableId));
    expect(patch.renameNodes).toBeUndefined();
    expect(displayPatch(ventas, node, 'connector', []).patch.views!.upsert![0]!.label).toBe('CAT-01');
    expect(viewIdOf({ ...node, id: 'node:ventas:public.paises:0' }, 'ventas')).toBe('main'); // índice numérico → sin id propio
  });

  test('las columnas compactas por defecto son las claves y las que participan en relaciones', () => {
    const { diagrams } = build();
    const ventas = diagrams.find(d => d.packageId === 'ventas')!;
    const paises = ventas.nodes.find(n => n.tableId === 'public.paises')!;
    expect(defaultCompactColumns(ventas, paises, paises.columns)).toEqual(['id']);
    expect(allColumnsOf(diagrams, 'public.paises')).toEqual(['id', 'nombre', 'continente']);
  });

  test('cuenta errores y advertencias por paquete', () => {
    const map = problemsByPackage([{ message: 'a', packageId: 'x' }, { message: 'b', packageId: 'x', severity: 'warning' }, { message: 'c' }, { message: 'd', packageId: 'y', severity: 'error' }]);
    expect(map.get('x')).toEqual({ errors: 1, warnings: 1 });
    expect(map.get('y')).toEqual({ errors: 1, warnings: 0 });
    expect(map.size).toBe(2);
  });

  test('al cambiar de paquete el editor abre el ultimo archivo elegido de esa vista', () => {
    const files = [
      { packageId: 'catalogos', filename: 'paises.dbml' },
      { packageId: 'ventas', filename: 'pedidos.dbml' },
      { packageId: 'ventas', filename: 'detalles.dbml' },
    ];
    expect(sourceFileForPackage(files, 'ventas')).toBe(files[1]);
    expect(sourceFileForPackage(files, 'ventas', 'ventas/detalles.dbml')).toBe(files[2]);
    expect(sourceFileForPackage(files, 'nada')).toBeUndefined();
  });

  test('Ctrl+S o Cmd+S se reconocen como guardar, pero no Ctrl+Shift+S', () => {
    expect(isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSaveShortcut({ key: 'S', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: true })).toBe(false);
    expect(isSaveShortcut({ key: 'k', ctrlKey: true, metaKey: false })).toBe(false);
  });

  test('transformIndex mantiene el cursor local ante cambios remotos', () => {
    expect(transformIndex(5, [{ insert: 'abc' }, { retain: 10 }])).toBe(8); // inserción antes del cursor
    expect(transformIndex(5, [{ retain: 7 }, { insert: 'abc' }])).toBe(5); // después del cursor
    expect(transformIndex(5, [{ retain: 2 }, { delete: 2 }])).toBe(3);
    expect(transformIndex(5, [{ retain: 3 }, { delete: 10 }])).toBe(3); // el cursor cae en un borrado
    expect(transformIndex(0, [{ insert: 'x' }])).toBe(1);
  });

  test('targetExists distingue entidades presentes y desaparecidas', () => {
    const { diagrams } = build({ ventas: { external: [{ table: 'public.paises', display: 'connector', id: 'c' }] } });
    const relation = diagrams.find(d => d.packageId === 'ventas')!.relationships[0]!.id;
    const connector = diagrams.find(d => d.packageId === 'ventas')!.connectors[0]!.id;
    for (const [targetType, targetId] of [['project', 'x'], ['package', 'ventas'], ['table', 'public.pedidos'], ['column', 'public.pedidos.pais_id'], ['relationship', relation], ['connector', connector]] as const) expect(targetExists(diagrams, { targetType, targetId })).toBe(true);
    for (const [targetType, targetId] of [['package', 'nada'], ['table', 'public.paises.x'], ['table', 'public.paises:x'], ['column', 'public.pedidos.nada'], ['relationship', 'relationship:no'], ['connector', 'connector:no']] as const) expect(targetExists(diagrams, { targetType, targetId })).toBe(false);
  });

  test('colorFor, initials y timeAgo son deterministas', () => {
    expect(colorFor('abc')).toBe(colorFor('abc'));
    expect(colorFor(null)).toMatch(/^#/);
    expect(initials('maría')).toBe('MA');
    expect(initials(null)).toBe('?');
    const now = 1_000_000_000;
    expect([timeAgo(now - 5000, now), timeAgo(now - 120_000, now), timeAgo(now - 3 * 3600_000, now)]).toEqual(['hace unos segundos', 'hace 2 min', 'hace 3 h']);
  });
});

describe('render de componentes', () => {
  test('ContextMenu es un menú accesible con separadores y opciones deshabilitadas', () => {
    const html = renderToStaticMarkup(<ContextMenu x={10} y={10} close={() => {}} label="Acciones de pedidos" actions={[{ label: 'Abrir', run: () => {} }, { separator: true, label: '' }, { label: 'Borrar', disabled: true }]}/>);
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Acciones de pedidos"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toContain('role="separator"');
    expect(html).toMatch(/<button role="menuitem" disabled=""[^>]*><span>Borrar/);
  });

  test('Switcher lista paquetes con su estado y es un combobox', () => {
    const { diagrams } = build();
    const html = renderToStaticMarkup(<Switcher diagrams={diagrams} active="ventas" problems={new Map([['catalogos', { errors: 2, warnings: 0 }]])} onOpen={() => {}} onClose={() => {}}/>);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html).toContain('activo');
    expect(html).toContain('2 error(es)');
  });

  test('Problems muestra archivo, línea, código y sugerencia', () => {
    const html = renderToStaticMarkup(<Problems onClose={() => {}} onOpen={() => {}} diagnostics={[{ message: 'Falta algo', filepath: 'ventas/pedidos.dbml', location: { start: { line: 3, column: 7 } }, code: 'STU003', suggestion: "Añade use * from '../catalogos/paises'", packageId: 'ventas' }]}/>);
    expect(html).toContain('ventas/pedidos.dbml:3:7 · STU003');
    expect(html).toContain('Sugerencia: Añade use');
  });

  test('DiagramCanvas dibuja el SVG con nodos enfocables', () => {
    const { diagrams } = build();
    const html = renderToStaticMarkup(<DiagramCanvas diagram={diagrams[2]!} view={{ zoom: 0.5, left: 0, top: 0 }} editable onView={() => {}} onSelectNode={() => {}} onSelectRelationship={() => {}} onActivateNode={() => {}} onNodeMenu={() => {}} onMove={() => {}} commentCounts={{ 'table|public.pedidos': 2 }}/>);
    expect(html).toContain('data-editable="true"');
    expect(html).toContain('scale(0.5)');
    expect(html.match(/data-node=/g)!.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('class="comment-badge"');
    expect(html).toContain('2 discusiones abiertas en pedidos');
  });

  test('Inspector muestra referencias entrantes y salientes y permite navegar', () => {
    const { diagrams } = build();
    const index = buildReferenceIndex(diagrams);
    const catalogos = diagrams.find(d => d.packageId === 'catalogos')!;
    const node = catalogos.nodes.find(n => n.tableId === 'public.paises')!;
    const html = renderToStaticMarkup(<Inspector diagram={catalogos} index={index} node={node} onNavigate={() => {}} onSelectRelationship={() => {}} onShowDefinition={() => {}}/>);
    expect(html).toContain('Referencias entrantes <b>3</b>');
    expect(html).toContain('Relaciones salientes <b>0</b>');
    expect(html).toContain('pedidos');
    expect(html).toContain('ventas');
    expect(html).toContain('PK');
    const empty = renderToStaticMarkup(<Inspector diagram={catalogos} index={index} onNavigate={() => {}} onSelectRelationship={() => {}} onShowDefinition={() => {}}/>);
    expect(empty).toContain('Selecciona una tabla');
  });

  test('Workspace renderiza pestañas, paquetes, dependencias y el diagrama activo', () => {
    const { diagrams, diagnostics, graph } = build({ ventas: { external: [{ table: 'public.paises', display: 'connector', label: 'CAT-01', id: 'c' }] } });
    const html = renderToStaticMarkup(<Workspace projectName="empresa" diagrams={diagrams} diagnostics={diagnostics} graph={graph} editable initial={{ packageId: 'ventas' }} onDiagramPatch={noop} onExport={noop} fetchDefinition={async () => undefined}/>);
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>ventas/);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<h1>ventas</h1>');
    expect(html).toContain('CAT-01');
    expect(html).toContain('Dependencias');
    expect(html).toContain('Esquema compilado');
    expect(html).toContain('Reorganizar');
    expect(html).toContain('Exportar');
    expect(html).toContain('Ctrl K');
  });

  test('Workspace coloca el editor a la izquierda del visor y conserva inspector y navegación', () => {
    const { diagrams, diagnostics, graph } = build();
    const html = renderToStaticMarkup(<Workspace projectName="empresa" diagrams={diagrams} diagnostics={diagnostics} graph={graph} editable bottom={<section className="editor">DBML</section>} onDiagramPatch={noop} onExport={noop} fetchDefinition={async () => undefined}/>);
    expect(html).toContain('class="workbench with-editor"');
    expect(html.indexOf('class="editor-pane"')).toBeLessThan(html.indexOf('class="diagram-pane"'));
    expect(html).toContain('aria-label="Diagramas por paquete"');
    expect(html).toContain('class="inspector"');
    expect(html).toContain('DBML');
  });

  test('Workspace muestra controles accesibles para ocultar el inspector y administrar el proyecto', () => {
    const { diagrams, diagnostics, graph } = build();
    const projectControl = <ProjectManager current={{ name: 'empresa', manifestPath: 'C:\\proyectos\\empresa\\dbml.project.yaml' }} onOpen={async () => true} onCreate={async () => true}/>;
    const html = renderToStaticMarkup(<Workspace projectName="empresa" projectControl={projectControl} diagrams={diagrams} diagnostics={diagnostics} graph={graph} editable onDiagramPatch={noop} onExport={noop} fetchDefinition={async () => undefined}/>);
    expect(html).toContain('aria-label="Ocultar inspector"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('empresa');
    const recovery = renderToStaticMarkup(<ProjectManager standalone onOpen={async () => true} onCreate={async () => true}/>);
    expect(recovery).toContain('Abrir proyecto local');
    expect(recovery).toContain('Nuevo proyecto');
    expect(recovery).toContain('Proyectos compartidos');
  });

  test('Workspace en solo lectura oculta la edición y avisa cuando se muestra una versión anterior', () => {
    const { diagrams } = build();
    const html = renderToStaticMarkup(<Workspace projectName="p" diagrams={diagrams} diagnostics={[{ message: 'roto', severity: 'error', packageId: 'catalogos', code: 1 }]} stale editable={false} onDiagramPatch={noop} onExport={noop} fetchDefinition={async () => undefined}/>);
    expect(html).not.toContain('Reorganizar');
    expect(html).toContain('última versión válida');
    expect(html).toContain('1 error(es)');
    expect(html).toContain('badge-error');
  });

  test('Workspace sin diagramas explica el motivo en vez de fallar', () => {
    const html = renderToStaticMarkup(<Workspace projectName="p" diagrams={[]} diagnostics={[{ message: 'x', severity: 'error' }]} editable onDiagramPatch={noop} onExport={noop} fetchDefinition={async () => undefined}/>);
    expect(html).toContain('Sin diagramas');
    expect(html).toContain('errores');
  });
});
