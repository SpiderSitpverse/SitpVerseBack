import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { BusHistory, BusHistoryPort } from '../../domain/ports/bus-history.port';

/** Tope por lista: la hoja de vida es para consultar, no para descargar la base. */
const LIMIT = 200;

interface Row {
  bus: BusHistory['bus'];
  events: BusHistory['events'];
  inspections: BusHistory['inspections'];
  incidents: BusHistory['incidents'];
  repairs: BusHistory['repairs'];
  tows: BusHistory['tows'];
}

/**
 * La hoja de vida de un bus con UNA sola consulta (ESC-SEG-03): PostgreSQL arma cada lista como JSON, así que es una
 * sola ida a la base aunque reúna auditoría, inspecciones, incidentes con sus fotos, reparaciones y grúas.
 * Solo lectura.
 */
@Injectable()
export class PrismaBusHistory implements BusHistoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async of(busId: string): Promise<BusHistory | null> {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        json_build_object(
          'id', b."id", 'plate', b."plate", 'route', b."route", 'status', b."status",
          'driverId', b."driverId", 'driverName', u."name"
        ) AS bus,
        (SELECT coalesce(json_agg(x), '[]'::json) FROM (
           SELECT a."at", a."action", a."outcome", a."actorId", a."actorEmail", a."actorRole", a."detail"
             FROM "audit_log" a
            WHERE a."resourceType" = 'bus' AND a."resourceId" = b."id"
            ORDER BY a."at" DESC LIMIT ${LIMIT}) x) AS events,
        (SELECT coalesce(json_agg(x), '[]'::json) FROM (
           SELECT i."id", i."createdAt" AS "at", i."inspectorId", i."inspectorName", i."inspectorRole",
                  i."note", i."comment", i."photos"
             FROM "bus_inspections" i
            WHERE i."busId" = b."id"
            ORDER BY i."createdAt" DESC LIMIT ${LIMIT}) x) AS inspections,
        (SELECT coalesce(json_agg(x), '[]'::json) FROM (
           SELECT d."id", d."createdAt" AS "at", d."type", d."description", d."status", d."reportedById", d."reportedByName",
                  (SELECT coalesce(json_agg(json_build_object(
                            'url', e."url", 'caption', e."caption", 'uploadedById', e."uploadedById", 'at', e."createdAt")
                            ORDER BY e."createdAt"), '[]'::json)
                     FROM "incident_evidence" e WHERE e."incidentId" = d."id") AS evidence
             FROM "driver_incidents" d
            WHERE d."busId" = b."id"
            ORDER BY d."createdAt" DESC LIMIT ${LIMIT}) x) AS incidents,
        (SELECT coalesce(json_agg(x), '[]'::json) FROM (
           SELECT c."id" AS "callId", c."createdAt" AS "at", c."status", c."description", c."completedAt",
                  r."mechanicName", r."damages", r."replacedParts",
                  coalesce(r."busPhotos", '[]'::jsonb) AS "busPhotos", coalesce(r."partPhotos", '[]'::jsonb) AS "partPhotos"
             FROM "assistance_calls" c
             LEFT JOIN "repair_reports" r ON r."callId" = c."id"
            WHERE c."busId" = b."id" AND c."kind" = 'REPAIR'
            ORDER BY c."createdAt" DESC LIMIT ${LIMIT}) x) AS repairs,
        (SELECT coalesce(json_agg(x), '[]'::json) FROM (
           SELECT t."id", t."createdAt" AS "at", t."incidentId", t."towTruck", t."crew", t."status", t."assignedById", t."completedAt"
             FROM "tow_assignments" t
            WHERE t."busId" = b."id"
            ORDER BY t."createdAt" DESC LIMIT ${LIMIT}) x) AS tows
      FROM "buses" b
      LEFT JOIN "users" u ON u."id" = b."driverId"
      WHERE b."id" = ${busId}`;
    return rows[0] ?? null;
  }
}
