# SitpVerse Back

Backend de SitpVerse — **Modular Monolith** con **Arquitectura Hexagonal** por módulo,
más un flujo **Event-Driven** (Redis Pub/Sub) para el monitoreo en tiempo real de la flota.

## Stack

- **NestJS + TypeScript**
- **PostgreSQL** vía **Prisma**
- **Redis** (cache + Pub/Sub) vía `ioredis`
- **Socket.io** (WebSocket Gateway) vía `@nestjs/websockets`

## Por qué esto y no otra cosa

- Nest da módulos + inyección de dependencias "de fábrica", que calzan perfecto con
  `domain / application / infrastructure / adapters` sin pelear contra el framework.
- Identity queda **fuera de alcance de este sprint**: el login es simulado en el
  frontend (`localStorage`), tal como lo definió el profesor. Todo el esfuerzo de
  backend se puso en **Fleet + Realtime**, que es donde está el reto de concurrencia.
- Como todavía no hay acceso a la API real de buses de TransMilenio, se dejó un
  **adapter simulador** (`fleet/adapters/simulation/fleet-simulator.service.ts`) que
  mueve los buses "en servicio" cada pocos segundos. El día que exista acceso real,
  se agrega un adapter HTTP nuevo implementando el mismo flujo — el dominio y los
  casos de uso no cambian ni un carácter.

## Estructura

```
src/
├── modules/
│   └── fleet/
│       ├── domain/            # Entidades, value objects y PORTS (interfaces)
│       ├── application/       # Casos de uso (1 por HU) + DTOs
│       ├── infrastructure/    # Implementaciones de los ports: Prisma, Redis
│       └── adapters/
│           ├── http/          # Controller REST (adapter de entrada)
│           └── simulation/    # Simulador del feed externo (adapter de entrada)
│
├── realtime/
│   ├── websocket/              # FleetGateway (Socket.io, namespace /realtime)
│   └── subscriptions/          # Puente Redis -> WebSocket
│
└── shared/
    └── infrastructure/         # PrismaService, providers de Redis
```

## Flujo end-to-end (el corazón del sprint)

```
FleetSimulator (o API real futura)
        │  llama a
        ▼
UpdateBusPositionUseCase
        │  1. aplica regla de negocio en la entidad Bus
        │  2. guarda estado + historial en Postgres (Prisma)
        │  3. publica evento en Redis (canal fleet:positions)
        ▼
RedisSubscriberService (en RealtimeModule)
        │  recibe el mensaje de Redis
        ▼
FleetGateway.broadcastPositionUpdate()
        │  server.emit("fleet:position-updated", event)
        ▼
Frontend (React) conectado por Socket.io
```

Redis en el medio es lo que permite que, si más adelante corren varias instancias del
backend, todas se enteren del cambio y lo reenvíen a **sus propios** clientes
conectados — no solo la instancia que recibió la actualización.

## Endpoints REST

```
GET   /fleet/buses                 -> lista todos los buses (o ?status=IN_SERVICE)
GET   /fleet/buses/:id             -> detalle de un bus
PATCH /fleet/buses/:id/start-trip  -> HU-49 (parte 1)
PATCH /fleet/buses/:id/position    -> HU-49 (parte 2) { latitude, longitude }
PATCH /fleet/buses/:id/finish-trip -> HU-51
```

## WebSocket

```js
import { io } from "socket.io-client";
const socket = io("http://localhost:3000/realtime");
socket.on("fleet:position-updated", (event) => {
  // event: { busId, plate, route, status, latitude, longitude, updatedAt }
});
```

## Cómo correrlo

```bash
cp .env.example .env
docker compose up -d          # levanta Postgres + Redis
npm install
npx prisma migrate dev --name init
npm run seed                  # crea 4 buses de prueba
npm run start:dev
```

Para probar el flujo realtime sin frontend: pon un bus en servicio y mira los eventos
que llegan por WebSocket mientras el simulador lo mueve solo cada
`FLEET_SIMULATION_INTERVAL_MS`:

```bash
curl -X PATCH http://localhost:3000/fleet/buses/<ID>/start-trip
```

## Nota sobre este entorno de generación

Al armar este scaffold, `npx prisma generate` no pudo descargar sus binarios porque
este sandbox no tiene salida a `binaries.prisma.sh`. En tu máquina, con internet
normal, ese comando corre sin problema — es el primer paso del "Cómo correrlo" de
arriba y es indispensable antes de levantar el proyecto.
