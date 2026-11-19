import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  validatePayloadLimits,
  validateQueryParamsCardinality,
  InputLimitOptions,
  DEFAULT_INPUT_LIMITS,
} from "../validation/input-limits.validator";
import { INPUT_LIMITS_METADATA_KEY } from "../decorators/input-limits.decorator";
import { Role } from "./roles.enum";

@Injectable()
export class InputLimitsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const targetClass = context.getClass();

    // Read route-level overrides
    const routeOptions =
      this.reflector.getAllAndOverride<InputLimitOptions>(
        INPUT_LIMITS_METADATA_KEY,
        [handler, targetClass],
      ) || {};

    const request = context.switchToHttp().getRequest();
    const userRoles: string[] = request.user?.roles || [];

    // Role-based capacity ceiling: Elevated limits for verified OPERATOR / ADMIN actors
    const isElevatedRole =
      userRoles.includes(Role.ADMIN) ||
      userRoles.includes(Role.OPERATOR) ||
      userRoles.includes("admin") ||
      userRoles.includes("operator");

    const effectiveLimits: InputLimitOptions = {
      ...DEFAULT_INPUT_LIMITS,
      ...routeOptions,
      ...(isElevatedRole
        ? {
            maxArrayLength: Math.max(
              routeOptions.maxArrayLength ?? 10000,
              DEFAULT_INPUT_LIMITS.maxArrayLength * 5,
            ),
            maxTotalKeys: Math.max(
              routeOptions.maxTotalKeys ?? 5000,
              DEFAULT_INPUT_LIMITS.maxTotalKeys * 5,
            ),
          }
        : {}),
    };

    // 1. Query parameter cardinality check
    if (request.query) {
      const queryViolation = validateQueryParamsCardinality(
        request.query,
        effectiveLimits.maxQueryParams,
      );
      if (queryViolation) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          code: queryViolation.code,
          message: queryViolation.message,
          remediation: `Limit total query parameters to at most ${effectiveLimits.maxQueryParams}.`,
        });
      }
    }

    // 2. Payload size & cardinality check
    if (request.body && typeof request.body === "object") {
      const result = validatePayloadLimits(request.body, effectiveLimits);
      if (!result.valid) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          code: result.violations[0].code,
          message: "Input size or cardinality limit exceeded",
          violations: result.violations,
          remediation:
            "Reduce array batch size, reduce object key cardinality, or split request into multiple pages.",
        });
      }
    }

    return true;
  }
}

