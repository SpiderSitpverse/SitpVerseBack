# Aviso para el profesor · cambio en ESC-SEG-01

**Asunto: ESC-SEG-01 (autenticación): qué pasa con una cuenta de Google que no está registrada**

Buenas, profe. Al implementar la autenticación con Google ajustamos un detalle del escenario y queremos dejarlo claro.

**Lo que decía el escenario.** Una cuenta de Google válida que no trabaja en la operación recibe **403**, igual que una
cuenta desactivada, con el mismo mensaje.

**Lo que hace ahora el sistema.** Sigue respondiendo **403 con el mismo mensaje y el mismo motivo** (`PENDING_APPROVAL`)
para una cuenta no registrada, y además deja una **solicitud de acceso** pendiente (con el nombre y la foto que trae
Google). Un administrador la ve en la pantalla de usuarios y la **aprueba** (eligiendo el rol y el número de empleado) o
la **rechaza**. Hasta entonces la persona **no tiene sesión, ni rol, ni acceso a nada**. Todo (solicitud, aprobación,
rechazo) queda en la auditoría. Hay un tope de 200 solicitudes abiertas y el límite por IP (10 por minuto) para que no se
pueda inundar.

**Por qué.** Sin esto, la única forma de dar acceso era que el administrador conociera de antemano el correo exacto de
cada persona. Así el administrador decide con la persona ya identificada por Google, y el principio se mantiene: **la
identidad la verifica Google y la autorización (el rol) la decide SitpVerse**; nunca sale de los datos de Google.

**Qué no cambió.** Las medidas del escenario se cumplen igual: 100 % de los ID tokens inválidos reciben 401, el 403 de
cuenta no registrada y de cuenta desactivada es idéntico (no revela quién trabaja en la empresa), más de 10 intentos por
minuto por IP reciben 429 con `Retry-After`, 0 contraseñas guardadas.

**Cómo verlo.** `npm run loadtest:security` (secciones 3c y 3d) o el video `ESC-SEG-01-autenticacion.mp4`.
