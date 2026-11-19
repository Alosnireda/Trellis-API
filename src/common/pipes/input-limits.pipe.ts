import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from "@nestjs/common";
import {
  validatePayloadLimits,
  InputLimitOptions,
} from "../validation/input-limits.validator";

/**
 * Global or route-scoped PipeTransform enforcing strict payload size,
 * JSON nesting depth, and property cardinality limits.
 *
 * Runs before class-transformer to prevent memory exhaustion and Hash-DoS.
 */
@Injectable()
export class InputLimitsPipe implements PipeTransform {
  constructor(private readonly defaultOptions?: InputLimitOptions) {}

  transform(value: unknown, metadata?: ArgumentMetadata): unknown {
    // Only inspect body and custom payloads; skip param/query (handled by guard)
    if (metadata?.type && metadata.type !== "body" && metadata.type !== "custom") {
      return value;
    }

    if (value === null || value === undefined) {
      return value;
    }

    const result = validatePayloadLimits(value, this.defaultOptions);

    if (!result.valid) {
      const messages = result.violations.map((v) => `${v.fieldPath}: ${v.message}`);
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Input size or cardinality limit exceeded",
        code: result.violations[0].code,
        violations: result.violations,
        remediation:
          "Reduce batch cardinality, prune nested JSON depth, or chunk your request into smaller payloads.",
      });
    }

    return value;
  }
}

