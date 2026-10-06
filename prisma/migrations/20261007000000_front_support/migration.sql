-- Lo que necesitan las pantallas del front: ficha de los buses, cuentas activas/inactivas,
-- informes de reparación del mecánico e inspecciones previas al viaje.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "buses"
  ADD COLUMN "model" TEXT,
  ADD COLUMN "year" INTEGER,
  ADD COLUMN "operator" TEXT,
  ADD COLUMN "capacity" INTEGER,
  ADD COLUMN "locationLabel" TEXT;

-- AlterTable
ALTER TABLE "driver_incidents" ADD COLUMN "reportedByName" TEXT;

-- CreateTable
CREATE TABLE "repair_reports" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "mechanicId" TEXT NOT NULL,
    "mechanicName" TEXT NOT NULL,
    "damages" TEXT NOT NULL DEFAULT '',
    "replacedParts" TEXT NOT NULL DEFAULT '',
    "expenses" JSONB NOT NULL DEFAULT '[]',
    "busPhotos" JSONB NOT NULL DEFAULT '[]',
    "partPhotos" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "repair_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bus_inspections" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "inspectorId" TEXT NOT NULL,
    "inspectorName" TEXT NOT NULL,
    "inspectorRole" "UserRole" NOT NULL,
    "note" TEXT NOT NULL,
    "comment" TEXT,
    "photos" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bus_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repair_reports_callId_key" ON "repair_reports"("callId");

-- CreateIndex
CREATE INDEX "repair_reports_mechanicId_completedAt_idx" ON "repair_reports"("mechanicId", "completedAt");

-- CreateIndex
CREATE INDEX "bus_inspections_busId_createdAt_idx" ON "bus_inspections"("busId", "createdAt");

-- CreateIndex
CREATE INDEX "bus_inspections_inspectorId_createdAt_idx" ON "bus_inspections"("inspectorId", "createdAt");

-- AddForeignKey
ALTER TABLE "repair_reports" ADD CONSTRAINT "repair_reports_callId_fkey" FOREIGN KEY ("callId") REFERENCES "assistance_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
