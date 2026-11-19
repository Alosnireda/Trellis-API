import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiHeader } from "@nestjs/swagger";
import { defer, from, Observable, throwError } from "rxjs";
import { catchError, concatMap, map, mergeMap } from "rxjs/operators";
import { CapabilityTokenService } from "./capability-token.service";
import {
  CAPABILITY_TOKEN_HEADER,
  CapabilityAction,
  isCapabilityTokenEnforced,
} from "./capability-token.types";

export const CAPABILITY_REQUIREMENT_KEY = "capability-token:requirement";

export interface CapabilityRouteRequirement {
  action: CapabilityAction;
  /** Route parameter holding the resource id for resource-bound actions. */
  resourceParam?: string;
}

/**
 * Protects a route with an expiring, single-use capability token (#273).
 *
 * Runs after authentication (it is an interceptor, so the global
 * `StrategyAuthGuard` has already set `req.user`).
 *
 * - `CAPABILITY_TOKENS_ENFORCED` on: a missing token is rejected with 428.
 * - flag off (default): requests without a token behave exactly as before;
 *   a token that *is* sent is still fully verified and consumed, so clients
 *   can adopt the flow before it becomes mandatory.
 *
 * The token is consumed only when the handler succeeds. If the handler throws,
 * the reservation is released and the same token can be retried until it
 * expires.
 */
export function RequireCapabilityToken(
  action: CapabilityAction,
  options: { resourceParam?: string } = {},
) {
  return applyDecorators(
    SetMetadata(CAPABILITY_REQUIREMENT_KEY, {
      action,
      resourceParam: options.resourceParam,
    } satisfies CapabilityRouteRequirement),
    ApiHeader({
      name: "X-Capability-Token",
      required: false,
      description: `Single-use capability token for \`${action}\`, minted with POST /auth/capabilities. Required when CAPABILITY_TOKENS_ENFORCED is on.`,
    }),
    UseInterceptors(CapabilityTokenInterceptor),
  );
}

@Injectable()
export class CapabilityTokenInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly capabilities: CapabilityTokenService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const requirement = this.reflector.get<CapabilityRouteRequirement>(
      CAPABILITY_REQUIREMENT_KEY,
      context.getHandler(),
    );
    if (!requirement || context.getType() !== "http") return next.handle();

    const request = context.switchToHttp().getRequest();
    const token = readHeader(request?.headers, CAPABILITY_TOKEN_HEADER);
    if (token === null && !isCapabilityTokenEnforced()) return next.handle();

    const resourceId = requirement.resourceParam
      ? request?.params?.[requirement.resourceParam]
      : null;

    return defer(() =>
      this.capabilities.claim(token, {
        subject: request?.user?.id,
        authType: request?.authType ?? request?.user?.type,
        action: requirement.action,
        resourceId,
      }),
    ).pipe(
      mergeMap((claim) =>
        next.handle().pipe(
          concatMap((value) =>
            from(this.capabilities.commit(claim)).pipe(map(() => value)),
          ),
          catchError((error) =>
            from(this.capabilities.release(claim)).pipe(
              mergeMap(() => throwError(() => error)),
            ),
          ),
        ),
      ),
    );
  }
}

function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | null {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
