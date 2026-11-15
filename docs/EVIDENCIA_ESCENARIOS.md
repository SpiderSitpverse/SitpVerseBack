# SitpVerse · Evidencia de los escenarios de calidad (Sprint 2)

Team Spiderverse · ARSW 2026-2

Este documento dice, para cada uno de los 7 escenarios de calidad, **qué pide**, **cómo lo resuelve la arquitectura**,
**cómo se verifica** y **qué resultado dio**, con el archivo de evidencia (salida de la prueba, captura o video) que lo
respalda. Al final hay un guion para la presentación: qué se muestra en video y qué se muestra en vivo.

Todo lo que aparece aquí se puede repetir: cada resultado sale de un comando del repositorio.

## Resumen

| Escenario | Qué pide (medida) | Resultado | Evidencia |
|---|---|---|---|
| **ESC-DISP-01** Disponibilidad | Cae 1 de 3 instancias en hora pico: sockets reconectados ≤ 20 s, ≥ 99 % de posiciones en ≤ 6 s, errores ≤ 1 %, 0 alertas perdidas, 0 sobreasignaciones; 3 instancias ≥ 1,5× el caudal de 1 | Sockets reconectados en **≤ 1,8 s**, **100 %** de posiciones en ≤ 6 s, **0 %** de errores, 60/60 alertas, 3 cupos exactos; **2,33×** el caudal | `videos/ESC-DISP-01-caida-de-instancia.mp4`, `local-3-instancias-disponibilidad.txt`, `local-3-instancias-escalabilidad.txt` |
| **ESC-SEG-01** Autenticación | Identidad verificada por Google; 100 % de tokens inválidos → 401; cuentas no registradas → 403 idéntico; > 10 intentos/min por IP → 429; 0 contraseñas | **87 comprobaciones en verde**; login p95 ≤ 300 ms | `videos/ESC-SEG-01-autenticacion.mp4`, `local-ESC-SEG-01-autenticacion.txt` |
| **ESC-SEG-02** Autorización | 100 % de la matriz rol × endpoint; 0 rutas sin política; 0 posiciones a conductores; cuenta desactivada rechazada en la siguiente petición | **41 comprobaciones en verde**; 0 eventos de posición a conductores bajo carga | `videos/ESC-SEG-02-autorizacion.mp4`, `local-ESC-SEG-02-autorizacion.txt` |
| **ESC-SEG-03** Trazabilidad | 100 % de las acciones críticas con registro (en la misma transacción); consulta ≤ 2 s; auditoría e inspecciones inmutables; hoja de vida del bus en una consulta; **todas** las peticiones con hora, IP, usuario, navegador y país | **43 comprobaciones en verde**; hoja de vida en ~25 ms | `videos/ESC-SEG-03-trazabilidad.mp4`, `local-ESC-SEG-03-trazabilidad.txt`, `azure-trace-id.txt` |
| **ESC-MANT-01** Mantenibilidad | Pipeline con Sonar en cada PR; Quality Gate; cobertura nueva ≥ 80 % (back) y ≥ 40 % (front); reglas de arquitectura | Quality Gate **aprobado** en los dos repositorios; 356 pruebas (back) y 192 (front); pipeline ~3,5 min | PR #10, #11, #12 (back) y #6, #7 (front) en GitHub; SonarCloud |
| **ESC-REND-01** Rendimiento | 60 conductores + 140 oyentes: posición punta a punta p95 ≤ 500 ms y p99 ≤ 1 s; HTTP p95 ≤ 200 ms; alerta a 60 conductores p95 ≤ 1 s; 12 sobre 3 cupos = 3 éxitos y 9×409 (p95 ≤ 800 ms); 5 mecánicos sobre 1 = 1; detalle del bus p95 ≤ 300 ms | Punta a punta **p95 36 ms / p99 45 ms**; HTTP **p95 30 ms**; alerta **p95 41 ms**; **3 éxitos y 9×409** (p95 205 ms); **1 éxito**; detalle **p95 22 ms**; 180 040 de 180 040 eventos; 0 errores | `videos/ESC-REND-01-hora-pico.mp4`, `local-3-instancias-rendimiento.txt` |
| **ESC-OBS-01** Observabilidad | `traceId` en cada petición y en sus logs; `/metrics` por instancia; 2 tableros (negocio y técnico) en una URL aparte y con acceso restringido; instancia caída visible ≤ 30 s; buses «Sin señal» | Traza seguida de la respuesta al log de Azure; caída visible en **8,4 s**; tableros en Grafana con usuario y clave | `capturas/*.png`, `azure-trace-id.txt`, `videos/ESC-DISP-01-caida-de-instancia.mp4` |

Los números de carga se midieron en el **entorno de 3 instancias** del repositorio (`docker-compose.cluster.yml`: 3
instancias del backend de medio núcleo cada una, un balanceador, PostgreSQL y Redis compartidos, Prometheus y Grafana),
que tiene la misma forma que producción. En **Azure** el sistema corre con esa misma forma (App Service con 3
instancias y su balanceador, PostgreSQL y Redis administrados, front en Static Web Apps, Grafana en un contenedor
aparte); ahí se muestran en vivo la salud, las métricas, las trazas y la prueba de carga (ver «Azure» más abajo).

---

## ESC-DISP-01 · El backend sobrevive a la caída de una instancia

**Qué pide.** En hora pico (60 buses mandando GPS, 140 usuarios viendo el mapa, una alerta de 3 cupos abierta) una de
las 3 instancias se detiene de golpe. El sistema debe seguir funcionando sin que el usuario lo note.

**Cómo lo resuelve la arquitectura.**

- **Redundancia activa**: 3 réplicas del backend detrás del balanceador de App Service (restricción tecnológica del
  enunciado). El backend **no guarda estado**: las sesiones son JWT, los cupos se deciden con un lock en Redis y un
  `UPDATE` condicional en PostgreSQL, y los eventos viajan por Redis. Cualquier instancia atiende cualquier petición.
- **Detección de fallas**: health check (`GET /health`, comprueba PostgreSQL y Redis); Azure retira la instancia tras 2
  fallos (`WEBSITE_HEALTHCHECK_MAXPINGFAILURES=2`).
- **Reintento en el cliente**: el front reintenta GET/PUT/PATCH/DELETE ante un corte o un 502/503/504 (nunca un POST,
  que podría ejecutarse dos veces). La petición cae en una instancia viva.
- **Reconexión y recuperación de eventos**: el socket usa solo WebSocket y **sin afinidad de sesión**, así que se
  reconecta a cualquier instancia; manda el último `seq` que vio y el servidor le reenvía lo perdido desde el outbox.
- **Outbox transaccional**: un evento que la instancia caída no alcanzó a publicar lo publica el relay de otra.

**Cómo se verifica.** `npm run loadtest:availability` levanta la carga, ejecuta `docker kill` sobre una instancia y mide.
`npm run loadtest:scalability` compara la capacidad con 3 instancias y con 1.

**Resultado** (`docs/evidencia/local-3-instancias-disponibilidad.txt` y `…-escalabilidad.txt`):

| Medida | Objetivo | Obtenido |
|---|---|---|
| Instancia fuera del balanceador | ≤ 2 min | inmediato (el balanceador reintenta en otra) |
| La caída se ve en las métricas | ≤ 30 s | 8,4 s |
| Sockets reconectados | 100 % en ≤ 20 s | 64 de 64 en ≤ 1,8 s |
| Posiciones GPS registradas en ≤ 6 s | ≥ 99 % | 100 % (máx. 1,1 s) |
| Buses que pasan a «Sin señal» | 0 | 0 (mayor hueco 4,7 s) |
| Errores visibles durante la falla / después | ≤ 1 % / 0 % | 0 % / 0 % |
| Alertas perdidas | 0 | 0 (60 de 60 conductores) |
| Sobreasignaciones (12 aceptan 3 cupos durante la falla) | 0 | 0 (exactamente 3) |
| Buses que cambian de estado por la falla | 0 | 0 |
| Capacidad con 3 instancias vs. 1 (p95 ≤ 500 ms) | ≥ 1,5× | 2,33× (353 vs. 152 pet/s) |

**Por qué se cumple.** Porque nada importante vive dentro de una instancia. Lo único que se pierde al caer una son sus
conexiones WebSocket, y esas se recuperan solas con `lastSeq`.

---

## ESC-SEG-01 · Autenticación: identificar a quien intenta acceder

**Qué pide.** Solo entra quien fue registrado por un administrador, y la identidad la confirma un proveedor externo.
(Comentario del profesor: *«con un proveedor de identidad externo, nada de logins caseros»*.)

**Cómo lo resuelve la arquitectura.**

- **Google como proveedor de identidad (OpenID Connect)**. SitpVerse **no guarda contraseñas**. El front obtiene un ID
  token de Google y lo manda a `POST /auth/google`; el backend valida firma (llaves públicas de Google), emisor,
  audiencia, vencimiento, correo verificado y un `nonce` de un solo uso (contra reutilización de respuestas).
- Si la cuenta existe y está activa, emite un **JWT de sesión de 8 horas**. El rol y el número de empleado **no vienen
  de Google**: los pone el administrador.
- Cuenta no registrada o desactivada → **403 con el mismo mensaje** (no revela quién trabaja en la empresa). La cuenta
  no registrada deja además una **solicitud de acceso** que el administrador aprueba o rechaza.
- **Límite por IP en Redis**: más de 10 intentos por minuto → 429 con `Retry-After`.
- Guard **global**: toda ruta HTTP y toda conexión WebSocket exige el JWT de sesión.

**Cómo se verifica.** `npm run loadtest:security` firma ID tokens con una llave de prueba (un «Google» falso), así los
casos inválidos se prueban sin depender de Google: token alterado, vencido, de otra aplicación, de otro emisor, correo
sin verificar, `nonce` repetido, cuenta no registrada, desactivada, sin JWT, JWT vencido, 11 intentos seguidos…

**Resultado** (`docs/evidencia/local-ESC-SEG-01-autenticacion.txt`): 87 de 87 comprobaciones.

---

## ESC-SEG-02 · Autorización: cada rol hace solo lo que le corresponde

**Qué pide.** Una persona ya identificada no puede hacer lo que su rol no permite. (Comentario del profesor: *«cambio de
rol en todas las pantallas de la app»*.)

**Cómo lo resuelve la arquitectura.**

- Guard global + `@Roles(...)` en **cada** ruta. Una ruta sin `@Roles` ni `@Public` se rechaza: el sistema **falla
  cerrado**. Una prueba de arquitectura rompe el build si aparece una ruta sin política.
- El rol se lee de **PostgreSQL en cada petición**, no del token: un cambio de rol o una desactivación aplican en la
  siguiente petición, sin esperar a que venza el JWT. El front lo detecta y **cambia las pantallas sin recargar**.
- Autorización por **recurso**: un conductor solo ve y opera **su** bus (`BusAccessService`).
- WebSocket por **salas**: las posiciones solo llegan a ADMIN y MECHANICAL; cada alerta, solo a su audiencia.

**Cómo se verifica.** `npm run loadtest:access` recorre la matriz rol × endpoint con los 15 usuarios de prueba (5 por
rol). La prueba de rendimiento comprueba además, bajo carga, que ningún conductor recibe posiciones.

**Resultado** (`docs/evidencia/local-ESC-SEG-02-autorizacion.txt`): 41 de 41; 0 de 180 040 eventos de posición llegaron
a conductores.

---

## ESC-SEG-03 · Trazabilidad: hoja de vida auditable de cada bus

**Qué pide.** Saber quién hizo qué, cuándo, desde dónde y con qué resultado; y que nadie pueda borrar ese rastro.
(Comentario del profesor: *«garantizarlo en todas las peticiones y guardar mínimo hora, IP, usuario, navegador web y
país»*.)

**Cómo lo resuelve la arquitectura.** Hay dos registros, los dos de **solo inserción** (un trigger de PostgreSQL rechaza
`UPDATE` y `DELETE`, también para el usuario de base de datos de la aplicación):

1. **`request_log`: TODAS las peticiones HTTP** (también las rechazadas y las de quien no inició sesión): hora, IP,
   país (por geolocalización de la IP), navegador, usuario, rol, ruta, código, duración y `trace_id`. Lo escribe un
   middleware que va antes de todo, por lotes. Consulta: `GET /audit/requests` (solo ADMIN).
2. **`audit_log`: las acciones críticas** (inicio de sesión aceptado o rechazado, alta/edición/desactivación de usuario,
   cambio de rol, inspección, evidencia fotográfica, incidente, grúa, alerta aceptada, reparación, ruta asignada o
   aceptada, viaje iniciado o finalizado…). Cada ruta crítica lleva `@Audited(...)`. El registro se inserta **en la
   misma transacción** que el cambio: no puede existir el cambio sin su registro. Los intentos rechazados (403) y
   fallidos (409) también quedan, como `DENIED` y `FAILURE`. Consulta: `GET /audit` (solo ADMIN).

Además, las **inspecciones son inmutables** (trigger) y la **hoja de vida de un bus** (`GET /fleet/buses/:id/history`:
conductores asignados, viajes, inspecciones con fotos, incidentes, reparaciones y grúas) se arma con **una sola
consulta**.

**Cómo se verifica.** `npm run loadtest:audit` ejecuta cada acción crítica y comprueba su registro (actor, recurso,
resultado, IP, `trace_id`); provoca rechazos y fallos; lanza 4 aceptaciones por 1 cupo y comprueba que hay exactamente
1 cambio y 1 registro de éxito; intenta modificar y borrar una inspección por la API y por SQL directo.
`npm run loadtest:security` comprueba el registro de todas las peticiones (hora, IP, navegador, país, usuario).

**Resultado** (`docs/evidencia/local-ESC-SEG-03-trazabilidad.txt`): 43 de 43. En Azure, `docs/evidencia/azure-trace-id.txt`
muestra una petición real con su hora, IP, país (`CO`), navegador y `trace_id`.

---

## ESC-MANT-01 · Inspección continua del código y reglas de arquitectura

**Qué pide.** Cada PR pasa por compilación, lint, pruebas con cobertura, pruebas de integración y análisis estático;
si algo falla, no se mezcla ni se despliega.

**Cómo lo resuelve la arquitectura.**

- **GitHub Actions** en los dos repositorios: compila, corre las pruebas unitarias y de arquitectura con cobertura, las
  **pruebas de integración contra PostgreSQL y Redis reales** (12 scripts) y el análisis de **SonarCloud**, que publica
  el resultado en el PR. El despliegue a Azure solo corre desde `main`.
- **Quality Gate**: 0 bugs y 0 vulnerabilidades nuevos, mantenibilidad A, duplicación ≤ 3 %, cobertura del código nuevo
  ≥ 80 % en el back y ≥ 40 % en el front.
- **Reglas de arquitectura como pruebas** (`architecture.spec.ts`): las capas `domain/` y `application/` no importan
  Prisma, Redis, Socket.io ni librerías de Google; un módulo solo se importa por su `public.ts`; toda ruta declara su
  política de acceso. Cambiar de proveedor de identidad o conectar la API real de TransMilenio toca **un adapter**.

**Resultado.** Quality Gate aprobado en todos los PR del sprint; 356 pruebas unitarias en el back y 192 en el front;
pipeline completo en unos 3,5 minutos (objetivo: ≤ 10).

---

## ESC-REND-01 · Latencia de los eventos en tiempo real bajo concurrencia

**Qué pide.** Con 200 clientes (60 conductores cada 3 s = 20 peticiones por segundo, y 140 oyentes), que la posición
llegue al mapa en menos de 500 ms, que las alertas no se pierdan y que las aceptaciones simultáneas no sobreasignen.

**Cómo lo resuelve la arquitectura.**

- **Camino ligero para lo efímero**: la posición se guarda con **una sola sentencia** (actualiza el bus e inserta el
  historial), sin esperar al disco (`synchronous_commit = off`: si se pierde una, la siguiente la reemplaza a los 3 s) y
  se publica por **Redis Pub/Sub**; cada instancia la entrega por WebSocket a sus oyentes.
- **Camino seguro para lo que no se puede perder**: las alertas van por **outbox transaccional → Redis Streams**; el
  cliente descarta duplicados por `eventId` y recupera lo perdido con `seq`.
- **Sincronización**: lock **FIFO** en Redis (el orden lo fija `INCR`, único para todas las instancias) más `UPDATE`
  condicional y restricción única en PostgreSQL: la base decide; el lock solo ordena.
- **Índice** `(busId, recordedAt)` en `bus_positions`: el detalle del bus no se degrada aunque el historial crezca
  72 000 filas por hora.

**Cómo se verifica.** `npm run loadtest:performance`: conductores y oyentes corren en la misma máquina (un solo reloj),
con `bus_positions` precargada con una hora de historial.

**Resultado** (`docs/evidencia/local-3-instancias-rendimiento.txt`):

| Medida | Objetivo | Obtenido |
|---|---|---|
| Posición de punta a punta (envío → mapa) | p95 ≤ 500 ms, p99 ≤ 1 s | p95 36 ms, p99 45 ms |
| Respuesta HTTP de la posición | p95 ≤ 200 ms | p95 30 ms |
| Alerta de bloqueo a los 60 conductores | p95 ≤ 1 s, 0 perdidas | p95 41 ms, 60 de 60 |
| 12 aceptaciones sobre 3 cupos | 3 éxitos y 9×409, p95 ≤ 800 ms | 3 y 9, p95 205 ms |
| 5 mecánicos sobre 1 reparación | 1 éxito | 1 (4×409) |
| Detalle de un bus con 72 000 filas de historial | p95 ≤ 300 ms | p95 22 ms |
| Eventos de posición entregados | sin pérdidas | 180 040 de 180 040 |
| Errores | < 1 % | 0 % |

---

## ESC-OBS-01 · El sistema permite ver su estado y rastrear una falla

**Qué pide.** Poder ver qué está pasando (métricas y tableros) y llegar de una falla a la petición que la causó.

**Cómo lo resuelve la arquitectura.**

- **Trazas**: cada petición recibe un `trace_id` (o usa el que mande el cliente en `X-Trace-Id`), que vuelve en el header
  `X-Trace-Id` y aparece en **su log JSON**, en `request_log`, en la auditoría y en los eventos que genera.
- **Métricas** (`GET /metrics`, formato Prometheus): latencia y total por ruta y código, conexiones WebSocket, latencia
  de entrega de eventos, outbox, espera y retención del lock FIFO, CPU, memoria y retraso del event loop.
  Detrás del balanceador Prometheus no puede elegir instancia, así que cada instancia publica sus métricas en Redis cada
  4 s y `/metrics` responde las de **todas las instancias vivas**, cada serie con su etiqueta `instance`. Una instancia
  que deja de publicar desaparece en 12 s: el tablero la ve caer **antes** de que Azure la retire.
- **Métricas de negocio** calculadas con una consulta: los 4 KPIs del Inception (MTTR, efectividad de desvíos,
  disponibilidad de flota, asignaciones sin conflicto), usuarios activos, inicios de sesión, viajes, incidentes, alertas…
- **Prometheus + Grafana en un host aparte** (Azure Container Instances), recogiendo cada 10 s. Dos tableros:
  **técnico** y **de negocio**. Grafana exige usuario y clave, y `/metrics` exige un token: solo roles autorizados.
- **«Sin señal»**: un bus en servicio sin posición por más de 15 s se pinta en gris en el mapa y se cuenta en el tablero.

**Resultado.**

- `docs/evidencia/capturas/local-grafana-tecnico.png` y `…-negocio.png`: los dos tableros con datos.
- `docs/evidencia/capturas/grafana-exige-inicio-de-sesion.png`: sin sesión no se ven.
- `docs/evidencia/azure-trace-id.txt`: una petición con `x-trace-id: demo-profesor-001`, el mismo valor en la respuesta,
  en el registro de peticiones y en el log de Azure.
- `videos/ESC-DISP-01-caida-de-instancia.mp4`: el tablero técnico muestra la caída de la instancia (3 → 2) a los 8,4 s.

---

## Azure (producción)

| Componente | Recurso |
|---|---|
| Backend (3 instancias + balanceador) | App Service `sitpverse2026-api` (plan B1, 3 instancias, sin afinidad de sesión, health check `/health`) |
| Base de datos | Azure Database for PostgreSQL Flexible Server `sitpverse2026-db` |
| Redis (lock, Streams, Pub/Sub) | Azure Managed Redis `sitpverse2026-redis` |
| Front | Azure Static Web Apps |
| Prometheus + Grafana | Azure Container Instances `sitpverse2026-obs` → `http://sitpverse2026-obs.westus3.azurecontainer.io:3000` |

`docs/evidencia/azure-loadtest-quality.txt` tiene la salida de `npm run loadtest:quality` contra Azure: salud, métricas
y 100 posiciones simultáneas repartidas entre las 3 instancias (se ve el reparto por instancia en las métricas).

La prueba completa de hora pico (60 conductores, 12 aceptaciones…) necesita 75 sesiones de usuarios distintos. En
producción el único inicio de sesión es el de Google, que no se puede automatizar; por eso esa prueba corre en el
entorno de 3 instancias del repositorio (con un «Google» de prueba) y en el CI, y en Azure se muestra en vivo con la
sesión de un administrador.

---

## Guion para la presentación

**En video** (ya grabados, en `docs/evidencia/videos/`; la terminal corre en vivo a la izquierda y el tablero técnico se
actualiza a la derecha):

| Video | Qué muestra | Qué decir |
|---|---|---|
| `ESC-DISP-01-caida-de-instancia.mp4` (1:40) | `docker kill` de una instancia en plena carga; el tablero baja de 3 a 2 instancias y vuelve a 3 | «Se cae una de tres y nadie lo nota: 0 errores, los sockets vuelven en menos de 2 s y no se pierde ninguna alerta» |
| `ESC-REND-01-hora-pico.mp4` (1:25) | 60 conductores y 140 oyentes; alerta de bloqueo; 12 sobre 3 cupos; 5 sobre 1 | «La posición llega al mapa en 36 ms (p95) y de 12 aceptaciones simultáneas ganan exactamente 3» |
| `ESC-SEG-01-autenticacion.mp4` | Tokens de Google inválidos → 401; cuentas no registradas → 403; límite por IP → 429 | «La identidad la verifica Google; nosotros no guardamos contraseñas» |
| `ESC-SEG-02-autorizacion.mp4` | Matriz rol × endpoint | «Una ruta sin política se rechaza: falla cerrado» |
| `ESC-SEG-03-trazabilidad.mp4` | Cada acción crítica con su registro; inspecciones inmutables; hoja de vida | «El cambio y su registro van en la misma transacción» |
| `AZURE-prueba-de-carga-100-concurrentes.mp4` | Salud, métricas y 100 posiciones simultáneas contra Azure | «Las 100 peticiones se reparten entre las 3 instancias» |

**En vivo** (5 minutos):

1. **Salud**: abrir `https://sitpverse2026-api.azurewebsites.net/health/ready` → PostgreSQL y Redis arriba.
2. **Traza**: en una terminal,
   `curl -i -H "x-trace-id: demo-profesor-001" https://sitpverse2026-api.azurewebsites.net/auth/nonce`
   → la respuesta trae `X-Trace-Id: demo-profesor-001`. En el portal de Azure → App Service → **Log stream** aparece la
   línea JSON con ese `trace_id`, la IP, el país y el navegador. En la app (como admin) → Auditoría → Peticiones, la misma.
3. **Tableros**: abrir Grafana (`http://sitpverse2026-obs.westus3.azurecontainer.io:3000`), iniciar sesión, mostrar el
   tablero **técnico** («Instancias vivas: 3», latencia por endpoint, CPU y memoria por instancia) y el **de negocio**
   (los 4 KPIs del Inception).
4. **Carga**: `npm run loadtest:quality -- https://sitpverse2026-api.azurewebsites.net` y ver subir las gráficas.
5. **Seguridad en la app**: iniciar sesión con Google; desde otra sesión de administrador cambiarle el rol a esa persona
   y ver que su pantalla cambia sin recargar; abrir Auditoría y mostrar el registro del cambio (quién, cuándo, desde qué IP).
6. **«Sin señal»**: en el mapa, un bus en servicio que dejó de enviar posición aparece en gris con el aviso.

## Cómo repetir cada prueba

```bash
# Entorno de 3 instancias + balanceador + Prometheus + Grafana (http://localhost:3001, admin / sitpverse-local)
npm run cluster:up
npm run loadtest:performance      # ESC-REND-01
npm run loadtest:availability     # ESC-DISP-01 (detiene una instancia)
npm run loadtest:scalability      # ESC-DISP-01 (3 instancias vs. 1)
npm run cluster:down

# Servidor local simple (como en el CI)
npm run loadtest:security         # ESC-SEG-01 y ESC-SEG-03
npm run loadtest:access           # ESC-SEG-02
npm run loadtest:audit            # ESC-SEG-03

# Contra Azure (con .quality-token y .metrics-token en la raíz, ignorados por git)
npm run loadtest:quality -- https://sitpverse2026-api.azurewebsites.net

# Capturas y videos
node scripts/evidence/screenshot.js <url> <salida.png> [--grafana usuario:clave]
node scripts/evidence/record.js --out video.mp4 --cmd "<comando>" [--url <tablero>] [--grafana usuario:clave]
```
