"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    await prisma.busPosition.deleteMany();
    await prisma.bus.deleteMany();
    await prisma.bus.createMany({
        data: [
            {
                plate: 'TMX-001',
                route: 'Troncal Caracas',
                driver: 'Carlos Pérez',
                status: 'IDLE',
                latitude: 4.6097,
                longitude: -74.0817,
            },
            {
                plate: 'TMX-002',
                route: 'Troncal NQS',
                driver: 'Laura Gómez',
                status: 'IDLE',
                latitude: 4.65,
                longitude: -74.09,
            },
            {
                plate: 'TMX-003',
                route: 'Troncal Autonorte',
                driver: 'Andrés Ruiz',
                status: 'IDLE',
                latitude: 4.71,
                longitude: -74.05,
            },
            {
                plate: 'TMX-004',
                route: 'Troncal Suba',
                driver: 'Diana Torres',
                status: 'IDLE',
                latitude: 4.74,
                longitude: -74.09,
            },
        ],
    });
    console.log('Seed completado: 4 buses creados.');
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=seed.js.map