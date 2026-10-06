# SitpVerse Back

Backend de **SitpVerse**: gestión operativa de flota TransMilenio con seguimiento en tiempo real y
asignación concurrente de ayuda (apoyo de conductores y reparación de buses).

> La API real de TransMilenio aún no está conectada. Buses y usuarios se siembran y las posiciones las
> genera un feed simulado. Todo está aislado para reemplazarlo sin tocar la lógica de negocio.

---

## Tecnologías

| | |
|---|---|
| **NestJS + TypeScript** | Framework; módulos e inyección de dependencias |
| **PostgreSQL + Prisma** | Base de datos (la fuente de verdad) |
| **Redis** | Lock distribuido, Streams y Pub/Sub |
| **Socket.io** | Notificaciones en tiempo real por WebSocket |
| **Jest** | Pruebas unitarias y de arquitectura |

---

## Arquitectura

**Monolito modular** con **arquitectura hexagonal** en cada módulo y comunicación por **eventos**.

```
              HTTP / WebSocket
                    │
   ┌────────────────▼─────────────────────────────────────┐
   │  identity        fleet          assistance           │   módulos de negocio
   │  usuarios y      buses y        alertas, cupos       │   (se hablan solo por su public.ts)
   │  acceso          posición       y puntos             │
   │                        │ eventos                     │
   │  realtime: entrega por WebSocket                     │   nadie lo importa
   │  shared: Prisma · Redis · lock FIFO · outbox         │   núcleo común
   └───────────────┬───────────────────────┬──────────────┘
                   ▼                       ▼
              PostgreSQL                 Redis
```

### Estructura de carpetas

```
src/
├── modules/
│   ├── identity/      login, usuarios (alta, edición, desactivación), guard global de roles
│   ├── fleet/         buses y su ficha, conductor asignado, posición en tiempo real
│   ├── assistance/    alertas con cupos, aceptaciones, puntos, informes de reparación
│   ├── inspections/   inspección previa al viaje con fotos (inmutable)
│   └── uploads/       subida de fotos
│       ├── domain/          reglas puras y "ports" (interfaces)
│       ├── application/     casos de uso (uno por archivo)
│       ├── infrastructure/  adapters de salida: Prisma, otros módulos
│       ├── adapters/        adapters de entrada: HTTP
│       ├── test/            pruebas del módulo
│       └── public.ts        lo único que otros módulos pueden importar
├── realtime/          WebSocket: Gateway y consumidores de Redis
├── shared/            errores, roles, lock FIFO, outbox, conexiones
└── architecture.spec.ts
```

### Capas de cada módulo

```
adapters / infrastructure  ──►  application  ──►  domain
 (HTTP, Prisma, Redis)         (casos de uso)    (reglas + ports)
        Las dependencias solo apuntan hacia adentro.
```

- El **dominio** contiene las reglas del negocio y no conoce Nest, Prisma ni Redis.
- Los **ports** son interfaces; los adapters las implementan. Cambiar de base de datos o de broker es
  reescribir un adapter.
- Cada módulo es **dueño de sus tablas**; lo que necesita de otro lo pide por su `public.ts`.

### Reglas que se hacen cumplir

Un test (`architecture.spec.ts`) falla si alguien las rompe:

1. `domain/` es puro (sin frameworks ni ORM).
2. `application/` no importa Prisma, Redis, Socket.io ni HTTP.
3. Un módulo solo importa a otro por su `public.ts`.
4. `shared/` no depende de ningún módulo.
5. Toda ruta HTTP declara `@Roles(...)` o `@Public()`.

---

## Funcionamiento

### Acceso: login, roles y usuarios de demostración

Se inicia sesión con **número de empleado y contraseña** y se recibe un token JWT:

```
POST /auth/login   { "employeeId": "2001", "password": "Sitp2026!" }
→ { "accessToken": "...", "expiresIn": 28800, "user": { "id", "employeeId", "name", "role" } }
```

El token viaja en `Authorization: Bearer <token>` (HTTP) y en `auth: { token }` al abrir el WebSocket.
`GET /auth/me` devuelve quién eres según el token. Un guard global protege todas las rutas: sin token
válido responde 401, y una ruta sin rol declarado se rechaza (falla cerrado). Las contraseñas se guardan
cifradas (bcrypt) y el rol se lee de la base de datos en cada petición.

| Rol | Usuarios (contraseña `Sitp2026!`) | Puede |
|---|---|---|
| **ADMIN** | `1001` a `1005` | Ver y operar todos los buses y el mapa en vivo; recibir incidentes; lanzar, cancelar, reenviar y cerrar alertas; rutas alternativas y grúas |
| **DRIVER** | `2001` a `2005` (cada uno con su bus `TMX-001`…`TMX-005`) | Operar su bus y enviar su ubicación; reportar incidentes y bloqueos; subir fotos; aceptar alertas de apoyo y rutas alternativas |
| **MECHANICAL** | `3001` a `3005` | Ver buses y el mapa en vivo; subir fotos; aceptar reparaciones y completarlas |

`npm run seed` crea o actualiza estos 15 usuarios y 5 buses **sin borrar nada**; `npm run seed:reset` vacía la
base de datos y la siembra de nuevo (solo desarrollo). La contraseña sale de `SEED_PASSWORD`: cámbiala si la
base es visible fuera del equipo. Un conductor solo ve y opera **su** bus.

**Fotos:** `POST /files/images` (multipart, campo `photo`, JPEG/PNG/WebP hasta 5 MB) devuelve una URL `/uploads/<id>.<ext>`
que luego se envía en inspecciones e informes; el archivo se valida por su contenido y se guarda con nombre aleatorio.
La evidencia de incidentes se sube con `POST /assistance/incidents/:id/evidence/upload`.

**Para conectar el front:** ver [`docs/API.md`](docs/API.md) (pantalla por pantalla, tipos, WebSocket y fotos).

### Flota (`fleet`)

Cada bus pasa por `IDLE → IN_SERVICE → FINISHED`. Las posiciones se guardan y se emiten por WebSocket a
administradores y mecánicos autenticados (el conductor las envía con `PATCH /fleet/buses/:id/position`).

| Ruta | Descripción |
|---|---|
| `GET /fleet/buses` · `/:id` | Listar y ver detalle (el conductor solo ve el suyo) |
| `PATCH /fleet/buses/:id/start-trip · position · finish-trip` | Iniciar viaje, actualizar posición, terminar |
| `GET /fleet/home/operativo` | Home del conductor |

### Asistencia (`assistance`)

Dos usos con el mismo mecanismo: una **alerta con cupos** que aceptan varias personas a la vez, y **los
primeros en llegar se quedan los cupos**.

| | Apoyo de conductores | Reparación |
|---|---|---|
| Origen | Un conductor reporta un imprevisto; el admin lo recibe | A un bus se le genera una falla |
| Quién la lanza | El admin, indicando cuántos buses necesita | El sistema |
| Quién la recibe | Conductores | Mecánicos |
| Cupos | N | 1 |
| Recompensa | La define el admin | Bono por bus reparado (50) |

Al llenarse los cupos, la alerta se cierra y se deshabilita la notificación al resto. Quien acepta tiene
**20 minutos para llegar**; el admin lo ve junto con la ubicación del bus. Si vence, el admin **cancela esa
aceptación** (libera el cupo) y **reenvía la alerta**. Los puntos se acreditan al completar el servicio.

| Ruta | Rol | Descripción |
|---|---|---|
| `POST /assistance/incidents` | DRIVER | Reportar un imprevisto |
| `POST /assistance/incidents/:id/support-call` | ADMIN | Lanzar alerta de apoyo (`slots`, `rewardPoints`) |
| `POST /assistance/bus-faults` | DRIVER, ADMIN | Alertar a mecánicos |
| `GET /assistance/calls` | todos | Alertas de tu rol, con plazo `arriveBy` |
| `POST /assistance/calls/:id/accept` | DRIVER, MECHANICAL | Tomar un cupo (409 si se llenó) |
| `POST /assistance/calls/:id/claims/:claimId/cancel` | ADMIN | Cancelar una aceptación vencida |
| `POST /assistance/calls/:id/resend` | ADMIN | Reenviar la alerta |
| `POST /assistance/calls/:id/complete` | ADMIN, mecánico | Cerrar y pagar puntos |
| `GET /assistance/me` | todos | Perfil y puntos |

## Concurrencia

### El problema

Una alerta pide 3 conductores y 12 la aceptan **al mismo instante**. Si el código lee los cupos y luego
escribe, entre una cosa y otra otro ya tomó el cupo: se asignan 12 conductores a 3 cupos.

### La solución

```
accept (12 conductores a la vez, 3 cupos)
   │
   ▼  1. LOCK FIFO en Redis (una fila por alerta)
   │     cada petición toma un número de turno y se atiende en orden de llegada
   ▼  2. UNA transacción en Postgres
   │     UPDATE ... SET claimedCount + 1 WHERE claimedCount < slots     ← solo gana quien encuentra cupo
   │     INSERT en outbox_events (el evento)                            ← mismo commit
   ▼  3. Barreras en la base de datos
         CHECK (claimedCount <= slots) · UNIQUE (alerta, usuario) · UNIQUE (usuario, alerta) en puntos
```

- El **lock** ordena la fila y reduce la contención. No es suficiente solo: si el proceso se pausa más que
  su tiempo de vida, se pierde la exclusión.
- El **UPDATE condicional** es la garantía real: la base de datos decide quién gana el cupo.
- Las **restricciones** son la última defensa si hubiera un bug.

Con el lock desactivado el sistema sigue sin asignar de más.

### Qué resuelve

| Escenario | Resultado |
|---|---|
| 12 conductores sobre 3 cupos | Exactamente 3 ganan: los 3 primeros en llegar |
| Doble clic del mismo conductor | Un solo cupo |
| 5 mecánicos sobre 1 reparación | Gana 1 |
| Varios reportes de falla del mismo bus | Una sola alerta y una sola notificación |
| "Completar" repetido | Los puntos se pagan una vez |
| Posición del feed contra fin de viaje | El bus no "resucita" (escritura con compare-and-set) |

### Las alertas no se pierden (Outbox)

El evento se guarda **en la misma transacción** que el cambio. Un relay lo publica después en Redis
Streams, y de ahí llega por WebSocket.

```
cambio de estado + evento ──► Postgres (una transacción)
                                   │ relay (reintenta si Redis está caído)
                                   ▼
                          Redis Stream ──► WebSocket ──► clientes
```

- Si Redis cae, el evento queda pendiente y se entrega al volver, una sola vez.
- Si un cliente se desconecta, al volver envía `lastSeq` y el servidor le reproduce lo que se perdió.
- La entrega es "al menos una vez": cada evento trae `eventId` y el cliente descarta duplicados.
- Las posiciones GPS no usan outbox: perder una no importa, la siguiente la reemplaza.

### Qué significa "primero"

El orden es el de llegada de la petición al lock en Redis, no el instante del clic en el teléfono: la red
del cliente queda fuera del control del servidor. Dos peticiones con menos de ~10 ms de diferencia pueden
salir en cualquier orden.

## HUs del MVP cubiertas en esta rama

Esta rama reúne las 21 HU definidas para el segundo corte del MVP:

| HU | Descripción | Dónde vive |
|---|---|---|
| HU-02 | Iniciar sesión | `identity` y guard global |
| HU-09 | Home para usuarios operativos | `GET /fleet/home/operativo` |
| HU-10 | Home para usuarios administrativos | Home administrativo del frontend con APIs protegidas por rol |
| HU-11 | Acceso según el rol | `AuthGuard` + `@Roles(...)` + `BusAccessService` |
| HU-12 | Visualizar ubicación de los buses | `GET /fleet/buses` + eventos de posición |
| HU-13 | Consultar información detallada de un bus | `GET /fleet/buses/:id` |
| HU-14 | Filtrar buses por estado | `GET /fleet/buses?status=` |
| HU-16 | Recibir alertas de bloqueos | `GET /assistance/blockages` + WebSocket |
| HU-17 | Aceptar rutas alternativas | `POST /assistance/routes/:routeId/accept` |
| HU-22 | Adjuntar evidencia fotográfica | `POST /assistance/incidents/:id/evidence` |
| HU-30 | Asignar grúas y cuadrillas | `POST /assistance/blockages/:id/tow` |
| HU-44 | Enviar alertas de bloqueos a la flota | `POST /assistance/blockages/:id/alert` |
| HU-45 | Listar incidentes registrados en ruta | `GET /assistance/blockages` |
| HU-46 | Visualizar rutas alternativas en tiempo real | `GET /assistance/incidents/:id/routes` + WebSocket |
| HU-47 | Asignar una ruta alternativa desde el mapa | `POST /assistance/incidents/:id/routes` + `/assign` |
| HU-48 | Consultar servicio/ruta asignada | `GET /assistance/routes/assigned/me` |
| HU-49 | Reportar inicio de viaje y actualizar posición | `start-trip` + `position` + WebSocket |
| HU-50 | Consultar reportes de grúas y cuadrillas | `GET /assistance/tow-reports` |
| HU-51 | Finalizar servicio/viaje del bus | `PATCH /fleet/buses/:id/finish-trip` |
| HU-52 | Aceptar ruta alternativa asignada | `POST /assistance/routes/:routeId/accept` |
| HU-53 | Aceptar servicio de reparación | `POST /assistance/calls/:id/accept` |

### Reporte de implementación

- **21 HU implementadas** en backend.
- **58 pruebas automatizadas exitosas** en 7 suites.
- Build de NestJS exitoso.
- Esquema Prisma válido y formateado.
- Pruebas de arquitectura y autorización activas.
- Eventos durables publicados mediante outbox y Redis Streams.

La evidencia fotográfica de HU-22 se guarda como metadatos y URL (`url`, `caption`, `capturedAt`);
la carga binaria debe realizarse desde un almacenamiento externo como Azure Blob Storage. Esta API
no contiene credenciales ni implementa almacenamiento de archivos por sí misma.

## Endpoints del segundo corte

### Bloqueos, incidentes y recursos

```text
GET  /assistance/blockages
POST /assistance/blockages
POST /assistance/blockages/:id/alert
POST /assistance/blockages/:id/tow
GET  /assistance/tow-reports
```

### Rutas alternativas

```text
GET  /assistance/incidents/:id/routes
POST /assistance/incidents/:id/routes
POST /assistance/routes/:routeId/assign
GET  /assistance/routes/assigned/me
POST /assistance/routes/:routeId/accept
```

### Evidencia fotográfica

```text
POST /assistance/incidents/:id/evidence
GET  /assistance/incidents/:id/evidence
```

## Eventos realtime del segundo corte

```text
blockage.reported
blockage.alerted
tow.assigned
route.proposed
route.assigned
route.accepted
incident.evidence.attached
```

## Validación local

```bash
npm run build
npm test -- --runInBand
npx prisma validate
npx prisma format --check
```

Resultado esperado:

```text
Build: PASS
Tests: 7 suites, 58 tests passed
Prisma validate: PASS
Prisma format: PASS
```
