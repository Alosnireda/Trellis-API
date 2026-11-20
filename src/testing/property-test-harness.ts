/**
 * Lightweight, zero-dependency Property-Based Testing Harness.
 *
 * Uses the Mulberry32 deterministic 32-bit PRNG for 100% reproducible test runs.
 * Supports generators for integers, floats, booleans, strings, arrays, records,
 * financial amounts, and portfolio weights, with automatic shrinking on failure.
 */

export type PRNG = () => number;

/**
 * Creates a deterministic Mulberry32 PRNG from an integer seed.
 */
export function mulberry32(seed: number): PRNG {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Generator<T> {
  generate: (prng: PRNG) => T;
  shrink?: (value: T) => T[];
}

export interface PropertyTestOptions {
  iterations?: number;
  seed?: number;
  shrinkAttempts?: number;
}

export interface PropertyTestReport<T> {
  passed: boolean;
  iterations: number;
  seed: number;
  failure?: {
    originalValue: T;
    shrunkValue: T;
    error: string;
    iteration: number;
  };
}

export const Gen = {
  integer(min: number, max: number): Generator<number> {
    return {
      generate: (prng: PRNG) => Math.floor(prng() * (max - min + 1)) + min,
      shrink: (val: number) => {
        if (val === min) return [];
        const mid = Math.floor((min + val) / 2);
        return mid !== val ? [min, mid] : [min];
      },
    };
  },

  float(min: number, max: number, precision: number = 4): Generator<number> {
    const factor = Math.pow(10, precision);
    return {
      generate: (prng: PRNG) => {
        const raw = prng() * (max - min) + min;
        return Math.round(raw * factor) / factor;
      },
      shrink: (val: number) => (val > min ? [min, Number(((min + val) / 2).toFixed(precision))] : []),
    };
  },

  boolean(): Generator<boolean> {
    return {
      generate: (prng: PRNG) => prng() >= 0.5,
      shrink: (val: boolean) => (val ? [false] : []),
    };
  },

  oneOf<T>(options: T[]): Generator<T> {
    if (options.length === 0) throw new Error("Gen.oneOf requires at least one option");
    return {
      generate: (prng: PRNG) => options[Math.floor(prng() * options.length)],
      shrink: (val: T) => (val !== options[0] ? [options[0]] : []),
    };
  },

  string(maxLen: number = 16, alphabet: string = "abcdefghijklmnopqrstuvwxyz0123456789"): Generator<string> {
    return {
      generate: (prng: PRNG) => {
        const len = Math.floor(prng() * maxLen) + 1;
        let str = "";
        for (let i = 0; i < len; i++) {
          str += alphabet[Math.floor(prng() * alphabet.length)];
        }
        return str;
      },
      shrink: (val: string) => (val.length > 1 ? [val.slice(0, Math.floor(val.length / 2))] : []),
    };
  },

  array<T>(itemGen: Generator<T>, minLen: number = 0, maxLen: number = 10): Generator<T[]> {
    return {
      generate: (prng: PRNG) => {
        const len = Math.floor(prng() * (maxLen - minLen + 1)) + minLen;
        const arr: T[] = [];
        for (let i = 0; i < len; i++) {
          arr.push(itemGen.generate(prng));
        }
        return arr;
      },
      shrink: (arr: T[]) => (arr.length > minLen ? [arr.slice(0, Math.floor(arr.length / 2))] : []),
    };
  },

  record<T extends Record<string, any>>(schema: { [K in keyof T]: Generator<T[K]> }): Generator<T> {
    return {
      generate: (prng: PRNG) => {
        const res = {} as T;
        for (const key of Object.keys(schema) as Array<keyof T>) {
          res[key] = schema[key].generate(prng);
        }
        return res;
      },
    };
  },

  /**
   * Generates N positive asset weights that sum to 100 (percentage allocation).
   */
  portfolioWeights(numAssets: number = 3): Generator<number[]> {
    return {
      generate: (prng: PRNG) => {
        const raw = Array.from({ length: numAssets }, () => prng() + 0.01);
        const sum = raw.reduce((a, b) => a + b, 0);
        const normalized = raw.map((w) => Number(((w / sum) * 100).toFixed(2)));
        // Adjust any rounding drift on the last element so sum is exactly 100
        const roundedSum = normalized.reduce((a, b) => a + b, 0);
        const drift = Number((100 - roundedSum).toFixed(2));
        normalized[normalized.length - 1] = Number((normalized[normalized.length - 1] + drift).toFixed(2));
        return normalized;
      },
    };
  },

  /**
   * Generates safe 7-decimal Stroop amounts (1 XLM = 10,000,000 stroops).
   */
  stroopAmount(maxInXlm: number = 10_000): Generator<bigint> {
    return {
      generate: (prng: PRNG) => {
        const stroopsPerXlm = 10_000_000n;
        const xlmInt = BigInt(Math.floor(prng() * maxInXlm) + 1);
        const subXlm = BigInt(Math.floor(prng() * 10_000_000));
        return xlmInt * stroopsPerXlm + subXlm;
      },
      shrink: (val: bigint) => (val > 0n ? [val / 2n, 0n] : []),
    };
  },
};

/**
 * Runs a property test assertion across randomized inputs and reports reproducibility seeds.
 */
export async function assertProperty<T>(
  name: string,
  generator: Generator<T>,
  predicate: (value: T) => boolean | void | Promise<boolean | void>,
  options: PropertyTestOptions = {},
): Promise<PropertyTestReport<T>> {
  const iterations = options.iterations ?? 100;
  const seed = options.seed ?? Math.floor(Math.random() * 1_000_000);
  const prng = mulberry32(seed);

  for (let i = 1; i <= iterations; i++) {
    const value = generator.generate(prng);
    try {
      const result = await predicate(value);
      if (result === false) {
        throw new Error(`Predicate returned false for value: ${JSON.stringify(value)}`);
      }
    } catch (err) {
      let shrunkValue = value;
      if (generator.shrink) {
        const candidates = generator.shrink(value);
        for (const candidate of candidates) {
          try {
            const shrinkResult = await predicate(candidate);
            if (shrinkResult === false) {
              shrunkValue = candidate;
              break;
            }
          } catch {
            shrunkValue = candidate;
            break;
          }
        }
      }

      const errorMessage = (err as Error).message;
      return {
        passed: false,
        iterations: i,
        seed,
        failure: {
          originalValue: value,
          shrunkValue,
          error: errorMessage,
          iteration: i,
        },
      };
    }
  }

  return {
    passed: true,
    iterations,
    seed,
  };
}
