# Guía de la API para el front

Para conectar `SitpVerseFront` (React + Vite + Tailwind) con este back. Todo lo que hoy el front guarda en
`localStorage` tiene aquí su endpoint; la guía sigue las pantallas del front.

- [1. Conexión, sesión y errores](#1-conexión-sesión-y-errores)
- [2. Pantallas → endpoints](#2-pantallas--endpoints)
- [3. Cómo se traducen los tipos del front](#3-cómo-se-traducen-los-tipos-del-front)
- [4. Fotos](#4-fotos)
- [5. Tiempo real (WebSocket)](#5-tiempo-real-websocket)
- [6. Ubicación del conductor](#6-ubicación-del-conductor)
- [7. Lo que el back todavía no tiene](#7-lo-que-el-back-todavía-no-tiene)

---

## 1. Conexión, sesión y errores

**URL base:** `http://localhost:3000` en desarrollo. En el front, una variable de entorno:

```
VITE_API_URL=http://localhost:3000
```

**CORS:** el back acepta los orígenes de `CORS_ORIGIN` (por defecto `http://localhost:5173`, el de Vite).
Al desplegar, pon ahí la URL del front.

### Iniciar sesión

```
POST /auth/login        { "employeeId": "2001", "password": "Sitp2026!" }
→ 200 { "accessToken": "eyJ…", "expiresIn": 28800, "user": { "id", "employeeId", "name", "role" } }
→ 401 { "message": "Credenciales inválidas" }       (usuario inexistente o contraseña incorrecta: mismo mensaje)
```

- `role` es `ADMIN`, `DRIVER` o `MECHANICAL`.
- El token dura 8 horas (`expiresIn` en segundos). Guárdalo (en `sessionStorage`, como ya haces con la sesión).
- Cada petición lleva `Authorization: Bearer <accessToken>`.
- `GET /auth/me` devuelve el usuario del token (para restaurar la sesión al recargar).
- **Cualquier `401` ⇒ la sesión terminó** (token vencido o cuenta desactivada): limpia la sesión y vuelve a `/login`.
- `403` ⇒ el usuario no tiene permiso para esa acción (el back valida el rol aunque el front ya oculte el botón).

### Usuarios de demostración (contraseña `Sitp2026!`)

| Rol | Número de empleado | Equivale en el front a |
|---|---|---|
| ADMIN | `1001` a `1005` | `admin` |
| DRIVER | `2001` a `2005` (cada uno con su bus `TMX-001`…`TMX-005`) | `conductor`, `conductor2` |
| MECHANICAL | `3001` a `3005` | `mecanico` |

El campo de login del front (`userId`) pasa a ser el **número de empleado**. El `nombre` que muestra la barra
superior es `user.name`.

### Formato de los errores

```json
{ "statusCode": 409, "error": "CONFLICT", "message": "Los cupos de esta alerta ya fueron tomados", "reason": "FULL" }
```

| Código | Significa |
|---|---|
| 400 | Datos inválidos (el `message` dice cuál; los de validación vienen como lista) |
| 401 | Sin sesión, token vencido o credenciales inválidas |
| 403 | Tu rol no puede hacer esto, o el recurso no es tuyo (p. ej. el bus de otro conductor) |
| 404 | No existe |
| 409 | Choca con el estado actual. `reason` dice por qué (`FULL`, `PLATE_TAKEN`, `EMPLOYEE_ID_TAKEN`, `DRIVER_ALREADY_ASSIGNED`, `REPORT_FINALIZED`…) |
| 413 | La foto pesa más de 5 MB |
| 503 | El sistema está saturado: reintentar |

---

## 2. Pantallas → endpoints

### Login (`LoginPage`)

| Acción | Endpoint |
|---|---|
| Iniciar sesión | `POST /auth/login` |
| Restaurar sesión | `GET /auth/me` |

### Configuración (`SettingsPage`) — cambiar contraseña

```
POST /auth/change-password   { "currentPassword": "…", "newPassword": "…" }
→ 204    · 401 la actual es incorrecta · 400 la nueva es débil (mín. 8 caracteres, con letras y números) · 409 igual a la actual
```

### Usuarios (`UsersPage`, solo ADMIN)

| Acción | Endpoint |
|---|---|
| Listar personal | `GET /users` → `[{ id, employeeId, name, role, active, createdAt }]` |
| Crear | `POST /users` `{ employeeId, name, role, password }` → 409 `EMPLOYEE_ID_TAKEN` si ya existe |
| Editar nombre o rol | `PATCH /users/:id` `{ name?, role? }` |
| Desactivar / reactivar | `PATCH /users/:id` `{ "active": false }` (no borra el historial; la cuenta no puede entrar y su token deja de valer) |
| Restablecer contraseña | `POST /users/:id/reset-password` `{ newPassword }` → 204 |

Un admin no puede desactivarse ni quitarse el rol a sí mismo, y nunca queda el sistema sin un admin activo (409).

### Flota y mapa (`FleetPage`, `TransMilenioMap`, `HomePage`)

| Acción | Endpoint | Roles |
|---|---|---|
| Resumen del panel | `GET /fleet/summary` → `{ total, inService, idle, finished }` | ADMIN, MECHANICAL |
| Resumen de incidentes y alertas | `GET /assistance/summary` → `{ incidentsLast24h, openSupportCalls, openRepairCalls, repairsInProgress, repairsCompletedLast24h, openBlockages }` | ADMIN |
| Listar buses / buses en viaje | `GET /fleet/buses` · `GET /fleet/buses?status=IN_SERVICE` | ADMIN, MECHANICAL (el conductor solo ve el suyo) |
| Detalle de un bus | `GET /fleet/buses/:id` | ídem |
| Posiciones en vivo | WebSocket `fleet:position-updated` (ver §5) | ADMIN, MECHANICAL |

Un bus: `{ id, plate, route, status, latitude, longitude, locationLabel, model, year, operator, capacity, driverId, driver, tripStartedAt, updatedAt }`.

### Registro de flota (`FleetRegistryPage`, solo ADMIN)

| Acción | Endpoint |
|---|---|
| Alta de un bus | `POST /fleet/buses` `{ plate, route, model?, year?, operator?, capacity?, locationLabel? }` → 409 `PLATE_TAKEN` |
| Editar la ficha | `PATCH /fleet/buses/:id` (los mismos campos, todos opcionales) |
| Asignar conductor | `PATCH /fleet/buses/:id/driver` `{ "driverId": "<id de usuario>" }` · `{ "driverId": null }` para quitarlo |
| Última inspección del bus | `GET /inspections/buses/:id/latest` (404 si nunca se inspeccionó) |
| Historial de inspecciones | `GET /inspections?busId=&inspector=&from=&to=&take=&skip=` |

Un conductor solo puede tener **un** bus (409 `DRIVER_ALREADY_ASSIGNED`). La placa se guarda en mayúsculas.

### Inicio del conductor (`DriverHomePage`)

| Acción | Endpoint |
|---|---|
| Mi bus asignado (reemplaza `driverAssignments`) | `GET /fleet/home/operativo` → `{ busId, plate, route, status, hasActiveTrip, latitude, longitude, updatedAt }` |
| Subir las fotos de la inspección | `POST /files/images` (una por foto, ver §4) |
| Registrar la inspección previa | `POST /inspections` `{ busId, note, comment?, photos: ["/uploads/…"] }` |
| Iniciar viaje | `PATCH /fleet/buses/:id/start-trip` |
| Enviar mi ubicación | `PATCH /fleet/buses/:id/position` `{ latitude, longitude }` (ver §6) |
| Finalizar viaje | `PATCH /fleet/buses/:id/finish-trip` |
| Reportar un problema (modal "Reportar") | `POST /assistance/incidents` `{ busId, type, description }` (`type` = el motivo; `description` = el detalle) |

Un conductor solo puede inspeccionar y operar **su** bus (403 con otro).

### Ayuda entre conductores (`DriverHelpPage`)

El flujo del negocio tiene un paso de administración: **el conductor reporta → el admin decide cuántos
conductores necesita → los conductores aceptan; los primeros que aceptan se quedan con los cupos.**

| Quién | Acción | Endpoint |
|---|---|---|
| Conductor | Reporta el problema | `POST /assistance/incidents` |
| Admin | Ve los reportes | `GET /assistance/incidents` → incluye `reportedByName` |
| Admin | Lanza la solicitud de ayuda | `POST /assistance/incidents/:id/support-call` `{ slots, rewardPoints }` |
| Conductores | Ven las solicitudes abiertas | `GET /assistance/calls?status=OPEN` |
| Conductores | Aceptan | `POST /assistance/calls/:id/accept` → 201 si tomó cupo · 409 `FULL` si ya se llenó |
| Admin | Cierra el servicio y paga puntos | `POST /assistance/calls/:id/complete` |

Cada elemento de `GET /assistance/calls` trae lo que la pantalla pinta: `incident` (`type`, `description`,
`reportedByName`), `bus` (`plate`, `route`, `locationLabel`, `latitude`, `longitude`), `slots`, `claimedCount`,
`status` y `claims` (`userName`, `arriveBy`, `overdue`). El que reportó no puede aceptar su propia solicitud (403).
Quien acepta tiene **20 minutos** para llegar (`arriveBy`); si no llega, el admin cancela esa aceptación
(`POST /assistance/calls/:id/claims/:claimId/cancel`) y reenvía la solicitud (`POST /assistance/calls/:id/resend`).

### Mecánico (`MechanicHomePage`, `MechanicHistoryPage`) y Mantenimiento (`MaintenancePage`)

| Acción | Endpoint |
|---|---|
| Generar una solicitud de reparación | `POST /assistance/bus-faults` `{ busId, description, incidentId? }` (conductor o admin). Con `incidentId` queda ligada al incidente: al eliminarlo con `DELETE /assistance/incidents/:id` (solo admin) se elimina también, siempre que ningún mecánico la haya aceptado (si no, 409) |
| Ver solicitudes pendientes | `GET /assistance/calls?status=OPEN` → las de `kind: "REPAIR"` |
| Aceptar una solicitud | `POST /assistance/calls/:id/accept` (solo gana el primero; los demás reciben 409) |
| Guardar el informe (borrador) | `PUT /assistance/calls/:id/repair-report` |
| Finalizar el servicio | `PUT /assistance/calls/:id/repair-report` con `"finalize": true` |
| Mis reparaciones (historial) | `GET /assistance/repair-reports` (el admin ve todas) |
| Leer un informe | `GET /assistance/calls/:id/repair-report` |
| Mis puntos | `GET /assistance/me` → `{ …, points }` |

```json
PUT /assistance/calls/<id>/repair-report
{
  "damages": "Pastillas delanteras gastadas",
  "replacedParts": "Pastillas y disco delantero",
  "expenses": [ { "concepto": "Repuestos", "valor": 280000 }, { "concepto": "Mano de obra", "valor": 90000 } ],
  "busPhotos":  ["/uploads/…jpg"],
  "partPhotos": ["/uploads/…jpg"],
  "finalize": true
}
→ 200 { "report": { …, "completedAt": "2026-…" }, "completed": true, "pointsAwardedTo": ["<id>"] }
```

- Sin `finalize` (o `false`) es un **borrador**: se puede guardar las veces que haga falta y la reparación sigue abierta.
- Con `finalize: true` el informe queda definitivo, la solicitud pasa a `COMPLETED` y el mecánico cobra el bono
  (50 puntos), todo en la misma operación. Exige `damages` no vacío.
- Después de finalizar, cualquier cambio responde **409** `REPORT_FINALIZED`.
- Solo escribe el informe el mecánico que aceptó esa solicitud (403 para otros).
- Los renglones vacíos de `expenses` se descartan (el formulario siempre trae uno).

### Bloqueos, rutas alternativas y grúas (`IncidentsPage`)

Los gestiona `assistance`. Un **bloqueo** es un incidente (`DriverIncident`); de él cuelgan sus rutas
alternativas, sus grúas y sus fotos. En todas las rutas con `:id`, ese `:id` es el **id del incidente**
(salvo donde se indica otra cosa).

| Quién | Acción | Endpoint |
|---|---|---|
| Conductor, Admin | Reportar un bloqueo (HU-16) | `POST /assistance/blockages` `{ busId, type, description? }` |
| Todos | Listar bloqueos, cada uno con `alternativeRoutes` y `towAssignments` (HU-45) | `GET /assistance/blockages` |
| Admin | Avisar el bloqueo a **todos los conductores** (HU-44) | `POST /assistance/blockages/:id/alert` → `{ sent: true, incidentId }` |
| Admin | Proponer una ruta alternativa dibujada en el mapa (HU-47) | `POST /assistance/incidents/:id/routes` `{ name, geometry }` (formato abajo) |
| Todos | Ver las rutas alternativas de un incidente (HU-46) | `GET /assistance/incidents/:id/routes` |
| Admin | Asignar la ruta a un conductor (HU-47) | `POST /assistance/routes/:routeId/assign` `{ driverId }` → 409 si ya fue aceptada |
| Conductor | Ver mis rutas asignadas (HU-48) | `GET /assistance/routes/assigned/me` |
| Conductor | Aceptar la ruta asignada (HU-17, HU-52) | `POST /assistance/routes/:routeId/accept` → 409 si no es tuya o ya no está disponible |
| Admin | Asignar grúa y cuadrilla (HU-30) | `POST /assistance/blockages/:id/tow` `{ towTruck, crew }` |
| Admin | Terminar el servicio de grúa y **liberar** grúa y cuadrilla | `POST /assistance/tow-assignments/:assignmentId/complete` |
| Admin | Listado de grúas y cuadrillas (HU-50) | `GET /assistance/tow-reports?towTruck=&crew=&incidentId=&status=&from=&to=&take=&skip=` |
| Todos | Adjuntar evidencia fotográfica (HU-22) | `POST /assistance/incidents/:id/evidence` `{ url, caption?, capturedAt? }` · o subir y asociar en un paso: `POST /assistance/incidents/:id/evidence/upload` (multipart, campo `photo`) |
| Todos | Ver la evidencia de un incidente | `GET /assistance/incidents/:id/evidence` |

`driverId` de `assign` es el **id de usuario** del conductor. En un bus, sale de `bus.driverId` (es `null` si el
bus no tiene conductor: en ese caso el front debe deshabilitar "asignar").

#### Formato de la ruta alternativa

```json
POST /assistance/incidents/<id>/routes
{ "name": "Desvío por la calle 26", "geometry": [[4.6097, -74.0817], [4.6120, -74.0790], [4.6155, -74.0751]] }
```

- Cada punto es **`[latitud, longitud]`**, el mismo orden de Leaflet: `geometry` se pasa tal cual a
  `<Polyline positions={geometry} />`. **No** es GeoJSON (que usa `[longitud, latitud]`).
- De 2 a 2000 puntos. Latitud entre -90 y 90, longitud entre -180 y 180, solo números.
- `name` obligatorio (hasta 120 caracteres).
- Si algo falla, responde **400** y dice qué punto marcar:

```json
{ "statusCode": 400, "error": "INVALID_INPUT", "message": "Punto 2 inválido: la latitud debe estar entre -90 y 90",
  "reason": "INVALID_GEOMETRY", "index": 2 }
```

- Ojo: si el front mandara `[lng, lat]` por error, los valores de Bogotá (`-74.08`, `4.60`) **caben** en rango y el
  back no puede detectarlo: la ruta se dibujaría en otro lugar del mapa. Compruébalo con una ruta de prueba.

#### Grúas y cuadrillas: no se pueden asignar dos veces

Una grúa (o cuadrilla) con un servicio **activo** (`ASSIGNED` o `IN_PROGRESS`) no se puede asignar a otro incidente:

```json
POST /assistance/blockages/<id>/tow   { "towTruck": "G-01", "crew": "Cuadrilla Norte" }
→ 201 { "id", "incidentId", "busId", "towTruck": "G-01", "crew": "CUADRILLA NORTE", "status": "ASSIGNED", … }
→ 409 { "reason": "TOW_TRUCK_BUSY", "assignmentId": "…", "incidentId": "…", "message": "La grúa G-01 ya está asignada a un servicio activo" }
→ 409 { "reason": "CREW_BUSY", … }
```

- Los nombres se guardan en **mayúsculas y sin espacios sobrantes**: `g-01`, ` G-01 ` y `G-01` son la misma grúa.
- `towTruck` y `crew`: obligatorios, hasta 60 caracteres.
- Si dos administradores asignan la misma grúa a la vez, solo uno lo logra; el otro recibe el 409.
- La grúa vuelve a estar libre con `POST /assistance/tow-assignments/:assignmentId/complete` (409 `ALREADY_COMPLETED`
  si ya estaba terminada), o al eliminar el incidente.
- `reason` y `assignmentId` permiten mostrar "la grúa G-01 está en otro servicio" y llevar a ese incidente.

---

## 3. Cómo se traducen los tipos del front

| Front | Back |
|---|---|
| `Role`: `admin` / `conductor` / `mecanico` | `ADMIN` / `DRIVER` / `MECHANICAL` |
| `Bus.id` | `id` (UUID) |
| `Bus.placa` · `troncal` · `ubicacion` | `plate` · `route` · `locationLabel` |
| `Bus.modelo` · `anio` · `operador` · `capacidad` | `model` · `year` · `operator` · `capacity` |
| `Bus.ultimaActualizacion` | `updatedAt` |
| `Bus.estado` | ver abajo |
| `ActiveTrip` | un bus con `status: "IN_SERVICE"` → `busId`=`id`, `placa`=`plate`, `troncal`=`route`, `driverName`=`driver`, `startedAt`=`tripStartedAt` |
| `HelpRequest` | una alerta con `kind: "DRIVER_SUPPORT"`: `motivo`=`incident.type`, `detalle`=`incident.description`, `driverName`=`incident.reportedByName`, `placa`=`bus.plate`, `createdAt`=`createdAt`, `status`: `OPEN`→`pendiente`, `FILLED`/`COMPLETED`→`aceptada`, `aceptadoPor`=`claims[].userName` |
| `RepairRequest` | una alerta con `kind: "REPAIR"`: `problema`=`description`, `placa`/`troncal`/`ubicacion`=`bus.plate`/`bus.route`/`bus.locationLabel`, `estado`: `OPEN`→`pendiente`, `FILLED`→`aceptada`, `COMPLETED`→`completada`, `mecanicoNombre`=`claims[0].userName`, `aceptadaEn`=`claims[0].createdAt` |
| `RepairReport` | `danosEncontrados`=`damages`, `piezasReemplazadas`=`replacedParts`, `gastos`=`expenses` (`concepto`, `valor`), `fotosBus`=`busPhotos`, `fotosPiezas`=`partPhotos`, `actualizadoEn`=`updatedAt`, `completadaEn`=`completedAt` |
| `BusReport` (inspección) | `nombre`=`inspectorName`, `rol`=`inspectorRole`, `fecha`=`createdAt`, `nota`=`note`, `comentario`=`comment`, `fotos`=`photos` |

**Estado del bus (`Bus.estado`).** El back guarda `IDLE`, `IN_SERVICE` y `FINISHED`. Para las etiquetas del front:
`operacion` = `IN_SERVICE`; `mantenimiento` = el bus tiene una alerta `REPAIR` abierta o en curso
(`status` `OPEN`/`FILLED` en `GET /assistance/calls` con ese `busId`); `fuera-servicio` = el resto (`IDLE`/`FINISHED`).

---

## 4. Fotos

Los formularios con fotos (`PhotoUploadField`) dejan de guardar imágenes en base64: **se sube cada foto y se
guardan las URLs**.

```ts
async function subirFoto(file: File): Promise<string> {
  const form = new FormData();
  form.append("photo", file);                       // el campo se llama "photo"
  const res = await fetch(`${API}/files/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },  // NO pongas Content-Type: el navegador lo arma con el boundary
    body: form,
  });
  return (await res.json()).url;                    // "/uploads/3f2c…jpg"
}
// para mostrarla:  <img src={`${API}${url}`} />
```

- Formatos: JPEG, PNG o WebP, hasta 5 MB. El back valida el **contenido** del archivo, no su nombre.
- Después se envían las URLs en `photos` (inspección) o `busPhotos`/`partPhotos` (informe). El back **solo acepta
  URLs que él mismo generó**; un enlace externo responde 400.
- Puedes seguir reduciendo la foto en el navegador antes de subirla (`resizeImageFile` de `lib/image.ts`) para
  que pese menos; hay que convertir el resultado a `File`/`Blob` en vez de `dataURL`.
- Evidencia de un incidente: `POST /assistance/incidents/:id/evidence/upload` (multipart, campo `photo`) la
  sube y la asocia en un solo paso.

---

## 5. Tiempo real (WebSocket)

Instala `socket.io-client` y conéctate con el token:

```ts
import { io } from "socket.io-client";

const socket = io(`${API}/realtime`, {
  auth: { token, lastSeq: localStorage.getItem("lastSeq") ?? undefined },
});

socket.on("identified", ({ role, name }) => { /* conectado */ });
socket.on("unauthorized", () => { /* token vencido: volver a /login */ });

// Posiciones de la flota (solo ADMIN y MECHANICAL): alimenta el mapa
socket.on("fleet:position-updated", (e) => {
  // { busId, plate, route, status, latitude, longitude, updatedAt }
});

// Alertas (cada rol recibe solo las suyas)
const vistos = new Set<string>();
socket.on("assistance:event", (e) => {
  if (vistos.has(e.eventId)) return;          // la entrega es "al menos una vez": descartar duplicados
  vistos.add(e.eventId);
  localStorage.setItem("lastSeq", e.seq);     // al reconectar, el servidor reenvía lo que te perdiste
  // e = { eventId, seq, type, occurredAt, payload }
});
```

| `type` | Lo recibe | Qué hacer en la pantalla |
|---|---|---|
| `incident.reported` | ADMIN | Nuevo reporte de un conductor |
| `call.opened` | DRIVER (apoyo) o MECHANICAL (reparación) | Nueva solicitud (o reenviada: `payload.resent`) |
| `call.progress` | ADMIN | Alguien aceptó o canceló (`claimedCount/slots`, quién, su bus, `arriveBy`) |
| `call.closed` | el rol de la alerta + ADMIN | Se llenaron los cupos: **deshabilitar** la notificación |
| `claim.cancelled` | ADMIN + el cancelado | El admin canceló una aceptación vencida |
| `call.completed` | ADMIN + quienes cobran | Servicio cerrado y puntos acreditados |
| `incident.deleted` | ADMIN, DRIVER, MECHANICAL | `{ incidentId, busId }`. El admin eliminó un incidente: refrescar las listas |
| `blockage.reported` | ADMIN | `{ incidentId, busId }`. Un conductor reportó un bloqueo |
| `blockage.alerted` | DRIVER | `{ incidentId, busId, type, description }`. El admin avisó del bloqueo a la flota: **mostrar la alerta** (HU-16, HU-44) |
| `incident.evidence.attached` | ADMIN, DRIVER, MECHANICAL | `{ incidentId, evidenceId, busId, url }`. Se adjuntó una foto al incidente |
| `route.proposed` | ADMIN, DRIVER | `{ routeId, incidentId, name, geometry }`. Hay una ruta alternativa: **dibujarla en el mapa** (HU-46). `geometry` es `[[lat, lng], …]` |
| `route.assigned` | el conductor asignado + ADMIN | `{ routeId, incidentId, driverId }`. Al conductor: "te asignaron una ruta" (HU-48) |
| `route.accepted` | ADMIN + el conductor | `{ routeId, incidentId, driverId }`. El conductor aceptó la ruta |
| `tow.assigned` | ADMIN, DRIVER, MECHANICAL | `{ assignmentId, incidentId, busId }`. Se asignó grúa y cuadrilla |
| `tow.completed` | ADMIN, DRIVER, MECHANICAL | `{ assignmentId, incidentId, busId, towTruck, crew }`. Terminó el servicio: grúa y cuadrilla quedaron libres |

Los eventos de bloqueos, rutas y grúas llevan solo ids (salvo `route.proposed`, que trae el trazado): para el
detalle, vuelve a llamar al `GET` correspondiente.

Los datos de las pantallas siempre se pueden recuperar con los `GET` (al abrir la pantalla y al reconectar);
los eventos sirven para que se actualicen solas sin recargar. Un hook que reemplace a `fleetActivityClient` /
`repairClient` puede: cargar con `GET`, y refrescar cuando llegue un evento.

---

## 6. Ubicación del conductor

El conductor "activa su ubicación" con la API del navegador y envía cada posición:

```ts
const watchId = navigator.geolocation.watchPosition(
  (pos) => {
    fetch(`${API}/fleet/buses/${busId}/position`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
    });
  },
  (err) => console.warn("Ubicación no disponible", err),
  { enableHighAccuracy: true, maximumAge: 2000 },
);
// al finalizar el viaje:  navigator.geolocation.clearWatch(watchId)
```

Requiere HTTPS (o `localhost`) y que el usuario conceda el permiso. Antes hay que iniciar el viaje
(`start-trip`); enviar posiciones con el bus fuera de servicio responde 409. Los administradores y mecánicos
conectados por WebSocket ven la posición en el mapa al instante.

---

## 7. Lo que el back todavía no tiene

- **Turno y hora de salida** (`AssignedRoute.turno`, `horaSalida`): no hay agenda de turnos. El front puede
  mantener esos textos fijos.
- **Métricas de `ReportsPage`** (ocupación, velocidad media, kilómetros): no existen todavía (Épica 5: KPIs).
  `GET /fleet/summary` y `GET /assistance/summary` cubren los contadores del panel.
- **Evidencia con marca de agua** (fecha, lugar, responsable) y clasificación de daños con IA: pendientes.
- **Recuperar contraseña por correo**: no existe; el admin puede restablecerla (`reset-password`).
