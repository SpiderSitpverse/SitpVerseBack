-- CreateEnum
CREATE TYPE "BusStatus" AS ENUM ('IDLE', 'IN_SERVICE', 'FINISHED');

-- CreateTable
CREATE TABLE "buses" (
    "id" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "driver" TEXT,
    "status" "BusStatus" NOT NULL DEFAULT 'IDLE',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bus_positions" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bus_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "buses_plate_key" ON "buses"("plate");

-- CreateIndex
CREATE INDEX "bus_positions_busId_recordedAt_idx" ON "bus_positions"("busId", "recordedAt");

-- AddForeignKey
ALTER TABLE "bus_positions" ADD CONSTRAINT "bus_positions_busId_fkey" FOREIGN KEY ("busId") REFERENCES "buses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
