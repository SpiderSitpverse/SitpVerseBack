import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Usuarios y buses de demostración (mientras no esté conectada la API real de TransMilenio).
 *
 *   npm run seed          Crea o ACTUALIZA los usuarios y buses de abajo. No borra nada:
 *                         se puede correr varias veces (también contra una base ya en uso).
 *   npm run seed:reset    Borra TODOS los datos y los vuelve a crear (solo desarrollo y pruebas).
 *
 * No hay contraseñas: la identidad la verifica Google. Cada usuario de demostración lleva el correo con el que
 * entra; el de los usuarios 1001 (ADMIN), 2001 (DRIVER) y 3001 (MECHANICAL) sale de SEED_ADMIN_EMAIL,
 * SEED_DRIVER_EMAIL y SEED_MECHANIC_EMAIL (los de tu equipo). Los demás quedan con un correo ficticio
 * `<empleado>@sitpverse.local`, que nadie puede usar para entrar: el admin los cambia desde la pantalla de usuarios.
 */
const PRODUCTION = process.env.NODE_ENV === 'production';
const RESET = process.argv.includes('--reset');

// Borrar todo exige una confirmación explícita en producción, para que un comando mal copiado no vacíe la base real.
if (PRODUCTION && RESET && process.env.CONFIRM_ERASE_EVERYTHING !== 'yes') {
  console.error('seed:reset BORRA TODA la base de datos. En producción exige CONFIRM_ERASE_EVERYTHING=yes.');
  process.exit(1);
}

const TEAM_EMAILS: Record<string, string | undefined> = {
  '1001': process.env.SEED_ADMIN_EMAIL,
  '2001': process.env.SEED_DRIVER_EMAIL,
  '3001': process.env.SEED_MECHANIC_EMAIL,
};
const emailOf = (employeeId: string) =>
  (TEAM_EMAILS[employeeId]?.trim() || `${employeeId}@sitpverse.local`).toLowerCase();

interface Demo {
  employeeId: string;
  name: string;
  role: UserRole;
}

const ADMINS: Demo[] = [
  { employeeId: '1001', name: 'Andrea Salazar', role: 'ADMIN' },
  { employeeId: '1002', name: 'Bruno Medina', role: 'ADMIN' },
  { employeeId: '1003', name: 'Carolina Vega', role: 'ADMIN' },
  { employeeId: '1004', name: 'Daniel Ortiz', role: 'ADMIN' },
  { employeeId: '1005', name: 'Elena Rincón', role: 'ADMIN' },
];

const DRIVERS: Demo[] = [
  { employeeId: '2001', name: 'Carlos Pérez', role: 'DRIVER' },
  { employeeId: '2002', name: 'Laura Gómez', role: 'DRIVER' },
  { employeeId: '2003', name: 'Andrés Ruiz', role: 'DRIVER' },
  { employeeId: '2004', name: 'Diana Torres', role: 'DRIVER' },
  { employeeId: '2005', name: 'Mateo Rojas', role: 'DRIVER' },
];

const MECHANICS: Demo[] = [
  { employeeId: '3001', name: 'Fabián Castro', role: 'MECHANICAL' },
  { employeeId: '3002', name: 'Gloria Herrera', role: 'MECHANICAL' },
  { employeeId: '3003', name: 'Héctor Ramírez', role: 'MECHANICAL' },
  { employeeId: '3004', name: 'Inés Duarte', role: 'MECHANICAL' },
  { employeeId: '3005', name: 'Jorge Naranjo', role: 'MECHANICAL' },
];

/** Un bus por conductor, en el mismo orden que DRIVERS. La ficha (modelo, operador...) es la que muestra el registro de flota. */
const BUSES = [
  { plate: 'TMX-001', route: 'Troncal Caracas', latitude: 4.6097, longitude: -74.0817, locationLabel: 'Calle 26', model: 'Marcopolo Viale BRS', year: 2020, operator: 'Consorcio Express S.A.S.', capacity: 160 },
  { plate: 'TMX-002', route: 'Troncal NQS', latitude: 4.65, longitude: -74.09, locationLabel: 'Portal Eldorado', model: 'Marcopolo Viale BRS', year: 2021, operator: 'Consorcio Express S.A.S.', capacity: 160 },
  { plate: 'TMX-003', route: 'Troncal Autonorte', latitude: 4.71, longitude: -74.05, locationLabel: 'Escuela Militar', model: 'Biarticulado Volvo', year: 2019, operator: 'Este es Mi Bus S.A.S.', capacity: 270 },
  { plate: 'TMX-004', route: 'Troncal Suba', latitude: 4.74, longitude: -74.09, locationLabel: 'Humedal Córdoba', model: 'Biarticulado Scania', year: 2020, operator: 'Consorcio Express S.A.S.', capacity: 270 },
  { plate: 'TMX-005', route: 'Troncal Calle 80', latitude: 4.7, longitude: -74.1, locationLabel: 'Quinta Paredes', model: 'Padrón Volvo', year: 2018, operator: 'Este es Mi Bus S.A.S.', capacity: 90 },
];

async function wipe() {
  // Orden inverso a las dependencias (outbox y alertas → flota → usuarios)
  await prisma.outboxEvent.deleteMany();
  await prisma.busInspection.deleteMany();
  await prisma.repairReport.deleteMany();
  await prisma.rewardEntry.deleteMany();
  await prisma.assistanceClaim.deleteMany();
  await prisma.assistanceCall.deleteMany();
  await prisma.incidentEvidence.deleteMany();
  await prisma.towAssignment.deleteMany();
  await prisma.alternativeRoute.deleteMany();
  await prisma.driverIncident.deleteMany();
  await prisma.busPosition.deleteMany();
  await prisma.bus.deleteMany();
  await prisma.user.deleteMany();
  await prisma.accessRequest.deleteMany();
  // audit_log rechaza DELETE fila por fila (es de solo inserción); TRUNCATE solo existe para limpiar el entorno de pruebas.
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_log"');
}

async function main() {
  if (RESET) {
    await wipe();
    console.log('Base de datos vaciada (--reset).');
  }

  const users = new Map<string, string>(); // employeeId → id
  for (const u of [...ADMINS, ...DRIVERS, ...MECHANICS]) {
    const saved = await prisma.user.upsert({
      where: { employeeId: u.employeeId },
      update: { name: u.name, role: u.role, email: emailOf(u.employeeId) },
      create: { ...u, email: emailOf(u.employeeId) },
    });
    users.set(u.employeeId, saved.id);
  }

  for (const [i, bus] of BUSES.entries()) {
    const driverId = users.get(DRIVERS[i].employeeId)!;
    const { latitude, longitude, locationLabel, ...ficha } = bus;
    await prisma.bus.upsert({
      where: { plate: bus.plate },
      // En un seed repetido solo se actualiza la ficha: no se pisa la posición ni el estado de un bus ya en uso.
      update: { ...ficha, driverId },
      create: { ...bus, driverId },
    });
  }

  console.log(
    `Seed completado: ${ADMINS.length} ADMIN, ${DRIVERS.length} DRIVER y ${MECHANICS.length} MECHANICAL ` +
      `(entran con Google; el correo del 1001, 2001 y 3001 sale de SEED_*_EMAIL) y ${BUSES.length} buses con conductor asignado.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
