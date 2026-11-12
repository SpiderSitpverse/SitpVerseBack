-- Trazabilidad de TODAS las peticiones: hora, IP, usuario, navegador y país (solo inserción).
ALTER TABLE "audit_log" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "audit_log" ADD COLUMN "country" TEXT;

CREATE TABLE "request_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "traceId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "ip" TEXT,
    "country" TEXT,
    "userAgent" TEXT,
    "userId" TEXT,
    "role" "UserRole",
    CONSTRAINT "request_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "request_log_at_idx" ON "request_log"("at");
CREATE INDEX "request_log_userId_at_idx" ON "request_log"("userId", "at");
CREATE INDEX "request_log_ip_at_idx" ON "request_log"("ip", "at");

CREATE FUNCTION request_log_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'request_log es de solo inserción (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER request_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "request_log"
  FOR EACH ROW EXECUTE FUNCTION request_log_reject_change();
