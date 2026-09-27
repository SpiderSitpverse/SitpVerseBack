import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';
import { UpdateBusPositionUseCase } from '../../application/use-cases/update-bus-position.use-case';

/**
 * Adapter (driving adapter) que hace las veces de "API externa de buses".
 *
 * Hoy: simula pequeños desplazamientos de cada bus IN_SERVICE cada X ms.
 * El día que tengan acceso real a la API de TransMilenio, este archivo se
 * reemplaza (o se agrega un HttpFleetFeedAdapter al lado) sin tocar dominio
 * ni casos de uso — ese es el punto del Adapter Hexagonal.
 */
@Injectable()
export class FleetSimulatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetSimulatorService.name);
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
    private readonly updateBusPosition: UpdateBusPositionUseCase,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = this.config.get<number>(
      'FLEET_SIMULATION_INTERVAL_MS',
      3000,
    );
    this.intervalHandle = setInterval(() => this.tick(), intervalMs);
    this.logger.log(
      `Simulador de flota activo cada ${intervalMs}ms (reemplazable por API real)`,
    );
  }

  onModuleDestroy() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private async tick() {
    const activeBuses = await this.busRepository.findAll({
      status: BusStatus.IN_SERVICE,
    });

    for (const bus of activeBuses) {
      const [lat, lng] = this.nextPosition(bus.latitude, bus.longitude);
      try {
        await this.updateBusPosition.execute(bus.id, lat, lng);
      } catch (err) {
        this.logger.warn(`No se pudo actualizar ${bus.plate}: ${err}`);
      }
    }
  }

  /** Pequeño "paseo aleatorio" alrededor de la última posición conocida. */
  private nextPosition(lat: number | null, lng: number | null): [number, number] {
    const baseLat = lat ?? 4.65; // Bogotá aprox., por si el bus no tiene posición aún
    const baseLng = lng ?? -74.1;
    const jitter = () => (Math.random() - 0.5) * 0.002;
    return [baseLat + jitter(), baseLng + jitter()];
  }
}
