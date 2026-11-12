# Auditoría de seguridad y cumplimiento — Sprint 2

Rama `seguridad` (back y front). Se contrasta el código real contra los **Escenarios de calidad del Sprint 2 (v5)** y
contra el **enunciado "Proyecto Sprint 2"**. Fecha de la auditoría: 2026-11-11.

Leyenda: ✅ cumple · 🟡 cumple a medias · ❌ no cumple.

## 1. Resumen ejecutivo

| Atributo | Escenario | Estado | Lo más importante |
|---|---|---|---|
| Seguridad | ESC-SEG-01 Autenticación | ❌ | El sistema usa **usuario + contraseña (bcrypt)**; el escenario exige **Google OIDC** y 0 contraseñas guardadas. |
| Seguridad | ESC-SEG-02 Autorización | ✅ | Guard global fail-closed, `@Roles`, salas WebSocket por rol, usuario releído en cada petición. |
| Seguridad | ESC-SEG-03 Trazabilidad | ❌ | No existe `audit_log` ni `GET /audit`. Las inspecciones sí son inmutables por API. |
| Mantenibilidad | ESC-MANT-01 Sonar | 🟡 | Añadido `sonar-project.properties` + pasos en CI; falta el secreto `SONAR_TOKEN`. Cobertura back 51,7 % (meta 80 %), front 0 % (meta 40 %). |
| Observabilidad | ESC-OBS-01 | ❌ | No hay `traceId`, `GET /metrics`, Prometheus ni los dos tableros. Solo `GET /health`. |
| Disponibilidad | ESC-DISP-01 | ❌ | Hay 1 instancia (B1); el escenario pide 3 + balanceador. `clientAffinityEnabled=true` (debe estar apagado). |
| Rendimiento | ESC-REND-01 | 🟡 | Existen pruebas de carga de concurrencia; falta medir p50/p95/p99 de extremo a extremo con 200 clientes. |

## 2. Hallazgos de seguridad (ordenados por severidad)

### Alta
1. **Azure `httpsOnly = false` en el App Service.** Permite acceso por HTTP y el JWT viajaría en claro.
   Arreglo: `az webapp update --https-only true`. (No se aplicó; la app está apagada.)
2. **Login con contraseña en vez de Google OIDC** (ESC-SEG-01). Hoy: `POST /auth/login`, `passwordHash` en `users`.
   Requiere `POST /auth/google` (verificación de firma, `iss`, `aud`, `exp`, `email_verified`), campos `email`, `googleSub`,
   `firstName`, `lastName`, `photoUrl`, y quitar `passwordHash`. Es el cambio más grande del sprint.
3. **No hay trazabilidad** (ESC-SEG-03): falta tabla `audit_log` de solo inserción, escrita en la **misma transacción** que
   la acción, y `GET /audit` solo ADMIN. Además hay que revocar `UPDATE/DELETE` sobre esa tabla al usuario de BD de la app.
4. **11 vulnerabilidades en dependencias de producción** (`npm audit`: 5 altas, 6 moderadas): `multer` (varios DoS y
   bypass de límite de tamaño), `qs`, entre otras. Vienen dentro de Nest 10; la corrección es subir a Nest 12
   (cambio mayor, ya aplazado). `qs` se arregla con `npm audit fix` sin romper nada.

### Media
5. **Limitador de peticiones solo en el login.** El escenario pide 429 con `Retry-After` por IP (>10/min en
   `/auth/google`). El resto de endpoints (p. ej. `PATCH /fleet/buses/:id/position`, subida de fotos) no tienen límite.
6. **Afinidad de sesión (ARR) activa** y el cliente Socket.io no fuerza `transports: ['websocket']`
   (ESC-DISP-01 lo exige para que el reintento caiga en una instancia sana).
7. **CORS por defecto `*`** si falta `CORS_ORIGIN` (en producción la app no arranca así: bien; en desarrollo queda abierto).
8. **Contraseña por defecto del seed (`Sitp2026!`) escrita en el repositorio** y contraseñas de demostración compartidas por
   chat. Desaparece al migrar a Google; mientras tanto, rotarlas tras la demo.
9. **Fotos servidas públicamente por URL con UUID.** No se pueden adivinar, pero quien tenga el enlace las ve sin sesión.
   Aceptable para el MVP; documentar la decisión (ADR).

### Baja
10. JWT en `sessionStorage` (expuesto si hubiera XSS). Se revisó el front: no hay `dangerouslySetInnerHTML` ni `eval`.
11. Sin ESLint con reglas de seguridad en el back; el front usa `oxlint` (2 avisos de fast-refresh, no de seguridad).
12. `docs/DEPLOY.md` aún presenta el login con contraseña; actualizar al migrar.

### Lo que ya está bien
- JWT HS256 con algoritmo fijado en `verify` y secreto ≥ 32 caracteres obligatorio en producción.
- Guard global que falla cerrado + prueba de arquitectura R5 (toda ruta con `@Roles` o `@Public`).
- Usuario releído de BD en cada petición y conexión WebSocket (baja/cambio de rol inmediatos).
- Posiciones por WebSocket solo a ADMIN y MECHANICAL; alertas solo a su audiencia; token solo en `auth` (no en la URL).
- Validación de subidas por **firma real del archivo** (JPEG/PNG/WebP) y límite de 5 MB.
- `helmet`, `ValidationPipe` con `whitelist`, `trust proxy`, bloqueo de fuerza bruta en login por cuenta e IP.
- Concurrencia: locks, `FOR UPDATE`, restricciones de BD y outbox transaccional.

## 3. Calidad de código (SonarCloud)

No puedo leer SonarCloud desde aquí: necesita **tu** cuenta y un token. Lo preparado en la rama:

- `sonar-project.properties` (organización `spidersitpverse`, proyecto `SpiderSitpverse_SitpVerseBack`; **confírmalos**).
- `ci.yml`: genera `coverage/lcov.info`, ejecuta el scan y espera el Quality Gate. Se omite si no existe `SONAR_TOKEN`.

Pasos para ti (una sola vez, por repositorio):
1. https://sonarcloud.io → entrar con GitHub → **Analyze new project** → elegir el repo.
2. En **My Account → Security** generar un token y guardarlo en GitHub: *Settings → Secrets → Actions → `SONAR_TOKEN`*.
3. En SonarCloud: *Administration → Analysis Method* → **desactivar "Automatic Analysis"** (si no, choca con el de CI).
4. Hacer push de la rama: en el PR aparecerá el resultado y los registros quedan en SonarCloud.

Medido localmente: back **51,83 % de cobertura** (283 pruebas pasan). Para el bono (80 % back / 40 % front) faltan pruebas
sobre todo en controladores, repositorios Prisma y adaptadores; el front no tiene framework de pruebas (hay que añadir Vitest).

## 4. Cumplimiento del enunciado "Proyecto Sprint 2"

| Requisito | Estado |
|---|---|
| Escalar el back horizontalmente, con balanceador y componentes distribuidos | 🟡 Arquitectura lo permite (estado en Redis/PG); falta desplegar ≥ 2–3 instancias y la prueba |
| 3 escenarios de seguridad aprobados e implementados | 🟡 Escritos; implementado solo SEG-02 |
| Arquitectura actualizada con las tácticas de seguridad | ❌ Pendiente de actualizar el documento |
| Mantenibilidad: Sonar en el pipeline | 🟡 Preparado, falta el token |
| Rendimiento: escenario + prueba de carga | 🟡 Pruebas de concurrencia hechas; falta percentiles con 200 clientes |
| Observabilidad: logs estructurados, métricas y **2 tableros** | ❌ Pendiente |
| Documento de arquitectura PDF (ADR, ≥ 5 UML, despliegue, drivers) | 🟡 Hay diagramas; faltan ADR y secciones |
| SCRUM / Azure DevOps (burndown, HU en DONE) | ⚠️ Fuera del código: lo gestiona el equipo |

## 5. Plan propuesto (orden de prioridad)

1. `httpsOnly`, `npm audit fix`, ARR off y `transports: ['websocket']` (rápido, sin riesgo).
2. Sonar + token y cobertura (back → 80 %, front → Vitest 40 %).
3. `audit_log` + `GET /audit` + prueba de que cada acción crítica deja registro.
4. Login con Google (OIDC) y retiro de contraseñas.
5. Observabilidad: `traceId`, `/metrics`, Prometheus + Grafana (2 tableros).
6. Escalado a 3 instancias y prueba de caída de instancia; actualizar el documento de arquitectura.

## 6. Progreso en la rama `seguridad` (2026-11-11)

| Hallazgo / escenario | Estado ahora |
|---|---|
| `httpsOnly` en Azure (hallazgo 1) | ✅ Activado (HTTP responde 301 a HTTPS). |
| Afinidad de sesión ARR (hallazgo 6) | ✅ Apagada en Azure. Falta `transports: ['websocket']` en el cliente Socket.io. |
| ESC-SEG-01 Autenticación | ✅ Implementado en código y probado: `GET /auth/nonce` + `POST /auth/google` (firma, `iss`, `aud`, `exp`, correo verificado, nonce de un solo uso), 401/403/429, **0 contraseñas** (columna `passwordHash` eliminada). Falta el Client ID real de Google para producción. |
| ESC-SEG-03 Trazabilidad | 🟡 `audit_log` de solo inserción (trigger en la base), escrita en la misma transacción que el cambio, `GET /audit` solo ADMIN. Hoy audita: ingresos (exitosos y rechazados), crear/editar/desactivar usuarios y cambio de rol. Faltan: inspecciones, evidencias, incidentes, grúas, alertas, rutas y viajes. |
| Límite por IP (hallazgo 5) | 🟡 Cubre `/auth/nonce` y `/auth/google` (10/min). El resto de endpoints no tiene límite. |
| Pruebas | 269 pruebas unitarias; `security.js` (ESC-SEG-01 y 03), `access-matrix.js`, `front-flows.js`, `assistance.js`, `fleet.js`, `tow-flows.js`, `help-received.js`, `resolution-concurrency.js` y `admin-delete-photo.js` pasan contra servidor, Postgres y Redis reales, con un Google falso (`scripts/load-tests/fake-google.js`). |
| `npm audit` (hallazgo 4), cobertura, ESLint, observabilidad, 3 instancias | ⏳ Pendiente. |

**Ojo al desplegar:** con `NODE_ENV=production` el back ya no arranca sin `GOOGLE_CLIENT_ID`, y la migración
`20261110000000_google_identity_audit` elimina `passwordHash` (no se puede deshacer). Orden seguro: crear el Client ID,
definirlo en el App Service (y `VITE_GOOGLE_CLIENT_ID` en el front), y recién entonces hacer merge a `main`.

### Actualización (2026-11-12)

- **Solicitudes de acceso** (pedido del equipo): quien entra con Google sin cuenta ya **no recibe un 403 "genérico"**: queda
  en espera (sin rol ni sesión) y el administrador la acepta y le da el rol desde "Usuarios". Esto **cambia el texto de
  ESC-SEG-01** ("403 para cuentas no registradas"): se mantiene el 403 y la ausencia de sesión, pero ahora distingue
  `PENDING_APPROVAL` / `ACCESS_REJECTED`. Una cuenta *desactivada* recibe el mismo mensaje que una en espera. **Hay que avisar al
  profesor** del cambio del escenario. Tope: 200 solicitudes abiertas.
- **Registro de peticiones**: middleware con `trace_id` (header `X-Trace-Id`) y log JSON por petición; logs de App Service en
  filesystem y en Log Analytics (`sitpverse2026-logs`). Cubre una parte de ESC-OBS-01 (falta `/metrics` y los tableros).
- **Calidad**: el análisis de Sonar se corrige en dos pasos (ver sección 3). Cobertura del back con pruebas unitarias + de integración
  (c8) unidas; front con Vitest (138 pruebas).

### Comentarios del profesor sobre los escenarios de seguridad (2026-11-12)

| Comentario | Qué se hizo |
|---|---|
| **Autenticación**: con un proveedor de identidad externo, nada de logins caseros | ✅ Google OpenID Connect; 0 contraseñas (columna eliminada, rutas viejas dan 404). |
| **Autorización**: cambio de rol en todas las pantallas de la app | ✅ El back aplica el rol vigente en cada petición. El front ya lo refleja **en todas las pantallas sin recargar** (chequeo cada 15 s, al volver a la pestaña y tras un 403) y el admin cambia el rol desde "Usuarios". Un cambio de rol también reconecta el WebSocket a las salas del rol nuevo. |
| **Trazabilidad**: en TODAS las peticiones y mínimo Hora, IP, Usuario, Navegador web y País | ✅ Tabla `request_log` (solo inserción) con esos cinco datos para cada petición HTTP, incluidas las rechazadas; `audit_log` ahora guarda también navegador, país y trace_id (se toman de la petición en curso). Consulta: `GET /audit/requests` (solo ADMIN). |

Pendiente de la trazabilidad: auditar en `audit_log` el resto de acciones críticas (inspecciones, incidentes, grúas, alertas,
rutas y viajes), y definir cuánto tiempo se conserva `request_log` (con ~20 posiciones por segundo crece rápido).
