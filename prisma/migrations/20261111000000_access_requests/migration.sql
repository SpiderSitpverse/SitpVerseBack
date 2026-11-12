-- Solicitudes de acceso: quien entra con Google sin cuenta queda en espera hasta que un administrador lo acepte.
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'REJECTED');

CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "photoUrl" TEXT,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "access_requests_email_key" ON "access_requests"("email");
CREATE UNIQUE INDEX "access_requests_googleSub_key" ON "access_requests"("googleSub");
CREATE INDEX "access_requests_status_requestedAt_idx" ON "access_requests"("status", "requestedAt");
