import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { FeatureRolloutService } from "./feature-rollout.service";
import {
  RegisterFeatureDto,
  UpdateFeatureRolloutDto,
  EmergencyDisableFeatureDto,
  LiftEmergencyDisableDto,
} from "./dto/feature-rollout.dto";
import { JwtAuthGuard } from "../../core/auth/jwt.guard";
import { Roles } from "../../common/guard/roles.decorator";
import { Role } from "../../common/guard/roles.enum";
import { RolesGuard } from "../../common/guard/roles.guard";
import { Idempotent } from "../../common/idempotency/idempotency.decorator";
import { AdminConfigActor } from "../audit/admin-config/admin-config-audit.service";

function extractActor(req: any): AdminConfigActor {
  const user = req?.user;
  return {
    id: user?.id ?? "unknown-admin",
    role: user?.role ?? (Array.isArray(user?.roles) ? user.roles[0] : "ADMIN"),
    ipAddress:
      req?.headers?.["x-forwarded-for"]?.toString().split(",")[0].trim() ??
      req?.socket?.remoteAddress ??
      null,
    userAgent: req?.headers?.["user-agent"] ?? null,
  };
}

@ApiTags("Feature Rollout Admin")
@ApiBearerAuth()
@Controller("admin/features")
@UseGuards(JwtAuthGuard, RolesGuard)
export class FeatureRolloutController {
  constructor(private readonly featureService: FeatureRolloutService) {}

  @Get()
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @ApiOperation({ summary: "List all registered feature flags and rollout states" })
  @ApiResponse({ status: 200, description: "List of features" })
  getAllFeatures() {
    return this.featureService.getAllFeatures();
  }

  @Get(":key")
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @ApiOperation({ summary: "Get single feature flag configuration" })
  @ApiParam({ name: "key", description: "Feature key" })
  @ApiResponse({ status: 200, description: "Feature definition" })
  getFeature(@Param("key") key: string) {
    return this.featureService.getFeature(key);
  }

  @Post()
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @Idempotent()
  @ApiOperation({
    summary: "Register new feature with fail-closed audit evidence (#425)",
  })
  @ApiResponse({ status: 201, description: "Feature registered and audited" })
  async registerFeature(@Body() dto: RegisterFeatureDto, @Req() req: any) {
    const actor = extractActor(req);
    return this.featureService.registerFeatureWithEvidence(
      {
        key: dto.key,
        description: dto.description,
        enabled: dto.enabled,
        rolloutPercentage: dto.rolloutPercentage,
        allowlistedUsers: dto.allowlistedUsers,
        allowlistedRoles: dto.allowlistedRoles,
        maxErrorThreshold: dto.maxErrorThreshold,
      },
      actor,
      dto.reason,
    );
  }

  @Patch(":key")
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @Idempotent()
  @ApiOperation({
    summary: "Update feature rollout with fail-closed audit evidence (#425)",
  })
  @ApiParam({ name: "key", description: "Feature key" })
  @ApiResponse({ status: 200, description: "Feature updated and audited" })
  async updateFeature(
    @Param("key") key: string,
    @Body() dto: UpdateFeatureRolloutDto,
    @Req() req: any,
  ) {
    const actor = extractActor(req);
    return this.featureService.updateFeatureWithEvidence(
      key,
      {
        enabled: dto.enabled,
        rolloutPercentage: dto.rolloutPercentage,
        allowlistedUsers: dto.allowlistedUsers,
        allowlistedRoles: dto.allowlistedRoles,
      },
      actor,
      dto.reason,
    );
  }

  @Post(":key/emergency-disable")
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @Idempotent()
  @ApiOperation({
    summary: "Emergency kill-switch with fail-closed audit evidence (#425)",
  })
  @ApiParam({ name: "key", description: "Feature key" })
  @ApiResponse({ status: 200, description: "Feature emergency disabled and audited" })
  async emergencyDisable(
    @Param("key") key: string,
    @Body() dto: EmergencyDisableFeatureDto,
    @Req() req: any,
  ) {
    const actor = extractActor(req);
    return this.featureService.emergencyDisableWithEvidence(
      key,
      dto.reason,
      actor,
    );
  }

  @Post(":key/lift-emergency-disable")
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @Idempotent()
  @ApiOperation({
    summary: "Lift emergency disable with canary rollout and audit evidence (#425)",
  })
  @ApiParam({ name: "key", description: "Feature key" })
  @ApiResponse({ status: 200, description: "Emergency disable lifted and audited" })
  async liftEmergencyDisable(
    @Param("key") key: string,
    @Body() dto: LiftEmergencyDisableDto,
    @Req() req: any,
  ) {
    const actor = extractActor(req);
    return this.featureService.liftEmergencyDisableWithEvidence(
      key,
      actor,
      dto.canaryPercentage ?? 5,
      dto.reason,
    );
  }
}

