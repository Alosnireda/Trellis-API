/**
 * Strict Input Size and Cardinality Limits Validator (Issue #437).
 *
 * Implements linear-time O(N) traversal and bounded-space O(D) depth protection
 * to guard against Hash-DoS, deeply nested JSON recursion bombs, and memory exhaustion.
 */

export interface InputLimitOptions {
  /** Maximum nesting depth for JSON objects/arrays (default: 10) */
  maxDepth?: number;
  /** Maximum number of keys allowed on any single JSON object (default: 100) */
  maxObjectKeys?: number;
  /** Maximum total keys permitted across the entire payload tree (default: 500) */
  maxTotalKeys?: number;
  /** Maximum number of items in any JSON array (default: 1000) */
  maxArrayLength?: number;
  /** Maximum byte length / character count for any individual string value (default: 65,536 = 64KB) */
  maxStringLength?: number;
  /** Maximum number of query parameters permitted on a request (default: 50) */
  maxQueryParams?: number;
}

export const DEFAULT_INPUT_LIMITS: Required<InputLimitOptions> = {
  maxDepth: 10,
  maxObjectKeys: 100,
  maxTotalKeys: 500,
  maxArrayLength: 1000,
  maxStringLength: 65536,
  maxQueryParams: 50,
};

export type LimitViolationCode =
  | "INPUT_DEPTH_EXCEEDED"
  | "INPUT_CARDINALITY_EXCEEDED"
  | "INPUT_SIZE_EXCEEDED"
  | "QUERY_CARDINALITY_EXCEEDED";

export interface LimitViolation {
  code: LimitViolationCode;
  fieldPath: string;
  message: string;
  limit: number;
  actual: number;
}

export interface InputLimitsValidationResult {
  valid: boolean;
  violations: LimitViolation[];
  metrics: {
    maxObservedDepth: number;
    totalKeysCount: number;
    maxObservedArrayLength: number;
    maxObservedStringLength: number;
  };
}

/**
 * Validates a payload against strict size and cardinality limits.
 *
 * Time Complexity: O(N) where N is the total count of values/nodes in the payload.
 * Space Complexity: O(D) where D is the maximum allowed depth (bounded stack).
 */
export function validatePayloadLimits(
  payload: unknown,
  customOptions?: InputLimitOptions,
): InputLimitsValidationResult {
  const options: Required<InputLimitOptions> = {
    ...DEFAULT_INPUT_LIMITS,
    ...customOptions,
  };

  const violations: LimitViolation[] = [];
  let maxObservedDepth = 0;
  let totalKeysCount = 0;
  let maxObservedArrayLength = 0;
  let maxObservedStringLength = 0;

  // Short circuit primitive payloads
  if (payload === null || payload === undefined || typeof payload !== "object") {
    if (typeof payload === "string") {
      maxObservedStringLength = payload.length;
      if (payload.length > options.maxStringLength) {
        violations.push({
          code: "INPUT_SIZE_EXCEEDED",
          fieldPath: "$",
          message: `String length ${payload.length} exceeds limit of ${options.maxStringLength}`,
          limit: options.maxStringLength,
          actual: payload.length,
        });
      }
    }
    return {
      valid: violations.length === 0,
      violations,
      metrics: {
        maxObservedDepth,
        totalKeysCount,
        maxObservedArrayLength,
        maxObservedStringLength,
      },
    };
  }

  // Iterative DFS stack to bound memory and avoid recursive call-stack overflow
  interface StackItem {
    node: any;
    path: string;
    depth: number;
  }

  const stack: StackItem[] = [{ node: payload, path: "$", depth: 1 }];

  while (stack.length > 0) {
    const { node, path, depth } = stack.pop()!;

    if (depth > maxObservedDepth) {
      maxObservedDepth = depth;
    }

    if (depth > options.maxDepth) {
      violations.push({
        code: "INPUT_DEPTH_EXCEEDED",
        fieldPath: path,
        message: `Nesting depth ${depth} exceeds maximum allowed depth of ${options.maxDepth}`,
        limit: options.maxDepth,
        actual: depth,
      });
      // Do not traverse deeper past limit
      continue;
    }

    if (Array.isArray(node)) {
      if (node.length > maxObservedArrayLength) {
        maxObservedArrayLength = node.length;
      }
      if (node.length > options.maxArrayLength) {
        violations.push({
          code: "INPUT_CARDINALITY_EXCEEDED",
          fieldPath: path,
          message: `Array length ${node.length} exceeds maximum cardinality limit of ${options.maxArrayLength}`,
          limit: options.maxArrayLength,
          actual: node.length,
        });
      }

      // Push array children
      for (let i = node.length - 1; i >= 0; i--) {
        const item = node[i];
        if (item !== null && typeof item === "object") {
          stack.push({
            node: item,
            path: `${path}[${i}]`,
            depth: depth + 1,
          });
        } else if (typeof item === "string") {
          if (item.length > maxObservedStringLength) {
            maxObservedStringLength = item.length;
          }
          if (item.length > options.maxStringLength) {
            violations.push({
              code: "INPUT_SIZE_EXCEEDED",
              fieldPath: `${path}[${i}]`,
              message: `String length ${item.length} exceeds limit of ${options.maxStringLength}`,
              limit: options.maxStringLength,
              actual: item.length,
            });
          }
        }
      }
    } else if (node !== null && typeof node === "object") {
      const keys = Object.keys(node);
      const keysCount = keys.length;

      if (keysCount > options.maxObjectKeys) {
        violations.push({
          code: "INPUT_CARDINALITY_EXCEEDED",
          fieldPath: path,
          message: `Object property count ${keysCount} exceeds maximum key cardinality of ${options.maxObjectKeys}`,
          limit: options.maxObjectKeys,
          actual: keysCount,
        });
      }

      totalKeysCount += keysCount;
      if (totalKeysCount > options.maxTotalKeys) {
        violations.push({
          code: "INPUT_CARDINALITY_EXCEEDED",
          fieldPath: "$",
          message: `Total payload keys count ${totalKeysCount} exceeds cumulative limit of ${options.maxTotalKeys}`,
          limit: options.maxTotalKeys,
          actual: totalKeysCount,
        });
      }

      // Push object properties
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        const value = node[key];
        const propPath = `${path}.${key}`;

        if (value !== null && typeof value === "object") {
          stack.push({
            node: value,
            path: propPath,
            depth: depth + 1,
          });
        } else if (typeof value === "string") {
          if (value.length > maxObservedStringLength) {
            maxObservedStringLength = value.length;
          }
          if (value.length > options.maxStringLength) {
            violations.push({
              code: "INPUT_SIZE_EXCEEDED",
              fieldPath: propPath,
              message: `String length ${value.length} exceeds limit of ${options.maxStringLength}`,
              limit: options.maxStringLength,
              actual: value.length,
            });
          }
        }
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    metrics: {
      maxObservedDepth,
      totalKeysCount,
      maxObservedArrayLength,
      maxObservedStringLength,
    },
  };
}

/**
 * Validates request query parameters cardinality.
 */
export function validateQueryParamsCardinality(
  queryParams: Record<string, any>,
  maxQueryParams: number = DEFAULT_INPUT_LIMITS.maxQueryParams,
): LimitViolation | null {
  if (!queryParams || typeof queryParams !== "object") {
    return null;
  }
  const count = Object.keys(queryParams).length;
  if (count > maxQueryParams) {
    return {
      code: "QUERY_CARDINALITY_EXCEEDED",
      fieldPath: "$query",
      message: `Query parameter count ${count} exceeds cardinality limit of ${maxQueryParams}`,
      limit: maxQueryParams,
      actual: count,
    };
  }
  return null;
}

