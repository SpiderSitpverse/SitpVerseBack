CREATE TYPE "BlockageStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "AlternativeRouteStatus" AS ENUM ('PROPOSED', 'ASSIGNED', 'ACCEPTED');
CREATE TYPE "TowAssignmentStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED');

ALTER TABLE "driver_incidents" ADD COLUMN "blockageStatus" "BlockageStatus" NOT NULL DEFAULT 'OPEN';

CREATE TABLE "alternative_routes" (
  "id" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "geometry" JSONB NOT NULL,
  "status" "AlternativeRouteStatus" NOT NULL DEFAULT 'PROPOSED',
  "assignedToId" TEXT,
  "assignedAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alternative_routes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alternative_routes_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "driver_incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "alternative_routes_incidentId_status_idx" ON "alternative_routes"("incidentId", "status");
CREATE INDEX "alternative_routes_assignedToId_status_idx" ON "alternative_routes"("assignedToId", "status");

CREATE TABLE "tow_assignments" (
  "id" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "busId" TEXT NOT NULL,
  "towTruck" TEXT NOT NULL,
  "crew" TEXT NOT NULL,
  "status" "TowAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
  "assignedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "tow_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tow_assignments_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "driver_incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tow_assignments_incidentId_status_idx" ON "tow_assignments"("incidentId", "status");
