-- Hora de salida del viaje actual (la muestran el mapa y el inicio del conductor).
ALTER TABLE "buses" ADD COLUMN "tripStartedAt" TIMESTAMP(3);
