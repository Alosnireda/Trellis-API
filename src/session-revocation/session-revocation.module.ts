import { Module } from '@nestjs/common';
import { SessionRevocationService } from './session-revocation.service';

@Module({
  providers: [SessionRevocationService],
  exports: [SessionRevocationService],
})
export class SessionRevocationModule {}
