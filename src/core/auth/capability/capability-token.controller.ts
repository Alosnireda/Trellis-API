import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { AllowedStrategies } from "../decorators/allowed-strategies.decorator";
import { CapabilityTokenService } from "./capability-token.service";
import {
  CAPABILITY_ACTION_POLICIES,
  CapabilityAction,
  MAX_CAPABILITY_TOKEN_LENGTH,
  MAX_CAPABILITY_TTL_SECONDS,
  MIN_CAPABILITY_TTL_SECONDS,
} from "./capability-token.types";

export class MintCapabilityDto {
  @IsIn(Object.values(CapabilityAction))
  action: CapabilityAction;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  resourceId?: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_CAPABILITY_TTL_SECONDS)
  @Max(MAX_CAPABILITY_TTL_SECONDS)
  ttlSeconds?: number;

  /** Current TOTP code; required when the account has 2FA enabled. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{6,8}$/)
  stepUpCode?: string;
}

export class RevokeCapabilityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CAPABILITY_TOKEN_LENGTH)
  token: string;
}

/**
 * Capability tokens (#273): mint a short-lived, single-use token for one
 * sensitive action, or revoke one that is no longer needed.
 *
 * API keys are excluded on purpose: a leaked key must not be able to grant
 * itself sensitive capabilities.
 */
@ApiTags("Capability tokens")
@ApiBearerAuth("JWT-auth")
@Controller("auth/capabilities")
@AllowedStrategies("traditional", "oauth", "wallet")
export class CapabilityTokenController {
  constructor(private readonly capabilities: CapabilityTokenService) {}

  @Get("actions")
  @ApiOperation({ summary: "Actions that accept a capability token" })
  actions() {
    return Object.entries(CAPABILITY_ACTION_POLICIES).map(
      ([action, policy]) => ({ action, ...policy }),
    );
  }

  @Post()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Mint a single-use capability token" })
  mint(@Req() req: any, @Body() body: MintCapabilityDto) {
    return this.capabilities.mint({
      principal: { id: req.user?.id, authType: req.authType ?? req.user?.type },
      action: body.action,
      resourceId: body.resourceId,
      ttlSeconds: body.ttlSeconds,
      stepUpCode: body.stepUpCode,
    });
  }

  @Post("revoke")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke an unused capability token" })
  revoke(@Req() req: any, @Body() body: RevokeCapabilityDto) {
    return this.capabilities.revoke(body.token, {
      id: req.user?.id,
      authType: req.authType ?? req.user?.type,
    });
  }
}
