import { Module } from '@nestjs/common';
import { SyntheticMonitoringService } from './synthetic-monitoring.service';

@Module({
  providers: [SyntheticMonitoringService],
  exports: [SyntheticMonitoringService],
})
export class SyntheticMonitoringModule {}
