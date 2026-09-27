import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FleetModule } from './modules/fleet/fleet.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    FleetModule,
    RealtimeModule,
    // A medida que avancen: IncidentsModule, InspectionsModule, ResourcesModule, ReportingModule
  ],
})
export class AppModule {}
