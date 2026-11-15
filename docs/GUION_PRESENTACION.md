# SitpVerse · Guion de la presentación (Sprint 2)

Qué se muestra **en vivo**, qué va en **video** y qué decir. Todo lo de esta página se probó contra Azure.

| Bloque | Cómo | Duración |
|---|---|---|
| 1. Calidad de código (Sonar y CI) | En vivo | 2 min |
| 2. Seguridad, caso por caso | En vivo | 5 min |
| 3. Logs en Azure + balanceo entre las 3 instancias | En vivo | 4 min |
| 4. Prueba de carga y caída de una instancia | **Video** | 3 min |
| 5. Arquitectura | Documento / diagramas | 2 min |

## Antes de empezar (checklist)

- [ ] **Azure arriba**: `https://sitpverse2026-api.azurewebsites.net/health/ready` responde `200` con PostgreSQL y Redis `up`.
  Si responde 503: `az webapp restart -g sitpverse2026-rg -n sitpverse2026-api` y esperar 1–2 min.
- [ ] **Sesión de administrador** abierta en el front de Azure (`https://jolly-flower-0da9f9b0f.4.azurestaticapps.net`).
- [ ] **Token de administrador** (dura 8 h): en la consola del navegador, con la sesión abierta,
  `sessionStorage.getItem("sitpverse.token")`. Guárdalo en una variable de la terminal: `T="eyJ..."` (no lo pegues en el chat ni en el repositorio).
- [ ] **Segunda cuenta de Google** (no registrada) para mostrar la solicitud de acceso, y una **segunda ventana** con otro administrador.
- [ ] **Grafana**: `http://sitpverse2026-obs.westus3.azurecontainer.io:3000` (usuario `admin`; la clave quedó en `grafana-password.txt` de la carpeta temporal de la sesión de Claude: cámbiala o guárdala).
- [ ] Terminal con `U=https://sitpverse2026-api.azurewebsites.net`.
- [ ] **No correr** la prueba de 140 oyentes contra Azure: agota las conexiones de PostgreSQL y deja la API en 503. Esa prueba va en video.

---

## 1. Calidad de código (ESC-MANT-01) · en vivo

1. Abrir **SonarCloud** → organización `spidersitpverse` → proyectos **SitpVerseBack** y **SitpVerseFront**: Quality Gate **Passed**,
   cobertura (back ≥ 80 %, front ≥ 40 % en código nuevo), 0 bugs, 0 vulnerabilidades.
2. Abrir **GitHub → Pull requests** → un PR reciente (p. ej. #14): mostrar los checks `test`, `integration` y `SonarCloud Code Analysis`
   y el comentario del bot con el Quality Gate.
3. **GitHub → Actions → Deploy a Azure**: el despliegue solo corre desde `main`.

*Qué decir:* «Ningún cambio llega a producción sin pasar compilación, pruebas, pruebas de integración contra PostgreSQL y Redis reales y el Quality Gate. Las reglas de arquitectura son pruebas: si un caso de uso importa Prisma, el build falla.»

## 2. Seguridad, caso por caso · en vivo

### ESC-SEG-01 · Autenticación

| # | Caso | Comando o acción | Resultado esperado |
|---|---|---|---|
| 1 | Entrar con Google (nada de contraseñas) | En el front: «Iniciar sesión con Google» con la cuenta de admin | Llega al Home de su rol |
| 2 | Sin token | `curl -i $U/fleet/buses` | `401` |
| 3 | Token alterado | `curl -i -H "Authorization: Bearer ${T%?}X" $U/fleet/buses` | `401` |
| 4 | ID token de Google falso | `curl -i -X POST -H 'Content-Type: application/json' -d '{"idToken":"eyJhbGciOiJSUzI1NiJ9.e30.x","nonce":"abcdefghijklmnopqrstuvwxyz012345"}' $U/auth/google` | `401` «Token de Google inválido» |
| 5 | WebSocket sin token | (script) `node -e "const {io}=require('socket.io-client');const s=io('$U/realtime',{transports:['websocket']});s.on('unauthorized',m=>console.log(m));setTimeout(()=>process.exit(),4000)"` | evento `unauthorized` y desconexión |
| 6 | Cuenta de Google **no registrada** | En el front, iniciar sesión con la segunda cuenta | «Solicitud enviada» (403 `PENDING_APPROVAL`); en Usuarios, el admin ve la solicitud y la aprueba con un rol |
| 7 | Límite de intentos por IP | `for i in $(seq 14); do curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'Content-Type: application/json' -d '{"idToken":"eyJhbGciOiJSUzI1NiJ9.e30.x","nonce":"abcdefghijklmnopqrstuvwxyz012345"}' $U/auth/google; done` | `401` los primeros 10 y luego `429` con `Retry-After` |

> El caso 7 funciona en Azure **desde el PR #15** (antes la IP llegaba con puerto y el límite no se activaba).
> Esperar 1 minuto entre repeticiones: el límite es de 10 por minuto por IP.

*Qué decir:* «La identidad la verifica Google y el rol lo decide SitpVerse. No guardamos contraseñas. Una cuenta que no conocemos no entra: deja una solicitud que un administrador aprueba.»

### ESC-SEG-02 · Autorización (comentario del profesor: cambio de rol en todas las pantallas)

| # | Caso | Acción | Resultado esperado |
|---|---|---|---|
| 8 | Un rol no puede usar rutas de otro | `curl -i -H "Authorization: Bearer $T" $U/assistance/routes/assigned/me` (ruta solo de conductor) | `403` «Tu rol (ADMIN) no puede…» |
| 9 | **Cambio de rol en vivo** | Ventana A: la persona aprobada en el caso 6, con su pantalla abierta. Ventana B: el admin, en Usuarios, le cambia el rol | La pantalla de la ventana A **cambia sin recargar** (menú y pantallas del nuevo rol) |
| 10 | Cuenta desactivada | Ventana B: desactivar a esa persona | En su siguiente petición vuelve al login |
| 11 | Acción crítica rechazada queda registrada | Con el rol cambiado, intentar una acción del rol anterior | `403` y, en Auditoría, un registro `DENIED` con su identidad |

*Qué decir:* «El rol no viaja en el token: se lee de la base en cada petición, por eso el cambio aplica al instante. Una ruta sin política de acceso se rechaza: el sistema falla cerrado.»

### ESC-SEG-03 · Trazabilidad (comentario del profesor: hora, IP, usuario, navegador y país en **todas** las peticiones)

| # | Caso | Comando o acción | Resultado esperado |
|---|---|---|---|
| 12 | Petición con un `trace_id` propio | `curl -i -H 'x-trace-id: demo-profesor-001' -A 'NavegadorDemo/1.0' $U/auth/nonce` | `X-Trace-Id: demo-profesor-001` |
| 13 | **Todas** las peticiones quedan | `curl -s -H "Authorization: Bearer $T" "$U/audit/requests?limit=20"` (o la pantalla de Auditoría → Peticiones) | La petición 12 con **hora, IP, país (`CO`), navegador, usuario, ruta, código y duración** |
| 14 | Incluidas las rechazadas | repetir el caso 2 y buscarlo en `/audit/requests?status=401` | aparece con IP y navegador, sin usuario |
| 15 | Acciones críticas | `curl -s -H "Authorization: Bearer $T" "$U/audit?limit=10"` | quién, qué, sobre qué, resultado, IP, `traceId` |
| 16 | Hoja de vida de un bus | `curl -s -H "Authorization: Bearer $T" $U/fleet/buses/<id>/history` | viajes, inspecciones con fotos, incidentes, reparaciones y grúas |
| 17 | No se puede borrar el rastro | Video `ESC-SEG-03-trazabilidad.mp4` (UPDATE/DELETE rechazados por la base) | «solo inserción» |

*Qué decir:* «Cada petición, buena o mala, deja hora, IP, país, navegador y usuario. Las acciones críticas se guardan en la misma transacción que el cambio: no puede existir el cambio sin su registro.»

## 3. Logs en Azure + balanceo · en vivo

**Preparar:** Portal de Azure → App Service `sitpverse2026-api` → **Monitoring → Log stream** (queda abierto en una ventana).

1. **Traza de punta a punta.** Ejecutar el caso 12 (`x-trace-id: demo-profesor-001`). En el Log stream aparece la línea JSON con
   `"trace_id":"demo-profesor-001"`, `ip`, `country`, `user_agent`, `status`, `duration_ms` e **`instance`** (qué instancia lo atendió).
2. **Balanceo.** Desde la terminal:
   `for i in $(seq 15); do curl -s -o /dev/null -D - $U/health/live | grep -i x-instance-id; done | sort | uniq -c`
   → reparte entre **3 identificadores distintos** (las 3 instancias). En el Log stream se ven los tres nombres en el campo `instance`.
3. **Grafana → Tablero técnico**: «Instancias vivas: 3», «Peticiones por segundo, por instancia» (las 3 líneas), CPU y memoria por instancia, conexiones WebSocket por instancia, latencia por endpoint, PostgreSQL y Redis `ARRIBA`.
4. **Grafana → Tablero de negocio**: los 4 KPIs del Inception (MTTR, efectividad de desvíos, disponibilidad de flota, asignaciones sin conflicto) y la operación del día.
5. **Rastrear una falla**: provocar un error (caso 2), copiar el `X-Trace-Id` de la respuesta y buscarlo en el Log stream y en Auditoría → Peticiones.

> `X-Instance-Id` y el campo `instance` están disponibles **desde el PR #15**.

*Qué decir:* «Tres instancias detrás del balanceador de App Service, sin afinidad de sesión: cualquier instancia atiende cualquier petición. Cada petición lleva un `trace_id` que aparece en la respuesta, en el log y en la auditoría, y Prometheus recoge las métricas de todas las instancias cada 10 segundos.»

## 4. Prueba de carga · video

Videos en `docs/evidencia/videos/` (terminal en vivo a la izquierda y tablero técnico a la derecha):

| Video | Qué demuestra | Frase |
|---|---|---|
| `ESC-DISP-01-caida-de-instancia.mp4` | Se detiene 1 de 3 instancias en hora pico: el tablero baja de 3 a 2 y vuelve a 3 | «0 % de errores, sockets reconectados en menos de 2 s, 0 alertas perdidas, 0 sobreasignaciones» |
| `ESC-REND-01-hora-pico.mp4` | 60 conductores + 140 oyentes, alerta a la flota, 12 aceptan 3 cupos, 5 mecánicos 1 reparación | «Posición de punta a punta en decenas de ms; de 12 aceptaciones simultáneas ganan exactamente 3» |
| `AZURE-prueba-de-carga-100-concurrentes.mp4` | `loadtest:quality` contra Azure | Se reparte entre las 3 instancias |
| `ESC-SEG-01/02/03-*.mp4` | Las pruebas de seguridad | apoyo del bloque 2 |

Aclaración honesta para el profesor (está en `docs/EVIDENCIA_ESCENARIOS.md`): el escenario completo (140 oyentes) se mide en el entorno de
3 instancias del repositorio; en Azure el plan B1 y PostgreSQL B1ms llegan al tope de conexiones con 140 oyentes, y con pocos oyentes cumple
(HTTP p95 172 ms, punta a punta 169 ms).

## 5. Arquitectura

`docs/ARQUITECTURA.md`: drivers, 12 ADR y 8 diagramas (contexto, componentes, clases, entidad-relación, 3 de secuencia, **despliegue**, actividades).
Aviso sobre el cambio de ESC-SEG-01: `docs/AVISO_PROFESOR.md`.

## Si algo falla en vivo

| Síntoma | Qué hacer |
|---|---|
| La API responde 503 | `az webapp restart -g sitpverse2026-rg -n sitpverse2026-api` y esperar 1–2 min |
| `401` con el token del admin | Venció (8 h): volver a iniciar sesión y copiar el token otra vez |
| El caso 7 no da 429 | Esperar 1 minuto (la ventana del límite) y repetir; confirmar que el PR #15 ya está desplegado |
| Grafana pide inicio de sesión | Es lo esperado: solo roles autorizados ven los tableros |
