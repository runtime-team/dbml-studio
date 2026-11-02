import { describe, expect, test } from 'bun:test';
import { compileProject } from '../src/project/compiler';
import { compileDiagrams } from '../src/diagram/model';
import { buildReferenceIndex, connectorTarget, describeRelation, focusNode, goBack, goForward, navigate, rankItems, resolveOwnerTarget } from '../src/diagram/navigation';
import { buildProjectPath, parseProjectPath, readShareToken, withShareToken } from '../src/collaboration/links';
import { EMPRESA, makeProject } from './helpers';

const diagrams = () => { const project = makeProject(EMPRESA, { ventas: { external: [{ table: 'public.paises', display: 'connector', label: 'CAT-01', id: 'c' }] } }); return compileDiagrams(project, compileProject(project)); };

describe('navegación', () => {
  test('el índice global distingue referencias entrantes y salientes y paquetes relacionados', () => {
    const index = buildReferenceIndex(diagrams());
    const paises = index.get('public.paises')!;
    expect(paises.owner).toBe('catalogos');
    expect(paises.incoming).toHaveLength(3); // estados, empleados y pedidos
    expect(paises.outgoing).toHaveLength(0);
    expect(paises.relatedPackages.sort()).toEqual(['catalogos', 'empleados', 'ventas']);
    expect(paises.externalIn.sort()).toEqual(['empleados', 'ventas']);
    expect(paises.packages.sort()).toEqual(['catalogos', 'empleados', 'ventas']);
    const pedidos = index.get('public.pedidos')!;
    expect(pedidos.outgoing).toHaveLength(2);
    expect(pedidos.incoming).toHaveLength(1); // detalles
    expect(index.get('public.detalles')!.outgoing[0]).toBeDefined();
  });

  test('describeRelation indica la contraparte y el paquete al que navegar', () => {
    const index = buildReferenceIndex(diagrams());
    const incoming = index.get('public.paises')!.incoming.map(r => describeRelation(index, 'public.paises', r));
    expect(incoming.every(v => v.direction === 'incoming')).toBe(true);
    const fromVentas = incoming.find(v => v.otherTableId === 'public.pedidos')!;
    expect(fromVentas).toMatchObject({ otherPackage: 'ventas', columns: ['id'], otherColumns: ['pais_id'] });
  });

  test('un conector navega al diagrama del paquete propietario y se puede volver', () => {
    const all = diagrams();
    const ventas = all.find(d => d.packageId === 'ventas')!;
    const target = connectorTarget(ventas.connectors[0]!);
    expect(target).toEqual({ packageId: 'catalogos', tableId: 'public.paises' });
    const state = navigate({ current: { packageId: 'ventas' }, back: [], forward: [] }, target);
    expect(state.current).toEqual(target);
    expect(focusNode(all.find(d => d.packageId === 'catalogos'), target.tableId)).toMatchObject({ kind: 'local', tableId: 'public.paises' });
    const back = goBack(state);
    expect(back.current).toEqual({ packageId: 'ventas' });
    expect(goForward(back).current).toEqual(target);
    expect(goBack(goBack(state))).toEqual(goBack(state)); // sin más historial
  });

  test('navegar al mismo destino no duplica el historial y resolveOwnerTarget encuentra el propietario', () => {
    const state = { current: { packageId: 'a', tableId: 't' }, back: [], forward: [] };
    expect(navigate(state, { packageId: 'a', tableId: 't' })).toBe(state);
    expect(resolveOwnerTarget(diagrams(), 'public.pedidos')).toEqual({ packageId: 'ventas', tableId: 'public.pedidos' });
    expect(resolveOwnerTarget(diagrams(), 'public.nada')).toBeUndefined();
  });

  test('el historial se limita a 100 entradas', () => {
    let state = { current: { packageId: 'p0' }, back: [] as { packageId: string }[], forward: [] as { packageId: string }[] };
    for (let i = 1; i <= 150; i++) state = navigate(state, { packageId: `p${i}` });
    expect(state.back).toHaveLength(100);
    expect(state.back[0]!.packageId).toBe('p50');
  });

  test('el selector rápido ordena por prefijo, subcadena y subsecuencia', () => {
    const names = ['empleados', 'ventas', 'catalogos', 'ventas_historicas', 'inventario'];
    expect(rankItems('ven', names, n => n).map(r => r.item)).toEqual(['ventas', 'ventas_historicas', 'inventario']);
    expect(rankItems('', names, n => n).map(r => r.item)).toEqual(names);
    expect(rankItems('cts', names, n => n).map(r => r.item)).toEqual(['catalogos']);
    expect(rankItems('zzz', names, n => n)).toEqual([]);
    expect(rankItems('VENTAS', names, n => n)[0]!.item).toBe('ventas');
  });
});

describe('enlaces directos', () => {
  test('se construyen y analizan con identificadores estables', () => {
    const path = buildProjectPath({ projectId: 'abc123', packageId: 'ventas', tableId: 'public.pedidos', connectorId: 'connector:x:y' });
    expect(path).toBe('/projects/abc123/packages/ventas?table=public.pedidos&connector=connector%3Ax%3Ay');
    const [pathname, search] = path.split('?');
    expect(parseProjectPath(pathname!, `?${search}`)).toEqual({ projectId: 'abc123', packageId: 'ventas', tableId: 'public.pedidos', connectorId: 'connector:x:y' });
    expect(parseProjectPath('/projects/abc123')).toEqual({ projectId: 'abc123', packageId: undefined, tableId: undefined, connectorId: undefined });
    expect(parseProjectPath('/otra/ruta')).toBeUndefined();
    expect(parseProjectPath('/projects/%E0%A4%A')).toBeUndefined();
  });

  test('el secreto de un enlace de acceso viaja en el fragmento', () => {
    const url = withShareToken('https://app.example.com/projects/abc?table=x#viejo', 'se/cr+eto');
    expect(url).toBe('https://app.example.com/projects/abc?table=x#share=se%2Fcr%2Beto');
    expect(readShareToken(new URL(url).hash)).toBe('se/cr+eto');
    expect(readShareToken('')).toBeUndefined();
  });
});
