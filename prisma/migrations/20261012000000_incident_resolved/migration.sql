-- Un incidente pasa a RESOLVED cuando todas sus alertas terminaron (el conductor confirma "atención recibida").
ALTER TYPE "IncidentReportStatus" ADD VALUE 'RESOLVED';
