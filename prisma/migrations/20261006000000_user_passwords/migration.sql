-- Contraseñas de usuarios (hash bcrypt).
-- El DEFAULT '' solo existe para poder agregar la columna NOT NULL a filas ya creadas:
-- un hash vacío nunca coincide con ninguna contraseña, así que esos usuarios no pueden
-- iniciar sesión hasta que se les asigne una (el seed lo hace). Luego se quita el DEFAULT.
ALTER TABLE "users" ADD COLUMN "passwordHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP DEFAULT;
