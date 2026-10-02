# SitpVerse Back

Backend de **SitpVerse**: gestión operativa de flota TransMilenio con seguimiento en tiempo real y
asignación concurrente de ayuda (apoyo de conductores y reparación de buses).

> La API real de TransMilenio aún no está conectada. Buses y usuarios se siembran, las posiciones las
> genera un feed simulado y el usuario se identifica con el header `x-employee-id`. Todo está aislado para
> reemplazarlo sin tocar la lógica de negocio.

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
│   ├── identity/      usuarios, autenticación, guard global de roles
│   ├── fleet/         buses, conductor asignado, posición en tiempo real
│   └── assistance/    alertas con cupos, aceptaciones, puntos
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

### Roles y acceso

Un guard global protege todas las rutas: sin `x-employee-id` válido responde 401, y una ruta sin rol
declarado se rechaza (falla cerrado). Además, un conductor solo ve y opera **su** bus.

| Rol | Puede |
|---|---|
| **ADMIN** | Ver y operar todos los buses; recibir incidentes; lanzar, cancelar, reenviar y cerrar alertas |
| **DRIVER** | Operar su bus; reportar imprevistos; aceptar alertas de apoyo |
| **MECHANICAL** | Ver buses; aceptar reparaciones y completarlas |

Usuarios del seed: admin `1001`/`1002`, conductores `2001`–`2005`, mecánicos `3001`–`3003`.

### Flota (`fleet`)

Cada bus pasa por `IDLE → IN_SERVICE → FINISHED`. Las posiciones se guardan y se emiten por WebSocket a
todos los clientes.

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
