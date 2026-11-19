import { Module, Global } from "@nestjs/common";
import { FeatureRolloutService } from "./feature-rollout.service";
import { FeatureRolloutGuard } from "./feature-rollout.guard";
import { FeatureRolloutController } from "./feature-rollout.controller";
import { AdminConfigAuditModule } from "../audit/admin-config/admin-config-audit.module";

@Global()
@Module({
  imports: [AdminConfigAuditModule],
  controllers: [FeatureRolloutController],
  providers: [FeatureRolloutService, FeatureRolloutGuard],
  exports: [FeatureRolloutService, FeatureRolloutGuard],
})
export class FeatureRolloutModule {}
