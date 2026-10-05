import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';
import { UpdateBusPositionUseCase } from '../../application/use-cases/update-bus-position.use-case';

/** Bogotá, para buses que todavía no tienen posición. */
const DEFAULT_POSITION: [number, number] = [4.65, -74.1];
/** ~±110 m de desplazamiento aleatorio por tick. */
const JITTER_DEGREES = 0.002;

/**
 * FEED SIMULADO de posiciones — hace las veces de la API de TransMilenio, que todavía
 * no está conectada.
 *
 * Es un adapter de ENTRADA (driving adapter): cada `FLEET_SIMULATION_INTERVAL_MS`
 * mueve un poco cada bus `IN_SERVICE` llamando a `UpdateBusPositionUseCase`, exactamente
 * como lo haría el feed real. Por eso, al conectar la API real:
 *   1. se crea un `TransmilenioFleetFeedAdapter` junto a este archivo que llame al
 *      MISMO caso de uso con las posiciones reales;
 *   2. se pone `FLEET_FEED_MODE=external` para apagar este simulador;
 *   3. dominio, casos de uso, Redis y WebSocket no cambian.
 *
 * Modos (`FLEET_FEED_MODE`): `simulated` (por defecto) | `external` (simulador apagado).
 */
@Injectable()
export class SimulatedFleetFeed implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SimulatedFleetFeed.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
    private readonly updateBusPosition: UpdateBusPositionUseCase,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const mode = this.config.get<string>('FLEET_FEED_MODE', 'simulated');
    if (mode !== 'simulated') {
      this.logger.log(`Feed simulado apagado (FLEET_FEED_MODE=${mode})`);
      return;
    }
    const intervalMs = this.config.get<number>('FLEET_SIMULATION_INTERVAL_MS', 3000);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.logger.log(`Feed simulado activo cada ${intervalMs}ms (reemplazable por la API real)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const activeBuses = await this.busRepository.findAll({ status: BusStatus.IN_SERVICE });

    for (const bus of activeBuses) {
      const [lat, lng] = this.nextPosition(bus.latitude, bus.longitude);
      try {
        await this.updateBusPosition.execute(bus.id, lat, lng);
      } catch (err) {
        // Normal si el viaje terminó justo entre la lectura y la escritura.
        this.logger.warn(`No se pudo actualizar ${bus.plate}: ${err}`);
      }
    }
  }

  /** "Paseo aleatorio" alrededor de la última posición conocida. */
  private nextPosition(lat: number | null, lng: number | null): [number, number] {
    const [baseLat, baseLng] = [lat ?? DEFAULT_POSITION[0], lng ?? DEFAULT_POSITION[1]];
    const jitter = () => (Math.random() - 0.5) * JITTER_DEGREES;
    return [baseLat + jitter(), baseLng + jitter()];
  }
}
