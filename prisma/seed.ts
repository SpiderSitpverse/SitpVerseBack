import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Datos de desarrollo. Mientras no esté conectada la API real de TransMilenio (ni exista
 * Identity real), buses y usuarios se siembran aquí. Es destructivo: borra y recrea todo.
 *
 * Usuarios: el header `x-employee-id` los identifica.
 *   1001-1002 ADMIN · 2001-2005 DRIVER · 3001-3003 MECHANICAL
 * Cada bus tiene su conductor asignado (TMX-001 → 2001, … TMX-004 → 2004); 2005 no tiene bus.
 */
async function main() {
  // Orden inverso a las dependencias (outbox y alertas → flota → usuarios)
  await prisma.outboxEvent.deleteMany();
  await prisma.rewardEntry.deleteMany();
  await prisma.assistanceClaim.deleteMany();
  await prisma.assistanceCall.deleteMany();
  await prisma.driverIncident.deleteMany();
  await prisma.busPosition.deleteMany();
  await prisma.bus.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.createMany({
    data: [
      { employeeId: '1001', name: 'Admin Central', role: 'ADMIN' },
      { employeeId: '1002', name: 'Admin Turno Noche', role: 'ADMIN' },
      { employeeId: '2001', name: 'Carlos Pérez', role: 'DRIVER' },
      { employeeId: '2002', name: 'Laura Gómez', role: 'DRIVER' },
      { employeeId: '2003', name: 'Andrés Ruiz', role: 'DRIVER' },
      { employeeId: '2004', name: 'Diana Torres', role: 'DRIVER' },
      { employeeId: '2005', name: 'Mateo Rojas', role: 'DRIVER' },
      { employeeId: '3001', name: 'Mecánico Uno', role: 'MECHANICAL' },
      { employeeId: '3002', name: 'Mecánico Dos', role: 'MECHANICAL' },
      { employeeId: '3003', name: 'Mecánico Tres', role: 'MECHANICAL' },
    ],
  });

  const driver = async (employeeId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { employeeId } })).id;

  await prisma.bus.createMany({
    data: [
      { plate: 'TMX-001', route: 'Troncal Caracas', driverId: await driver('2001'), latitude: 4.6097, longitude: -74.0817 },
      { plate: 'TMX-002', route: 'Troncal NQS', driverId: await driver('2002'), latitude: 4.65, longitude: -74.09 },
      { plate: 'TMX-003', route: 'Troncal Autonorte', driverId: await driver('2003'), latitude: 4.71, longitude: -74.05 },
      { plate: 'TMX-004', route: 'Troncal Suba', driverId: await driver('2004'), latitude: 4.74, longitude: -74.09 },
    ],
  });

  console.log('Seed completado: 10 usuarios (2 ADMIN, 5 DRIVER, 3 MECHANICAL) y 4 buses con conductor asignado.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
