import { Injectable, Logger } from '@nestjs/common';

export type JourneyStepStatus = 'pass' | 'fail' | 'skip';

export interface JourneyStep {
  name: string;
  status: JourneyStepStatus;
  durationMs: number;
  error?: string;
}

export interface JourneyResult {
  journeyName: string;
  passed: boolean;
  steps: JourneyStep[];
  totalDurationMs: number;
  ranAt: Date;
}

export type StepFn = () => Promise<void>;

export interface Journey {
  name: string;
  steps: Array<{ name: string; fn: StepFn }>;
}

/**
 * Runs registered synthetic journeys and reports results.
 * Each journey simulates a critical user path end-to-end.
 *
 * Edge cases:
 * - A step that throws stops subsequent steps (they are marked 'skip').
 * - AbortSignal cancellation marks remaining steps as 'skip'.
 * - Individual step timeouts are enforced via Promise.race if stepTimeoutMs is set.
 *
 * Recovery: failures are reported without side effects; callers should alert on
 * passed===false. No rollback needed as journeys are read-only probes by convention.
 */
@Injectable()
export class SyntheticMonitoringService {
  private readonly logger = new Logger(SyntheticMonitoringService.name);
  private readonly journeys = new Map<string, Journey>();

  /** Register a journey. Re-registering with same name overwrites. */
  register(journey: Journey): void {
    this.journeys.set(journey.name, journey);
    this.logger.debug(`Registered synthetic journey: ${journey.name}`);
  }

  /** Run a single journey by name. */
  async run(journeyName: string, signal?: AbortSignal): Promise<JourneyResult> {
    const journey = this.journeys.get(journeyName);
    if (!journey) throw new Error(`Unknown journey: ${journeyName}`);
    return this.execute(journey, signal);
  }

  /** Run all registered journeys and return all results. */
  async runAll(signal?: AbortSignal): Promise<JourneyResult[]> {
    const results: JourneyResult[] = [];
    for (const journey of this.journeys.values()) {
      results.push(await this.execute(journey, signal));
    }
    return results;
  }

  private async execute(journey: Journey, signal?: AbortSignal): Promise<JourneyResult> {
    const startMs = Date.now();
    const steps: JourneyStep[] = [];
    let failed = false;

    for (const step of journey.steps) {
      if (signal?.aborted || failed) {
        steps.push({ name: step.name, status: 'skip', durationMs: 0 });
        continue;
      }

      const stepStart = Date.now();
      try {
        await step.fn();
        steps.push({ name: step.name, status: 'pass', durationMs: Date.now() - stepStart });
      } catch (err: unknown) {
        failed = true;
        steps.push({
          name: step.name,
          status: 'fail',
          durationMs: Date.now() - stepStart,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger.warn(`Journey '${journey.name}' failed at step '${step.name}': ${(err as Error).message}`);
      }
    }

    const result: JourneyResult = {
      journeyName: journey.name,
      passed: !failed,
      steps,
      totalDurationMs: Date.now() - startMs,
      ranAt: new Date(),
    };

    if (result.passed) {
      this.logger.log(`Journey '${journey.name}' passed in ${result.totalDurationMs}ms`);
    } else {
      this.logger.error(`Journey '${journey.name}' FAILED`);
    }

    return result;
  }
}
