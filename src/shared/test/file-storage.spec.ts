import { ConfigService } from '@nestjs/config';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { detectImageType } from '../domain/file-storage.port';
import { LocalFileStorage } from '../infrastructure/storage/local-file-storage';
import { resolveUploadsDir, uploadsDirWarning } from '../infrastructure/storage/uploads-dir';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);

describe('detectImageType: se valida el CONTENIDO, no el nombre ni el Content-Type', () => {
  it('reconoce JPEG, PNG y WebP por su firma', () => {
    expect(detectImageType(JPEG)).toBe('jpeg');
    expect(detectImageType(PNG)).toBe('png');
    expect(detectImageType(WEBP)).toBe('webp');
  });

  it.each([
    ['un script', Buffer.from('<?php system($_GET["c"]); ?>')],
    ['un HTML con XSS', Buffer.from('<html><script>alert(1)</script></html>')],
    ['un ejecutable de Windows', Buffer.from('MZ\x90\x00\x03\x00\x00\x00')],
    ['un PDF', Buffer.from('%PDF-1.7')],
    ['un archivo vacío', Buffer.alloc(0)],
    ['un RIFF que no es WebP (WAV)', Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVEfmt ')])],
  ])('rechaza %s', (_name, content) => {
    expect(detectImageType(content)).toBeNull();
  });
});

describe('LocalFileStorage', () => {
  let dir: string;
  let storage: LocalFileStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sitp-uploads-'));
    storage = new LocalFileStorage({ get: () => dir } as unknown as ConfigService);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('guarda la imagen con nombre aleatorio y extensión según su tipo real', async () => {
    const { url } = await storage.saveImage(PNG, 'png');
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
    expect(readFileSync(join(dir, url.split('/').pop()!))).toEqual(PNG);
  });

  it('dos subidas iguales no se pisan', async () => {
    const a = await storage.saveImage(JPEG, 'jpeg');
    const b = await storage.saveImage(JPEG, 'jpeg');
    expect(a.url).not.toBe(b.url);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('remove borra el archivo', async () => {
    const { url } = await storage.saveImage(JPEG, 'jpeg');
    await storage.remove(url);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('remove no puede salirse de la carpeta de subidas (path traversal)', async () => {
    const outside = join(dir, '..', `sitp-fuera-${Date.now()}.txt`);
    require('fs').writeFileSync(outside, 'no me borres');
    await storage.remove(`/uploads/../${outside.split(/[\\/]/).pop()}`);
    expect(existsSync(outside)).toBe(true);
    rmSync(outside);
  });
});

describe('Carpeta de fotos según dónde corre la app', () => {
  const env = (vars: Record<string, string>) => (key: string) => vars[key];

  it('en tu PC (sin variables): ./uploads', () => {
    expect(resolveUploadsDir(env({}))).toBe(resolve('uploads'));
  });

  it('en Azure App Service sin configurar nada: /home/uploads (así no se pierden al reiniciar)', () => {
    expect(resolveUploadsDir(env({ WEBSITE_SITE_NAME: 'sitpverse-api' }))).toBe('/home/uploads');
  });

  it('UPLOADS_DIR siempre manda, también en Azure', () => {
    expect(resolveUploadsDir(env({ WEBSITE_SITE_NAME: 'x', UPLOADS_DIR: '/home/fotos' }))).toBe(resolve('/home/fotos'));
  });

  it('un UPLOADS_DIR vacío se ignora', () => {
    expect(resolveUploadsDir(env({ WEBSITE_SITE_NAME: 'x', UPLOADS_DIR: '  ' }))).toBe('/home/uploads');
  });

  it('avisa si en Azure las fotos van a un lugar que se borra', () => {
    expect(uploadsDirWarning('/tmp/uploads', env({ WEBSITE_SITE_NAME: 'x' }))).toMatch(/se perderán al reiniciar/);
    expect(uploadsDirWarning('/app/uploads', env({ WEBSITE_SITE_NAME: 'x' }))).not.toBeNull();
  });

  it('no avisa si van a /home, ni fuera de Azure (donde el disco es normal)', () => {
    expect(uploadsDirWarning('/home/uploads', env({ WEBSITE_SITE_NAME: 'x' }))).toBeNull();
    expect(uploadsDirWarning('/tmp/uploads', env({}))).toBeNull();
  });
});
