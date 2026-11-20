import { Logger, Provider } from "@nestjs/common";
import { CACHE_REDIS_CLIENT } from "src/common/cache/cache.constants";
import {
  CAPABILITY_TOKEN_STORE,
  CapabilityRedisClient,
  InMemoryCapabilityTokenStore,
  RedisCapabilityTokenStore,
} from "./capability-token.store";
import {
  CAPABILITY_STEP_UP_VERIFIER,
  TotpCapabilityStepUpVerifier,
} from "./capability-step-up.verifier";
import { CapabilityTokenService } from "./capability-token.service";
import { CapabilityTokenInterceptor } from "./capability-token.interceptor";

/**
 * Picks the single-use store: the shared Redis client from the global cache
 * module when one is configured (`REDIS_URL`), otherwise process memory,
 * which is only correct for a single replica and is logged as such.
 */
export function createCapabilityTokenStore(
  redis: CapabilityRedisClient | null | undefined,
) {
  if (redis) return new RedisCapabilityTokenStore(redis);
  new Logger("CapabilityTokenStore").warn(
    "No Redis client available; capability token single-use state is per-process. " +
      "Configure REDIS_URL before running more than one replica.",
  );
  return new InMemoryCapabilityTokenStore();
}

/** Everything AuthModule needs to mint, verify and enforce capability tokens. */
export const CAPABILITY_TOKEN_PROVIDERS: Provider[] = [
  {
    provide: CAPABILITY_TOKEN_STORE,
    inject: [{ token: CACHE_REDIS_CLIENT, optional: true }],
    useFactory: createCapabilityTokenStore,
  },
  TotpCapabilityStepUpVerifier,
  {
    provide: CAPABILITY_STEP_UP_VERIFIER,
    useExisting: TotpCapabilityStepUpVerifier,
  },
  CapabilityTokenService,
  CapabilityTokenInterceptor,
];
