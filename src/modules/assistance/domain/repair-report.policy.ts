import { ConflictError, ForbiddenError, InvalidInputError } from '../../../shared/domain/errors';
import { isUploadedImageUrl } from '../../../shared/domain/file-storage.port';
import {
  AssistanceCallModel,
  ClaimModel,
  RepairExpense,
  RepairReportInput,
  RepairReportModel,
} from './models/assistance.models';
import { Actor } from './assistance.policy';

/** Reglas del informe de reparación (funciones puras, sin infraestructura). */

export const MAX_TEXT_LENGTH = 4000;
export const MAX_EXPENSES = 30;
export const MAX_PHOTOS_PER_GROUP = 10;
const MAX_CONCEPT_LENGTH = 120;
const MAX_EXPENSE_VALUE = 1_000_000_000;

/** Solo el mecánico que TIENE el servicio (aceptación activa) escribe el informe de esa reparación. */
export function assertCanWriteReport(
  call: AssistanceCallModel,
  actor: Actor,
  activeClaims: ClaimModel[],
): void {
  if (call.kind !== 'REPAIR') {
    throw new ConflictError('Solo las alertas de reparación tienen informe del mecánico');
  }
  const holdsService = actor.role === 'MECHANICAL' && activeClaims.some((c) => c.userId === actor.id);
  if (!holdsService) {
    throw new ForbiddenError('Solo el mecánico que aceptó esta reparación puede escribir su informe');
  }
  if (call.status === 'COMPLETED') {
    throw new ConflictError('La alerta ya fue completada', { reason: 'CALL_CLOSED' });
  }
}

/** El ADMIN lee cualquier informe; el mecánico, solo los suyos. */
export function assertCanReadReport(actor: Actor, report: RepairReportModel): void {
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'MECHANICAL' && report.mechanicId === actor.id) return;
  throw new ForbiddenError('No tienes acceso a este informe');
}

function text(value: unknown, field: string): string {
  const str = typeof value === 'string' ? value.trim() : '';
  if (str.length > MAX_TEXT_LENGTH) {
    throw new InvalidInputError(`${field} no puede superar ${MAX_TEXT_LENGTH} caracteres`);
  }
  return str;
}

function photos(values: unknown, field: string): string[] {
  const list = Array.isArray(values) ? values : [];
  if (list.length > MAX_PHOTOS_PER_GROUP) {
    throw new InvalidInputError(`${field}: máximo ${MAX_PHOTOS_PER_GROUP} fotos`);
  }
  if (!list.every(isUploadedImageUrl)) {
    throw new InvalidInputError(`${field}: las fotos deben ser archivos subidos con POST /files/images`);
  }
  return list;
}

function expenses(values: unknown): RepairExpense[] {
  const list = Array.isArray(values) ? values : [];
  const clean: RepairExpense[] = [];
  for (const raw of list) {
    const concepto = typeof raw?.concepto === 'string' ? raw.concepto.trim() : '';
    const valor = Number(raw?.valor ?? 0);
    if (concepto === '' && valor === 0) continue; // renglón vacío del formulario
    if (concepto.length > MAX_CONCEPT_LENGTH) {
      throw new InvalidInputError(`El concepto de un gasto no puede superar ${MAX_CONCEPT_LENGTH} caracteres`);
    }
    if (!Number.isFinite(valor) || valor < 0 || valor > MAX_EXPENSE_VALUE) {
      throw new InvalidInputError('El valor de cada gasto debe ser un número entre 0 y 1.000.000.000');
    }
    clean.push({ concepto, valor });
  }
  if (clean.length > MAX_EXPENSES) {
    throw new InvalidInputError(`Máximo ${MAX_EXPENSES} gastos por informe`);
  }
  return clean;
}

/** Limpia y valida lo que llega del formulario. Un borrador puede estar incompleto. */
export function normalizeReport(input: Partial<Record<keyof RepairReportInput, unknown>>): RepairReportInput {
  return {
    damages: text(input.damages, 'Los daños encontrados'),
    replacedParts: text(input.replacedParts, 'Las piezas reemplazadas'),
    expenses: expenses(input.expenses),
    busPhotos: photos(input.busPhotos, 'Fotos del bus'),
    partPhotos: photos(input.partPhotos, 'Fotos de las piezas'),
  };
}

/** Para dejar el informe definitivo se exige describir los daños encontrados. */
export function assertCanFinalize(report: RepairReportInput): void {
  if (report.damages === '') {
    throw new InvalidInputError('Describe los daños encontrados para finalizar el servicio');
  }
}
