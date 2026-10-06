import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';

/**
 * Hace CUMPLIR la arquitectura: si alguien rompe una regla, este test falla en CI.
 *
 *  R1  domain/       no importa frameworks ni infraestructura (es puro).
 *  R2  application/  no importa Prisma, Redis, Socket.io, Express ni adapters/infrastructure.
 *  R3  Un módulo solo importa a otro por su `public.ts`.
 *  R4  shared/       no depende de ningún módulo (el núcleo no conoce a quien lo usa).
 *  R5  Toda ruta HTTP declara @Roles(...) o @Public() (el sistema falla cerrado).
 */
const SRC = resolve(__dirname);

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = listSources(SRC).filter((f) => !f.includes(`${sep}testing${sep}`) && !f.includes(`${sep}test${sep}`));
const rel = (f: string) => f.slice(SRC.length + 1).split(sep).join('/');

interface Import { file: string; spec: string; resolved?: string }

function importsOf(file: string): Import[] {
  const text = readFileSync(file, 'utf8');
  const out: Import[] = [];
  for (const match of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    const spec = match[1];
    out.push({
      file,
      spec,
      resolved: spec.startsWith('.')
        ? resolve(file, '..', spec).slice(SRC.length + 1).split(sep).join('/')
        : undefined,
    });
  }
  return out;
}

const allImports = files.flatMap(importsOf);
const moduleOf = (path: string) => /^modules\/([^/]+)\//.exec(path)?.[1];

describe('Reglas de arquitectura', () => {
  it('R1: domain/ es puro (sin frameworks, ORM, Redis ni capas externas)', () => {
    const forbidden = /^(@nestjs\/|@prisma\/|ioredis|socket\.io|express|class-validator)/;
    const violations = allImports
      .filter((i) => /\/domain\//.test(`/${rel(i.file)}`))
      .filter(
        (i) =>
          forbidden.test(i.spec) ||
          /\/(infrastructure|adapters|application)\//.test(`/${i.resolved ?? ''}`),
      )
      .map((i) => `${rel(i.file)} importa "${i.spec}"`);
    expect(violations).toEqual([]);
  });

  it('R2: application/ no depende de Prisma, Redis, Socket.io, Express, infrastructure ni adapters', () => {
    const forbidden = /^(@prisma\/|ioredis|socket\.io|express)/;
    const violations = allImports
      .filter((i) => /\/application\//.test(`/${rel(i.file)}`))
      .filter(
        (i) => forbidden.test(i.spec) || /\/(infrastructure|adapters)\//.test(`/${i.resolved ?? ''}`),
      )
      .map((i) => `${rel(i.file)} importa "${i.spec}"`);
    expect(violations).toEqual([]);
  });

  it('R3: un módulo solo importa a otro por su public.ts', () => {
    const violations = allImports
      .filter((i) => i.resolved)
      .filter((i) => {
        const from = moduleOf(rel(i.file));
        const to = moduleOf(i.resolved!);
        // Cualquier archivo (módulo o no) que entre a modules/Y/... debe usar modules/Y/public
        return to !== undefined && to !== from && i.resolved !== `modules/${to}/public`;
      })
      .map((i) => `${rel(i.file)} importa "${i.spec}" (usa modules/<x>/public)`);
    expect(violations).toEqual([]);
  });

  it('R4: shared/ no depende de ningún módulo ni de realtime', () => {
    const violations = allImports
      .filter((i) => rel(i.file).startsWith('shared/'))
      .filter((i) => /^(modules|realtime)\//.test(i.resolved ?? ''))
      .map((i) => `${rel(i.file)} importa "${i.spec}"`);
    expect(violations).toEqual([]);
  });

  it('R5: cada ruta HTTP declara @Roles(...) o @Public()', () => {
    const problems: string[] = [];
    for (const file of files.filter((f) => f.endsWith('.controller.ts'))) {
      const text = readFileSync(file, 'utf8');
      const routes = (text.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm) ?? []).length;
      const policies = (text.match(/^\s*@(Roles|Public)\(/gm) ?? []).length;
      if (routes !== policies) {
        problems.push(`${rel(file)}: ${routes} rutas pero ${policies} políticas de acceso`);
      }
    }
    expect(problems).toEqual([]);
  });
});
