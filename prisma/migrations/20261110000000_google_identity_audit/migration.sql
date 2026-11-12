-- Identidad con Google (OpenID Connect): se agregan los datos de Google y se ELIMINAN las contraseñas.
ALTER TABLE "users" ADD COLUMN "email" TEXT;
ALTER TABLE "users" ADD COLUMN "googleSub" TEXT;
ALTER TABLE "users" ADD COLUMN "firstName" TEXT;
ALTER TABLE "users" ADD COLUMN "lastName" TEXT;
ALTER TABLE "users" ADD COLUMN "photoUrl" TEXT;
ALTER TABLE "users" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- Las cuentas que ya existían reciben un correo provisional (el admin lo corrige con PATCH /users/:id).
UPDATE "users" SET "email" = lower("employeeId") || '@sitpverse.local' WHERE "email" IS NULL;
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_googleSub_key" ON "users"("googleSub");

ALTER TABLE "users" DROP COLUMN "passwordHash";

-- Auditoría de solo inserción.
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "actorSub" TEXT,
    "actorRole" "UserRole",
    "action" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "outcome" TEXT NOT NULL,
    "ip" TEXT,
    "traceId" TEXT,
    "detail" JSONB,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");
CREATE INDEX "audit_log_actorId_at_idx" ON "audit_log"("actorId", "at");
CREATE INDEX "audit_log_resourceType_resourceId_at_idx" ON "audit_log"("resourceType", "resourceId", "at");
CREATE INDEX "audit_log_action_at_idx" ON "audit_log"("action", "at");

-- Nadie (ni la API ni el usuario de la aplicación) puede modificar o borrar un registro ya guardado.
CREATE FUNCTION audit_log_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
