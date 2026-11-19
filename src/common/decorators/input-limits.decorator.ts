import { SetMetadata, CustomDecorator } from "@nestjs/common";
import { InputLimitOptions } from "../validation/input-limits.validator";

export const INPUT_LIMITS_METADATA_KEY = "trellis:input_limits";

/**
 * Decorator to override default payload size and cardinality limits for a specific route handler.
 * Useful for bulk ingestion endpoints or high-throughput batch APIs.
 */
export const InputLimits = (options: InputLimitOptions): CustomDecorator<string> =>
  SetMetadata(INPUT_LIMITS_METADATA_KEY, options);

