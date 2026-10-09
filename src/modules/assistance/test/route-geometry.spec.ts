import { InvalidInputError } from '../../../shared/domain/errors';
import { MAX_ROUTE_POINTS, parseRouteGeometry } from '../domain/route-geometry';

const bogota = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [4.6 + i * 0.0001, -74.1 + i * 0.0001]);

function rejects(input: unknown, message?: RegExp) {
  try {
    parseRouteGeometry(input);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).details.reason).toBe('INVALID_GEOMETRY');
    if (message) expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error('Debió rechazar la geometría');
}

describe('parseRouteGeometry (HU-46/47)', () => {
  it('acepta una ruta de puntos [lat, lng] y la devuelve igual', () => {
    const route: [number, number][] = [
      [4.6097, -74.0817],
      [4.65, -74.09],
    ];
    expect(parseRouteGeometry(route)).toEqual(route);
  });

  it('acepta los extremos válidos del planeta', () => {
    expect(parseRouteGeometry([[-90, -180], [90, 180]])).toHaveLength(2);
  });

  it('rechaza lo que no es una lista', () => {
    rejects(undefined);
    rejects(null);
    rejects('4.6,-74.1');
    rejects({ lat: 4.6, lng: -74.1 });
  });

  it('exige al menos 2 puntos: con 0 o 1 no hay trazado que dibujar', () => {
    rejects([], /al menos 2/);
    rejects([[4.6, -74.1]], /al menos 2/);
  });

  it(`limita el tamaño a ${MAX_ROUTE_POINTS} puntos`, () => {
    expect(parseRouteGeometry(bogota(MAX_ROUTE_POINTS))).toHaveLength(MAX_ROUTE_POINTS);
    rejects(bogota(MAX_ROUTE_POINTS + 1), /como máximo/);
  });

  it('rechaza puntos que no son pares y dice cuál falla', () => {
    rejects([[4.6, -74.1], [4.7]], /Punto 1/);
    rejects([[4.6, -74.1], [4.7, -74.2, 10]], /Punto 1/);
    rejects([[4.6, -74.1], 'x'], /Punto 1/);
    rejects([null, [4.6, -74.1]], /Punto 0/);
  });

  it('rechaza coordenadas que no son números finitos', () => {
    rejects([[4.6, -74.1], ['4.7', '-74.2']], /números/);
    rejects([[4.6, -74.1], [NaN, -74.2]], /números/);
    rejects([[4.6, -74.1], [Infinity, -74.2]], /números/);
    rejects([[4.6, -74.1], [null, -74.2]], /números/);
  });

  it('rechaza latitudes y longitudes fuera de rango', () => {
    rejects([[4.6, -74.1], [91, -74.2]], /latitud/);
    rejects([[4.6, -74.1], [-90.5, -74.2]], /latitud/);
    rejects([[4.6, -74.1], [4.7, 181]], /longitud/);
    rejects([[4.6, -74.1], [4.7, -200]], /longitud/);
  });

  it('el error indica el índice del punto que falla para que el front lo marque', () => {
    try {
      parseRouteGeometry([[4.6, -74.1], [4.7, -74.2], [999, 0]]);
      throw new Error('Debió fallar');
    } catch (error) {
      expect((error as InvalidInputError).details.index).toBe(2);
    }
  });
});
