import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  IsArray,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RegisterFeatureDto {
  @ApiProperty({ description: "Unique feature flag key" })
  @IsString()
  key!: string;

  @ApiProperty({ description: "Human-readable description of the feature" })
  @IsString()
  description!: string;

  @ApiProperty({ description: "Master enable/disable switch" })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({
    description: "Percentage of users included in rollout (0 - 100)",
    minimum: 0,
    maximum: 100,
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  rolloutPercentage!: number;

  @ApiPropertyOptional({
    description: "List of explicit user IDs allowed to access feature",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowlistedUsers?: string[];

  @ApiPropertyOptional({
    description: "List of user roles allowed to access feature",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowlistedRoles?: string[];

  @ApiPropertyOptional({
    description: "Maximum consecutive errors before automated emergency disable",
    default: 5,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxErrorThreshold?: number;

  @ApiProperty({ description: "Mandatory justification for this configuration change" })
  @IsString()
  reason!: string;
}

export class UpdateFeatureRolloutDto {
  @ApiPropertyOptional({ description: "Master enable/disable switch" })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: "Updated rollout percentage (0 - 100)",
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  rolloutPercentage?: number;

  @ApiPropertyOptional({
    description: "Updated list of allowlisted user IDs",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowlistedUsers?: string[];

  @ApiPropertyOptional({
    description: "Updated list of allowlisted roles",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowlistedRoles?: string[];

  @ApiProperty({ description: "Mandatory justification for this configuration change" })
  @IsString()
  reason!: string;
}

export class EmergencyDisableFeatureDto {
  @ApiProperty({ description: "Reason for emergency kill-switch activation" })
  @IsString()
  reason!: string;
}

export class LiftEmergencyDisableDto {
  @ApiPropertyOptional({
    description: "Canary rollout percentage upon resume (0 - 100)",
    default: 5,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  canaryPercentage?: number;

  @ApiProperty({ description: "Justification for lifting emergency disablement" })
  @IsString()
  reason!: string;
}

