CREATE TABLE "incident_evidence" (
  "id" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "caption" TEXT,
  "capturedAt" TIMESTAMP(3),
  "uploadedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "incident_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incident_evidence_incidentId_fkey"
    FOREIGN KEY ("incidentId") REFERENCES "driver_incidents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "incident_evidence_incidentId_createdAt_idx"
  ON "incident_evidence"("incidentId", "createdAt");
