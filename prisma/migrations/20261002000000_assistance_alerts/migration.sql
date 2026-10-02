-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'DRIVER', 'MECHANICAL');

-- CreateEnum
CREATE TYPE "IncidentReportStatus" AS ENUM ('REPORTED', 'HELP_REQUESTED');

-- CreateEnum
CREATE TYPE "AssistanceKind" AS ENUM ('DRIVER_SUPPORT', 'REPAIR');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('OPEN', 'FILLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterTable
ALTER TABLE "buses" DROP COLUMN "driver",
ADD COLUMN     "driverId" TEXT;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_incidents" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "status" "IncidentReportStatus" NOT NULL DEFAULT 'REPORTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistance_calls" (
    "id" TEXT NOT NULL,
    "kind" "AssistanceKind" NOT NULL,
    "incidentId" TEXT,
    "busId" TEXT NOT NULL,
    "slots" INTEGER NOT NULL,
    "claimedCount" INTEGER NOT NULL DEFAULT 0,
    "rewardPoints" INTEGER NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "assistance_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistance_claims" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "busId" TEXT,
    "arriveBy" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistance_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_employeeId_key" ON "users"("employeeId");

-- CreateIndex
CREATE INDEX "assistance_calls_kind_status_idx" ON "assistance_calls"("kind", "status");

-- CreateIndex
CREATE INDEX "assistance_claims_callId_status_idx" ON "assistance_claims"("callId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "assistance_claims_callId_userId_key" ON "assistance_claims"("callId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "reward_entries_userId_callId_key" ON "reward_entries"("userId", "callId");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_eventId_key" ON "outbox_events"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "buses_driverId_key" ON "buses"("driverId");

-- AddForeignKey
ALTER TABLE "buses" ADD CONSTRAINT "buses_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistance_claims" ADD CONSTRAINT "assistance_claims_callId_fkey" FOREIGN KEY ("callId") REFERENCES "assistance_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistance_claims" ADD CONSTRAINT "assistance_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_entries" ADD CONSTRAINT "reward_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Barreras que Prisma no puede modelar en schema.prisma.
-- Son la ÚLTIMA defensa: aunque fallara el lock de Redis o la lógica de aplicación,
-- la base de datos rechaza estados imposibles.
-- ─────────────────────────────────────────────────────────────────────────────

-- Nunca más reclamos activos que cupos.
ALTER TABLE "assistance_calls"
  ADD CONSTRAINT "assistance_calls_claimed_within_slots"
  CHECK ("claimedCount" >= 0 AND "claimedCount" <= "slots" AND "slots" >= 1);

-- Un bus no puede tener dos alertas de reparación abiertas a la vez:
-- deduplica reportes de falla simultáneos sobre el mismo bus.
CREATE UNIQUE INDEX "assistance_one_open_repair_per_bus"
  ON "assistance_calls" ("busId")
  WHERE "kind" = 'REPAIR' AND "status" <> 'COMPLETED';

-- El relay del outbox solo mira lo pendiente: índice parcial pequeño y rápido.
CREATE INDEX "outbox_events_unpublished"
  ON "outbox_events" ("id")
  WHERE "publishedAt" IS NULL;
