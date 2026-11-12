/**
 * "Google" FALSO para las pruebas (ESC-SEG-01): sirve un conjunto de llaves públicas (JWKS) y firma ID tokens a pedido.
 * El backend se apunta aquí con GOOGLE_JWKS_URI (solo fuera de producción), así los casos inválidos
 * (alterado, vencido, de otra aplicación...) se prueban sin depender de Google.
 *
 *   node scripts/load-tests/fake-google.js            # escucha en FAKE_GOOGLE_PORT (4010)
 *
 *   GET  /certs   → JWKS con la llave pública de prueba
 *   POST /sign    → { idToken }   cuerpo: { email, sub, nonce, givenName, familyName, picture,
 *                                           emailVerified, aud, iss, expiresInSeconds, wrongKey }
 */
const http = require('http');
const { generateKeyPairSync } = require('crypto');
const { SignJWT, exportJWK } = require('jose');

const PORT = Number(process.env.FAKE_GOOGLE_PORT ?? 4010);
const DEFAULT_AUDIENCE = process.env.GOOGLE_CLIENT_ID ?? 'sitpverse-test.apps.googleusercontent.com';
const KID = 'fake-google-key-1';

const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
const evil = generateKeyPairSync('rsa', { modulusLength: 2048 }); // el atacante firma con SU llave: no está en el JWKS

async function sign(spec) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    email: spec.email,
    email_verified: spec.emailVerified ?? true,
    // Sin nombre por defecto: así el login no pisa el nombre del seed y las pruebas pueden comprobarlo.
    ...(spec.givenName ? { given_name: spec.givenName } : {}),
    ...(spec.familyName ? { family_name: spec.familyName } : {}),
    picture: spec.picture ?? 'https://lh3.googleusercontent.com/a/foto-de-prueba',
    ...(spec.nonce ? { nonce: spec.nonce } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(spec.sub)
    .setIssuer(spec.iss ?? 'https://accounts.google.com')
    .setAudience(spec.aud ?? DEFAULT_AUDIENCE)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (spec.expiresInSeconds ?? 3600));
  return jwt.sign((spec.wrongKey ? evil : good).privateKey);
}

(async () => {
  const jwk = { ...(await exportJWK(good.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  http
    .createServer((req, res) => {
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/certs') return json(200, { keys: [jwk] });
      if (req.method === 'POST' && req.url === '/sign') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
          try {
            json(200, { idToken: await sign(JSON.parse(raw)) });
          } catch (e) {
            json(400, { error: String(e) });
          }
        });
        return;
      }
      json(404, { error: 'no existe' });
    })
    .listen(PORT, '127.0.0.1', () => console.log(`Google falso en http://127.0.0.1:${PORT} (aud=${DEFAULT_AUDIENCE})`));
})();
