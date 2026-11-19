import { Module } from '@nestjs/common';
import { TelemetryRedactionService } from './telemetry-redaction.service';

@Module({
  providers: [TelemetryRedactionService],
  exports: [TelemetryRedactionService],
})
export class TelemetryModule {}
