# Despliegue en Azure

Cómo publicar el back en **Azure App Service** (Linux, Node 22) con **PostgreSQL** y **Redis** gestionados, y
conectarlo con el front. El código ya está preparado: lo que sigue es crear los recursos y configurarlos.

```
Front (Static Web Apps) ──https/wss──►  App Service (Node 22)  ──►  Azure Database for PostgreSQL
                                                              └──►  Azure Managed Redis
          GitHub Actions: al hacer push a `main` prueba, compila y despliega
```

> Crear estos recursos **cuesta dinero** mientras existan. Al terminar la demo, borra el grupo de recursos
> (último apartado).
>
> Los comandos de `az` de esta guía no se pudieron ejecutar al escribirla (no había Azure CLI en el equipo):
> si alguno falla o cambió de formato, el portal de Azure ofrece las mismas opciones con formularios.

## Qué trae ya el código

| | |
|---|---|
| `GET /health` | Comprueba base de datos y Redis (200 o 503). Sirve para el *health check* de Azure. |
| Redis con contraseña y TLS | Variables `REDIS_PASSWORD` y `REDIS_TLS`. |
| Configuración obligatoria | Con `NODE_ENV=production` la app **no arranca** sin `JWT_SECRET` (≥32 caracteres), `GOOGLE_CLIENT_ID`, `CORS_ORIGIN` (la URL del front, nunca `*`), `DATABASE_URL` y un `REDIS_HOST` que no sea localhost. |
| Login con Google (OIDC) | `POST /auth/google` verifica el ID token de Google (firma, `iss`, `aud`, `exp`, correo verificado, `nonce`). Sin contraseñas. |
| Límite por IP | Más de 10 peticiones por minuto de login desde una IP → 429 con `Retry-After`. Configurable con `LOGIN_RATE_PER_MINUTE`. |
| Auditoría | Tabla `audit_log` de solo inserción (trigger) y `GET /audit` solo para ADMIN. |
| Fotos | En Azure se guardan solas en `/home/uploads` (persisten entre reinicios). |
| Cabeceras de seguridad | `helmet`. |
| Migraciones | `npm run start:azure` aplica las migraciones y arranca la app. |
| Seed compilado | `npm run seed:prod` prerregistra los usuarios sin necesitar `ts-node`. |
| CI | `.github/workflows/ci.yml`: pruebas unitarias y pruebas de carga reales en cada PR. |
| CD | `.github/workflows/deploy.yml`: despliega al hacer push a `main`. |

## 1. Prepara tu PC

- Una suscripción de Azure activa (revisa si tu cuenta de estudiante da crédito).
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli): `winget install Microsoft.AzureCLI`.

```bash
az login
```

Elige un **nombre único** para todo (minúsculas y números), por ejemplo `sitpverse`. Más abajo se escribe `<n>`.

## 2. Grupo de recursos

```bash
az group create --name <n>-rg --location eastus
```

## 3. PostgreSQL

```bash
az postgres flexible-server create --resource-group <n>-rg --name <n>-db --location eastus --admin-user sitpadmin --admin-password '<CONTRASEÑA-FUERTE>' --sku-name Standard_B1ms --tier Burstable --database-name sitpverse --public-access 0.0.0.0
```

`--public-access 0.0.0.0` permite que los servicios de Azure se conecten. Tu `DATABASE_URL`:

```
postgresql://sitpadmin:<CONTRASEÑA>@<n>-db.postgres.database.azure.com:5432/sitpverse?sslmode=require
```

Si la contraseña tiene `@`, `#`, `/` u otros símbolos, escríbelos codificados en la URL (`@` → `%40`).

## 4. Redis

Desde el portal: **Crear un recurso → Azure Managed Redis**, en el mismo grupo y región, con el nivel más pequeño.

- **Clustering policy:** elige **Enterprise** (un solo punto de conexión; es lo que espera nuestro cliente).
  Verifícalo en el portal: no pude confirmarlo en la documentación.
- Del recurso anota el **nombre del host**, el **puerto** (normalmente `10000`) y la **clave de acceso**
  (*Authentication → Access keys*).
- La conexión es siempre cifrada: usa `REDIS_TLS=true`.

## 5. App Service

```bash
az appservice plan create --name <n>-plan --resource-group <n>-rg --is-linux --sku B1
```

```bash
az webapp create --name <n>-api --resource-group <n>-rg --plan <n>-plan --runtime "NODE:22-lts"
```

> **No uses el plan Free (F1):** limita las conexiones WebSocket y no mantiene la app encendida (se dormirían
> el relay de eventos y el consumidor de alertas). Mínimo **B1**.

Activa los WebSockets y mantenla siempre encendida, y define cómo arranca:

```bash
az webapp config set --name <n>-api --resource-group <n>-rg --web-sockets-enabled true --always-on true --startup-file "npm run start:azure" --generic-configurations '{"healthCheckPath": "/health"}'
```

### Variables de configuración

Genera el secreto del token (guárdalo aparte, no lo pierdas ni lo subas al repositorio):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
az webapp config appsettings set --name <n>-api --resource-group <n>-rg --settings NODE_ENV=production SCM_DO_BUILD_DURING_DEPLOYMENT=false DATABASE_URL="<URL del paso 3>" REDIS_HOST="<host de Redis>" REDIS_PORT=10000 REDIS_PASSWORD="<clave de acceso>" REDIS_TLS=true JWT_SECRET="<el secreto generado>" GOOGLE_CLIENT_ID="<Client ID de Google>" CORS_ORIGIN="https://<url-de-tu-front>"
```

| Variable | Para qué |
|---|---|
| `NODE_ENV=production` | Activa las comprobaciones de arranque seguro. |
| `SCM_DO_BUILD_DURING_DEPLOYMENT=false` | El código llega **ya compilado** desde GitHub Actions. |
| `JWT_SECRET` | Firma los tokens de sesión. Si se pierde o cambia, todas las sesiones se cierran. |
| `GOOGLE_CLIENT_ID` | Client ID de Google OAuth de SitpVerse: la audiencia que deben traer los ID tokens. No lleva secreto. |
| `CORS_ORIGIN` | La URL exacta del front (con `https://`); varias, separadas por coma. |
| `FLEET_FEED_MODE=external` | Apaga el feed simulado de posiciones (ya es el valor por defecto). Con `simulated` el servidor mueve cada bus en servicio ±110 m cada 3 s y **se pisa con el GPS del conductor**: el bus "camina" estando quieto. |

`PORT` no hace falta: App Service lo define y la app ya lo lee. Tampoco `UPLOADS_DIR`: en Azure las fotos van
automáticamente a `/home/uploads`, el único disco que **persiste** entre reinicios (si la cambias a otro lugar, el
log avisa).

## 6. Despliegue automático (GitHub Actions)

1. Descarga el perfil de publicación:

   ```bash
   az webapp deployment list-publishing-profiles --name <n>-api --resource-group <n>-rg --xml
   ```

   (o en el portal: tu App Service → **Get publish profile**).
2. En GitHub: **Settings → Secrets and variables → Actions**:
   - **Secret** `AZURE_WEBAPP_PUBLISH_PROFILE` = el contenido completo de ese XML.
   - **Variable** `AZURE_WEBAPP_NAME` = `<n>-api`.
3. Haz el merge a `main`. El flujo `Deploy a Azure` prueba, compila y publica. También puedes lanzarlo a mano
   desde la pestaña **Actions → Deploy a Azure → Run workflow**.

Al arrancar, la app aplica las migraciones de la base de datos por sí sola (`prisma migrate deploy`).

## 7. Crear el Client ID de Google y prerregistrar a las personas (una sola vez)

1. En [console.cloud.google.com](https://console.cloud.google.com) → **APIs y servicios → Credenciales → Crear credenciales →
   ID de cliente de OAuth** (tipo *Aplicación web*). En **Orígenes de JavaScript autorizados** pon la URL del front
   (`https://<tu-front>.azurestaticapps.net`) y `http://localhost:5173`. Copia el Client ID y úsalo en `GOOGLE_CLIENT_ID`
   (back) y en `VITE_GOOGLE_CLIENT_ID` (front).
2. En la pantalla de consentimiento agrega como *usuarios de prueba* los correos del equipo mientras la app esté en modo "Testing".
3. En el App Service → **Development Tools → SSH**, prerregistra a los usuarios de demostración:

```bash
SEED_ADMIN_EMAIL='correo-admin@gmail.com' npm run seed:prod
```

- Crea 15 usuarios (5 por rol) y 5 buses. **No borra nada**: puedes repetirlo. El usuario 1001 (ADMIN) queda con el correo
  indicado: es quien acepta a los demás. Los otros 14 quedan con un correo ficticio que nadie puede usar para entrar.
- **Para sumar a más personas**: entran con Google, quedan en *solicitudes de acceso* y el admin las acepta y les da el rol desde
  la pantalla "Usuarios". (También puede prerregistrarlas con `POST /users` si ya conoce su correo.)
- Opcional: `SEED_DRIVER_EMAIL` y `SEED_MECHANIC_EMAIL` dejan ya listos al conductor 2001 y al mecánico 3001.
- `seed:reset` (que vacía la base) en producción se niega salvo con `CONFIRM_ERASE_EVERYTHING=yes`.

## 8. Comprobar que funciona

```bash
curl https://<n>-api.azurewebsites.net/health
```

Debe responder `{"status":"ok","checks":{"database":"up","redis":"up",…}}`. El inicio de sesión se prueba desde el front (botón de Google); para comprobar que el back responde:

```bash
curl https://<n>-api.azurewebsites.net/auth/nonce
```

Para ver los registros en vivo:

```bash
az webapp log tail --name <n>-api --resource-group <n>-rg
```

Busca `Nest application successfully started` y `Suscrito a Pub/Sub`.

## 9. Conectar el front

- En el front, la URL del back: `https://<n>-api.azurewebsites.net` (variable `VITE_API_URL`).
- El WebSocket usa esa misma URL con `/realtime`; con `https` el navegador usa `wss` solo.
- `CORS_ORIGIN` del back debe ser **exactamente** la URL del front, o el navegador bloqueará las peticiones.
- Detalle de endpoints, tipos y ejemplos: [`docs/API.md`](API.md).

Para publicar el front puedes usar **Azure Static Web Apps** (encaja con React + Vite).

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| La app no arranca y el log dice `Configuración de producción inválida` | Falta o es inválida una variable obligatoria (la lista dice cuál). |
| `JWT_SECRET es obligatorio en producción` | Falta `JWT_SECRET` o tiene menos de 32 caracteres. |
| `/health` responde 503 con `redis: down` | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` o `REDIS_TLS` incorrectos. |
| `/health` responde 503 con `database: down` | `DATABASE_URL` mal escrita (revisa los caracteres especiales) o el firewall del servidor. |
| El front dice `CORS` en la consola | `CORS_ORIGIN` no coincide con la URL del front (incluye `https://`, sin barra final). |
| Las alertas no llegan en tiempo real | WebSockets sin activar, o plan Free. |
| Las fotos desaparecen al reiniciar | Se configuró `UPLOADS_DIR` fuera de `/home` (el log lo avisa al arrancar). |
| Login responde 429 | 5 intentos fallidos: espera el tiempo de `Retry-After` (15 min por defecto). |

## Ver las peticiones y los logs en Azure

El back escribe **una línea JSON por petición** (`event: http.request`, con `trace_id`, método, ruta, código, duración, IP y
usuario) y las acciones críticas quedan además en `GET /audit`. Para verlas:

- **En vivo:** `az webapp log tail --name <n>-api --resource-group <n>-rg` (o portal → App Service → *Log stream*).
- **Consultable:** el App Service envía sus logs a un workspace de Log Analytics (`<n>-logs`). En el portal: workspace →
  *Logs*, y por ejemplo:

```kusto
AppServiceConsoleLogs
| where ResultDescription has "http.request"
| extend e = parse_json(extract("(\\{.*\\})", 1, ResultDescription))
| project TimeGenerated, trace = e.trace_id, method = e.method, path = e.path, status = e.status, ms = e.duration_ms, user = e.user_id, ip = e.ip
| order by TimeGenerated desc
```

  `AppServiceHTTPLogs` trae lo que ve la plataforma (también las peticiones que no llegan a la app). Un error 5xx se rastrea con
  su `trace_id` (header `X-Trace-Id` de la respuesta).

## Retención de los registros (qué se guarda y por cuánto tiempo)

| Tabla | Qué guarda | Se conserva | Mínimo que impone la base |
|---|---|---|---|
| `request_log` | TODAS las peticiones: hora, IP, país, navegador, usuario | **14 días** (`REQUEST_LOG_RETENTION_DAYS`) | 7 días |
| `audit_log` | Acciones críticas (ingresos, usuarios, solicitudes de acceso, roles…) | **730 días** (`AUDIT_RETENTION_DAYS`) | 365 días |

- Siguen siendo de **solo inserción**: UPDATE está prohibido siempre, y DELETE solo se permite sobre filas que ya pasaron su
  mínimo (lo hace cumplir un trigger de la base, no solo la aplicación). Nadie puede borrar lo reciente.
- Una purga corre cada 6 horas (y 10 min después de arrancar), en lotes de 5 000 con pausa y con un candado de la base: una sola
  instancia a la vez y sin competir con la operación. Cada purga queda en `audit_log` como `retention.purge`.
- Por qué 14 días: `request_log` es lo que más crece (cada posición GPS es una petición, ~20 por segundo con 60 buses ≈ 600 MB al
  día). Su utilidad está en lo reciente; la evidencia a largo plazo vive en `audit_log`, que crece muy poco.
- Para la presentación en vivo no hay que hacer nada: el volumen de una demo es mínimo y la purga no corre durante los
  primeros 10 minutos tras arrancar. `LOG_RETENTION_ENABLED=false` la apaga por completo.

## Limpieza

Borra todos los recursos (y el cobro) de una vez:

```bash
az group delete --name <n>-rg --yes --no-wait
```

## Límites conocidos

- **Una sola instancia** del App Service: el diseño soporta varias (locks, outbox y límites viven en Redis),
  pero no se probó con varias a la vez.
- **Fotos en disco:** para algo más serio, Azure Blob Storage (se cambia solo `LocalFileStorage`).
- **Dependencias con avisos de seguridad** en `npm audit` (`multer`, `lodash`, `body-parser`, que Nest trae por
  dentro): el arreglo es subir Nest a la versión 12, un cambio mayor que conviene hacer aparte.
