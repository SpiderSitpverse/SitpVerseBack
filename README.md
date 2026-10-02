# SitpVerse Back

Backend de **SitpVerse** (gestión operativa de flota TransMilenio). **Modular Monolith** con
**Arquitectura Hexagonal** por módulo y comunicación **orientada a eventos**
(Outbox → Redis Streams / Pub/Sub → WebSocket).

| Capa | Tecnología |
|---|---|
| Framework | NestJS + TypeScript |
| Base de datos | PostgreSQL vía Prisma |
| Locks / mensajería | Redis (`ioredis`): lock FIFO, Streams, Pub/Sub |
| Tiempo real | Socket.io (`@nestjs/websockets`) |
| Pruebas | Jest (unitarias + arquitectura) y scripts de carga contra el sistema real |

> **Estado del proyecto.** La API real de TransMilenio todavía no está conectada: buses y usuarios se
> siembran (`prisma/seed.ts`), las posiciones las genera un **feed simulado** y el usuario se identifica
> con el header `x-employee-id`. Todo está diseñado para reemplazar esas piezas **sin tocar dominio ni
> casos de uso** (ver [Preparado para la API real](#preparado-para-la-api-real)).

---

## Cómo correrlo

```bash
cp .env.example .env
docker compose up -d            # Postgres + Redis
npm install
npx prisma migrate dev          # aplica las migraciones y genera el cliente
npm run seed                    # 10 usuarios (2 ADMIN, 5 DRIVER, 3 MECHANICAL) y 4 buses con conductor
npm run start:dev
```

Si el puerto 5432 ya lo usa otro Postgres, define `POSTGRES_PORT=5433` y usa ese puerto en
`DATABASE_URL` (ambos en `.env`).

| Comando | Qué hace |
|---|---|
| `npm run start:dev` | Servidor en modo watch |
| `npm run build` / `npm run start:prod` | Compila a `dist/` y corre `node dist/main.js` |
| `npm test` | Pruebas unitarias y de arquitectura (en memoria, sin Docker) |
| `npm run loadtest` | Concurrencia REAL contra el servidor: asistencia + flota (ver [Pruebas](#pruebas)) |
| `npm run loadtest:outbox` | Detiene Redis y comprueba que las alertas no se pierden |
| `npm run seed` | Reinicia los datos de desarrollo (**destructivo**) |

---

## Arquitectura

```
src/
├── main.ts                     # bootstrap: validación, filtro de errores, adaptador WebSocket
├── app.module.ts
├── architecture.spec.ts        # HACE CUMPLIR las reglas de abajo (falla el build si se rompen)
│
├── modules/                    # módulos de negocio; cada uno es hexagonal
│   ├── identity/               # usuarios, autenticación y guard GLOBAL de acceso
│   ├── fleet/                  # estado y posición de los buses, conductor asignado
│   └── assistance/             # alertas con cupos (apoyo de conductores / reparación)
│       ├── domain/             #   entidades, reglas puras (policy), eventos y PORTS (interfaces)
│       ├── application/        #   casos de uso (1 por archivo) + DTOs
│       ├── infrastructure/     #   adapters de SALIDA: Prisma, hacia otros módulos
│       ├── adapters/           #   adapters de ENTRADA: HTTP (controllers), feed
│       ├── test/               #   pruebas del módulo + adaptadores en memoria
│       └── public.ts           #   API pública: lo ÚNICO que otros módulos pueden importar
│
├── realtime/                   # entrega por WebSocket (ningún módulo lo importa)
│   ├── websocket/              #   RealtimeGateway + adaptador Socket.io (CORS)
│   └── subscriptions/          #   Pub/Sub (posiciones) y consumidor de Streams (alertas)
│
└── shared/                     # núcleo compartido (no conoce a ningún módulo)
    ├── domain/                 #   errores, roles, puerto del lock distribuido
    ├── contracts/              #   canales/streams Redis, eventos Socket.io, audiencias
    ├── infrastructure/         #   Prisma, Redis, lock FIFO, log estructurado, outbox/
    ├── http/                   #   AppErrorFilter: errores de dominio → HTTP
    ├── testing/                #   lock en memoria para pruebas
    └── shared.module.ts        #   @Global: UN pool de Prisma, las conexiones Redis, el lock y el outbox
```

### Reglas de arquitectura (las hace cumplir `src/architecture.spec.ts`)

| | Regla |
|---|---|
| **R1** | `domain/` es puro: no importa Nest, Prisma, Redis, Socket.io ni capas externas. |
| **R2** | `application/` no importa Prisma, Redis, Socket.io, Express, `infrastructure/` ni `adapters/`. |
| **R3** | Un módulo solo importa a otro por su **`public.ts`**. |
| **R4** | `shared/` no depende de ningún módulo. |
| **R5** | **Toda ruta HTTP** declara `@Roles(...)` o `@Public()` (el sistema falla cerrado). |

```
adapters / infrastructure  ──►  application  ──►  domain
        (Nest, Prisma, Redis, HTTP)   (casos de uso)   (reglas puras + ports)
```

- Los **ports** (`*.port.ts`) son interfaces; el módulo las enlaza a su adapter con
  `{ provide: PORT, useClass: Adapter }`. Cambiar de ORM o de broker = reescribir un adapter.
- Los **módulos no comparten tablas**: cada uno es dueño de las suyas (`identity` → `users`,
  `fleet` → `buses`, `assistance` → alertas, aceptaciones y puntos). Lo que un módulo necesita de
  otro lo pide por un **port** (p. ej. `BusDirectoryPort` en `assistance`) que se implementa con la
  `public.ts` del otro módulo. Si mañana la flota es otro servicio, solo cambia ese adapter.
- Los módulos se comunican por **eventos** (no por llamadas directas) y `realtime` los entrega.

### Control de acceso (módulo `identity`)

Un **guard global** (`AuthGuard`, registrado con `APP_GUARD`) protege todas las rutas:

1. `@Public()` → pasa.
2. Sin `x-employee-id` válido → **401**.
3. Ruta sin `@Roles(...)` → **403** (falla cerrado: una ruta nueva olvidada no queda abierta).
4. Rol no permitido → **403**.

Además de por **rol**, `fleet` autoriza por **recurso** (`fleet.policy.ts`): un `DRIVER` solo ve y opera
**su** bus (`Bus.driverId`), el `MECHANICAL` puede ver cualquier bus pero no operarlo, el `ADMIN` hace todo.

| Ruta | ADMIN | DRIVER | MECHANICAL |
|---|:-:|:-:|:-:|
| `GET /fleet/buses`, `GET /fleet/buses/:id` | todos | solo el suyo | todos |
| `PATCH /fleet/buses/:id/start-trip · position · finish-trip` | ✔ | solo el suyo | ✘ |
| `GET /fleet/home/operativo` | ✘ | ✔ (su bus) | ✘ |
| `/assistance/*` | ver tabla del módulo | | |

Usuarios del seed: admin `1001`/`1002`, conductores `2001`–`2005` (cada uno con su bus `TMX-001`… `TMX-004`;
`2005` no tiene), mecánicos `3001`–`3003`.

### Errores HTTP

| Error de dominio | HTTP | Ejemplo |
|---|---|---|
| `NotFoundError` | 404 | bus o alerta inexistente |
| `ConflictError` | 409 | cupos tomados, alerta completada, bus ya en servicio |
| `ForbiddenError` | 403 | un DRIVER intenta aceptar una reparación |
| `BusyError` / `LockTimeoutError` | 503 | no se obtuvo el lock a tiempo; reintentar |

Cuerpo: `{ statusCode, error, message, ...detalles }` (p. ej. `reason: "FULL"` al no obtener cupo).

---

## Módulo `fleet`: flota en tiempo real

Un bus pasa por `IDLE → IN_SERVICE → FINISHED` y tiene un conductor asignado. Cada posición se valida
en la entidad `Bus`, se guarda (estado + historial) y se publica; `realtime` la reenvía a todos los clientes.

```
Feed de posiciones ─► UpdateBusPositionUseCase ─► Postgres (estado + historial)
                                              └─► Redis Pub/Sub "fleet:positions" ─► RealtimeGateway ─► clientes
```

Las posiciones usan **Pub/Sub** a propósito: llegan decenas por segundo y perder una no importa, porque
la siguiente la reemplaza. Las **alertas**, que no pueden perderse, usan otro camino (ver más abajo).

| Método | Ruta | HU (story map) |
|---|---|---|
| GET | `/fleet/buses` · `?status=IN_SERVICE` | HU-12 Visualizar buses · HU-14 Filtrar por estado |
| GET | `/fleet/buses/:id` | HU-13 Detalle de un bus |
| PATCH | `/fleet/buses/:id/start-trip` | HU-49 Reportar inicio de viaje |
| PATCH | `/fleet/buses/:id/position` `{latitude, longitude}` | HU-49 Actualizar posición |
| PATCH | `/fleet/buses/:id/finish-trip` | HU-51 Finalizar viaje |
| GET | `/fleet/home/operativo` | HU-11 Home del conductor (su bus) |

```js
import { io } from "socket.io-client";
const socket = io("http://localhost:3000/realtime");
socket.on("fleet:position-updated", (e) => { /* { busId, plate, route, status, latitude, longitude, updatedAt } */ });
```

---

## Módulo `assistance`: alertas con cupos

Dos flujos de negocio, **un mismo mecanismo**: una alerta con `slots` cupos que aceptan varias personas a
la vez y **los primeros en llegar se quedan los cupos** (FIFO estricto). Al llenarse, la alerta se
cierra y se deshabilita la notificación al resto.

| | Uso 1 · Apoyo de conductores | Uso 2 · Reparación |
|---|---|---|
| Origen | El conductor reporta un imprevisto → el ADMIN lo recibe | A un bus se le genera una falla |
| Quién crea la alerta | ADMIN (indica cuántos buses necesita: `slots`) | El sistema (a partir del reporte de falla) |
| Quién la recibe | Conductores (`DRIVER`) | Mecánicos (`MECHANICAL`) |
| Cupos | N (los define el admin) | 1 |
| Recompensa | `rewardPoints` que fija el admin | Bono por bus reparado (`REPAIR_BONUS_POINTS`, 50) |

**Plazo de 20 minutos.** Al aceptar se fija `arriveBy = ahora + ASSISTANCE_ARRIVAL_MINUTES` (20 por
defecto). Lo ven **quien aceptó** y el **admin** (que además sigue el bus en el mapa en tiempo real); `GET
/assistance/calls` incluye `arriveBy` y `overdue`. Si vence y el bus no llegó, el **admin cancela esa
aceptación** (libera el cupo) y **reenvía la alerta** para que otro la tome. Quien fue cancelado no puede
retomar el cupo y **no cobra**.

La recompensa se acredita **al completar**, no al aceptar, y solo a las aceptaciones **activas**.

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/assistance/incidents` | DRIVER | Reporta un imprevisto a administración |
| GET | `/assistance/incidents` | ADMIN | Lista de incidentes |
| POST | `/assistance/incidents/:id/support-call` `{slots, rewardPoints}` | ADMIN | Lanza la alerta a conductores |
| POST | `/assistance/bus-faults` `{busId}` | DRIVER, ADMIN | Alerta de reparación a mecánicos (deduplicada por bus) |
| GET | `/assistance/calls?status=OPEN` | todos | Alertas de tu rol con aceptaciones, `arriveBy` y `overdue` (admin ve todas las aceptaciones; los demás, solo la suya) |
| POST | `/assistance/calls/:id/accept` | DRIVER / MECHANICAL | **201** si tomó cupo · **409** si ya se llenó |
| POST | `/assistance/calls/:id/claims/:claimId/cancel` | ADMIN | Cancela una aceptación que no llegó (libera el cupo) |
| POST | `/assistance/calls/:id/resend` | ADMIN | Reenvía la alerta con los cupos libres |
| POST | `/assistance/calls/:id/complete` | ADMIN; mecánico que la tomó | Cierra y acredita puntos **una sola vez** |
| GET | `/assistance/me` | todos | Perfil y saldo de puntos |

Reglas de negocio (`domain/assistance.policy.ts`, funciones puras): cada tipo de alerta solo la acepta su
rol; el conductor que reportó el incidente no puede aceptar su propia alerta; completar lo hace el ADMIN (o
el mecánico que tomó la reparación).

### Notificaciones en tiempo real

```js
const socket = io("http://localhost:3000/realtime", {
  auth: { employeeId: "2001", lastSeq: localStorage.lastSeq },   // lastSeq: el mayor seq que ya vio (opcional)
});
const seen = new Set();
socket.on("assistance:event", (e) => {
  if (seen.has(e.eventId)) return;          // la entrega es at-least-once: descartar duplicados
  seen.add(e.eventId);
  localStorage.lastSeq = e.seq;             // para que, al reconectar, el servidor reproduzca lo perdido
  /* e: { eventId, seq, type, traceId, occurredAt, audience, payload } */
});
```

| `type` | Quién lo recibe | Cuándo |
|---|---|---|
| `incident.reported` | ADMIN | Un conductor reporta un imprevisto |
| `call.opened` | DRIVER (apoyo) o MECHANICAL (reparación) | Se abre una alerta o se **reenvía** (`resent: true`, `remainingSlots`) |
| `call.progress` | ADMIN | Alguien aceptó o canceló (`claimedCount/slots`; incluye quién, su bus y `arriveBy`) |
| `call.closed` | el rol de la alerta + ADMIN | Se llenó el último cupo → **deshabilitar la notificación** |
| `claim.cancelled` | ADMIN + el cancelado | El admin canceló una aceptación vencida |
| `call.completed` | ADMIN + quienes cobran | Servicio cerrado y puntos acreditados |

---

## Cómo funciona la concurrencia

### El problema

Una alerta pide 3 conductores y 12 la aceptan **al mismo instante**; o 5 mecánicos pulsan "aceptar" sobre
la misma reparación. Un código ingenuo (`leer cupos → si hay, tomar uno`) falla porque entre la lectura y la
escritura otro ya tomó el cupo: se asignan 5 conductores a 3 cupos. Es una **condición de carrera**
(*check-then-act*). Y además: si el cupo se toma pero la notificación se pierde, los demás siguen viendo una
alerta que ya está llena.

### La solución: tres capas para el cupo + un outbox para los eventos

```
POST /assistance/calls/:id/accept          (12 conductores a la vez, 3 cupos)
        │
        ▼
┌─ 0. Reglas baratas (sin lock) ─────────────────────────────────────────────┐
│  ¿existe la alerta? ¿rol correcto? ¿no es su propio incidente?  → 404/403  │
└────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ 1. LOCK DISTRIBUIDO FIFO (Redis)  clave = "lock:assistance-call:<id>" ────┐
│  Cada petición toma un NÚMERO DE TURNO atómico (INCR) y se atiende en ese   │
│  orden estricto: gana quien LLEGÓ primero. Alertas distintas no se bloquean │
│  entre sí; funciona entre varias instancias del backend.                    │
└────────────────────────────────────────────────────────────────────────────┘
        │  de a uno, en orden de llegada
        ▼
┌─ 2. COMPARE-AND-SET ATÓMICO (Postgres, UNA transacción) ───────────────────┐
│  INSERT claim (UNIQUE callId+userId)    ← el mismo usuario no ocupa 2 cupos │
│  UPDATE assistance_calls                                                    │
│     SET claimedCount = claimedCount + 1,                                    │
│         status = CASE WHEN claimedCount + 1 >= slots THEN 'FILLED' ... END  │
│   WHERE id = $1 AND status = 'OPEN' AND claimedCount < slots               │
│  → filas afectadas = 0  ⇒  perdió la carrera ⇒ rollback ⇒ 409              │
│  INSERT outbox_events (call.progress, call.closed…)  ← MISMA transacción    │
└────────────────────────────────────────────────────────────────────────────┘
        │ commit: el cupo Y su evento existen, o ninguno de los dos
        ▼
┌─ 3. BARRERAS EN LA BASE DE DATOS (última defensa) ─────────────────────────┐
│  CHECK (claimedCount <= slots) · UNIQUE (callId, userId)                    │
│  UNIQUE parcial (busId) WHERE kind='REPAIR' AND status <> 'COMPLETED'       │
│  UNIQUE (userId, callId) en el libro de puntos                              │
└────────────────────────────────────────────────────────────────────────────┘
```

**Por qué lock + CAS y no solo uno.** El lock ordena la cola y reduce la contención, pero **no es suficiente
por sí solo**: si el proceso se pausa más que el TTL, la exclusión se pierde. El CAS en Postgres es la
garantía real, y los `CHECK`/`UNIQUE` son la red de seguridad si hubiera un bug. Una prueba lo demuestra:
con el lock desactivado, el sistema sigue sin asignar de más.

### FIFO estricto: el lock de turnos

`RedisDistributedLock` es un *ticket lock*: `INCR` entrega el número de turno (un único punto de
serialización para todas las instancias) y cada petición espera a que `serving + 1 == mi turno`. Quien murió
o se rindió esperando no bloquea la fila: su *lease* expira o se borra y el turno se salta. Si una sección
crítica excediera `ttlMs`, su lease vence y la cola avanza (la decisión real sigue siendo el CAS).

> **Qué significa "primero".** El orden es el de llegada de la petición **al lock** (a Redis), no el instante
> del clic en el teléfono: la latencia de red del cliente queda fuera del control del servidor. Entre dos
> peticiones que llegan con menos de ~10 ms de diferencia el orden depende de qué lectura previa termine antes.

### Outbox transaccional: las alertas no se pierden

```
 caso de uso ──► repositorio: UNA transacción
                    ├─ cambia el estado (cupo, aceptación, puntos…)
                    └─ INSERT en outbox_events            ← mismo commit
                          │
        OutboxRelay (cada instancia; FOR UPDATE SKIP LOCKED; se despierta al confirmar)
                          │ XADD (reintenta si Redis está caído)
                          ▼
                 Redis Stream "assistance:stream"
                          │ XREAD desde el último id leído (no se pierde al reconectar)
                          ▼
        RedisStreamConsumer (TODAS las instancias) ──► salas role:X / user:Y ──► clientes
```

| Garantía | Cómo |
|---|---|
| El estado y su evento son **atómicos** | Se escriben en la misma transacción (no existe "cupo tomado sin evento" ni "evento de algo que hizo rollback"). |
| Redis caído ⇒ **no se pierde** | El evento queda pendiente en Postgres; el relay reintenta (sin cola oculta que duplique) y entrega al volver. |
| Se **reproduce** al reconectar | El cliente envía `lastSeq`; el gateway le re-entrega, en orden, los eventos de su audiencia posteriores a ese `seq`. |
| **At-least-once** + idempotencia | Cada evento lleva `eventId` único; el cliente descarta duplicados. |
| Varias instancias | El relay reparte con `SKIP LOCKED`; cada instancia lee el stream completo para SUS sockets. |

Por qué **Redis Streams** y no Pub/Sub para las alertas: Pub/Sub es "disparar y olvidar" (si el suscriptor
estaba reconectándose, el mensaje se pierde). El stream conserva los mensajes y el consumidor retoma desde
su último id. Los eventos publicados se conservan 24 h en el outbox (para la reproducción).

### Otros puntos de concurrencia resueltos

| Escenario | Mecanismo |
|---|---|
| 12 conductores / 3 cupos | Capas 1+2+3 → exactamente 3 ganan **(los 3 primeros en llegar)**, 9 reciben `409 reason=FULL` |
| El mismo conductor hace doble clic | `UNIQUE(callId, userId)` → solo un cupo (`reason=ALREADY_CLAIMED`) |
| 5 mecánicos / 1 reparación | Igual con `slots = 1` |
| Conductor + admin + doble clic reportan la misma falla | Índice único parcial por bus → **una** alerta y **un** evento |
| 2 admins lanzan la alerta del mismo incidente | CAS `REPORTED → HELP_REQUESTED` en la misma transacción que crea la alerta |
| "Completar" llega 5 veces | CAS `OPEN/FILLED → COMPLETED` + `UNIQUE(userId, callId)`: **los puntos se pagan una vez** |
| Cancelar la misma aceptación 2 veces | CAS `ACTIVE → CANCELLED`: gana una; `claimedCount` nunca baja de 0 |
| Cancelar mientras otros aceptan | Mismo lock FIFO que aceptar: no se pisan |
| Posición del feed vs. fin de viaje (flota) | `save()` con CAS sobre el estado leído: el bus no "resucita" |
| 10 `start-trip` a la vez (flota) | Igual: exactamente 1 gana, el resto `409 STALE_STATE` |

### Garantías y límites (leer antes de confiar a ciegas)

- **El lock expira (TTL 5 s).** Si una sección crítica durara más, la exclusión se pierde; por eso la decisión
  real la toma el CAS de Postgres, no el lock.
- **Si Redis cae**, aceptar/cancelar alertas deja de funcionar (el lock es requisito) y responde `503`: no
  hay asignaciones inconsistentes, simplemente se rechazan. Reportar incidentes y fallas **sí** funciona
  (solo usa Postgres + outbox) y sus alertas se entregan al volver Redis.
- **Las posiciones GPS no usan outbox** (son efímeras): perder una no afecta, la siguiente la reemplaza. Dos
  posiciones pueden llegar desordenadas; el cliente descarta las de `updatedAt` más viejo.
- **El plazo de 20 min es informativo**: no hay un temporizador en el servidor que cancele solo; el admin decide
  (ve la ubicación en el mapa). `overdue` y `arriveBy` están en `GET /assistance/calls` para pintar la alerta.
- **Alertas ya aceptadas y el outbox**: si el proceso muere entre publicar en el stream y marcar la fila,
  el evento se republica (at-least-once). Por eso el cliente deduplica por `eventId`.
- **Seguridad provisional**: el header `x-employee-id` no es una credencial (cualquiera que conozca un
  número se hace pasar por ese empleado). Es el puente hasta el login real (JWT).

### Observabilidad

Cada lock emite un log JSON (`lock.released`) con `trace_id`, `lock`, `ticket`, `severity`, `waited_ms`
(contención) y `held_ms`; `WARN` si esperó más de 50 ms y `lock.timeout` (ERROR) si se rindió. El outbox
emite `outbox.publish_failed` (con `pending_lag_ms`) y `outbox.relay_failed`. Cada petición lleva un
`traceId` que reaparece en los eventos publicados.

```json
{"event":"lock.released","trace_id":"…","lock":"lock:assistance-call:…","ticket":4,"severity":"WARN","waited_ms":33,"held_ms":4}
```

---

## Preparado para la API real

Cada pieza provisional está aislada detrás de un punto de cambio único:

| Hoy (provisional) | Mañana | Qué cambia |
|---|---|---|
| **Feed simulado** de posiciones (`fleet/adapters/feed/simulated-fleet-feed.adapter.ts`) | API de TransMilenio | Crear un `TransmilenioFleetFeedAdapter` junto al simulador que llame al **mismo** `UpdateBusPositionUseCase`, y poner `FLEET_FEED_MODE=external`. Nada más. |
| Reporte de falla por conductor/admin (`ReportBusFaultUseCase`) | Detección automática por telemetría | El adapter que detecte la falla invoca el mismo caso de uso. |
| Header `x-employee-id` (`AuthenticateEmployeeUseCase`) | JWT / login real | Cambia solo ese caso de uso (y `PrismaUserDirectory` si los empleados vienen de otro sistema); todos consumen `AuthenticatedUser`. |
| Buses y usuarios del `seed` | Datos reales | Sincronizar `buses` / `users` desde la fuente real. |

El simulador **no es lógica de negocio**: solo mueve buses `IN_SERVICE` cada `FLEET_SIMULATION_INTERVAL_MS`
para ver el mapa y el tiempo real funcionando sin API.

---

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `CORS_ORIGIN` | `*` | Orígenes permitidos (coma) para HTTP **y** WebSocket |
| `DATABASE_URL` | — | Conexión a Postgres |
| `POSTGRES_PORT` | `5432` | Puerto publicado por docker compose |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Redis |
| `FLEET_FEED_MODE` | `simulated` | `simulated` \| `external` (apaga el simulador) |
| `FLEET_SIMULATION_INTERVAL_MS` | `3000` | Frecuencia del simulador |
| `REPAIR_BONUS_POINTS` | `50` | Bono por defecto por bus reparado |
| `ASSISTANCE_ARRIVAL_MINUTES` | `20` | Plazo para llegar tras aceptar una alerta |
| `OUTBOX_POLL_MS` | `250` | Sondeo del relay del outbox (además se despierta al confirmar) |

---

## Pruebas

```bash
npm test                 # unitarias + arquitectura (en memoria, sin Docker)
npm run start:dev        # en otra terminal, con `npm run seed` reciente:
npm run loadtest         # concurrencia REAL: Postgres + Redis + WebSocket (asistencia + flota)
npm run loadtest:outbox  # detiene Redis un momento y verifica que las alertas no se pierden
```

- **`npm test`** (`src/**/*.spec.ts`): reglas de dominio (asistencia y acceso a buses), el guard global, el
  filtro de errores, **las reglas de arquitectura** y la concurrencia con repositorios en memoria que hacen
  `await` entre operaciones para intercalar peticiones como una BD real. Cubre cupos, FIFO, plazo y
  cancelación, doble clic, completar repetido, dedupe de fallas, 300 aceptaciones simultáneas y atomicidad de
  eventos (los rechazados no generan eventos).
- **`npm run loadtest`** (`scripts/load-tests/assistance.js` y `fleet.js`): las mismas carreras contra el
  servidor real, con sockets por rol; verifica estado en BD, notificaciones, FIFO con peticiones
  escalonadas, cancelar/reenviar, reproducción al reconectar, puntos y control de acceso por rol/propiedad.
  Requiere `npm run seed` antes.
- **`npm run loadtest:outbox`** (`scripts/load-tests/outbox-recovery.js`): detiene Redis, reporta un
  incidente (se guarda), comprueba que el evento queda pendiente, reinicia Redis y verifica que llega
  **una sola vez**.

> Las pruebas de carga corren a mano. Cuando se despliegue conviene ejecutarlas en el pipeline (CI) contra
> un entorno efímero con Postgres y Redis.

---

## Pendiente según el story map

Login real con contraseña y JWT (HU-01…03), gestión de usuarios (HU-04…06), Inspecciones y evidencia
fotográfica (Épica 3), rutas alternativas y alertas de bloqueo (Feature 2.2), KPIs y dashboard (Épica 5), y
pruebas de carga en CI.
