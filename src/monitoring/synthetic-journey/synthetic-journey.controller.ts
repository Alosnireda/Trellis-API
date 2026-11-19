import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpStatus,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags, ApiQuery } from "@nestjs/swagger";
import { timingSafeEqual } from "crypto";
import { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { SkipKyc } from "../../common/decorators/skip-kyc.decorator";
import { SyntheticJourneyMonitorService } from "./synthetic-journey.service";
import { SyntheticJourneyReport } from "./synthetic-journey.types";

/**
 * Controller exposing Synthetic Journey Monitoring endpoints.
 *
 * GET  /monitoring/synthetic/status   — Fetches the latest synthetic journey report
 * POST /monitoring/synthetic/run      — Triggers an on-demand synthetic run immediately
 */
@ApiTags("Monitoring")
@Controller("monitoring/synthetic")
@Public()
@SkipKyc()
export class SyntheticJourneyController {
  private readonly syntheticMonitorService: SyntheticJourneyMonitorService;

  constructor(syntheticMonitorService: SyntheticJourneyMonitorService) {
    this.syntheticMonitorService = syntheticMonitorService;
  }

  @Get("status")
  @ApiOperation({
    summary: "Get latest synthetic journey report",
    description:
      "Returns the most recent end-to-end synthetic happy path journey report including latency, status, and dependency blame attribution.",
  })
  @ApiResponse({ status: 200, description: "Synthetic journey report" })
  async getStatus(): Promise<SyntheticJourneyReport> {
    return this.syntheticMonitorService.getLatestReport();
  }

  @Post("run")
  @ApiOperation({
    summary: "Trigger synthetic journey run on-demand",
    description:
      "Runs the full synthetic end-to-end happy path flow and returns latency metrics and dependency blame diagnostics.",
  })
  @ApiQuery({ name: "simulateFailureStep", required: false, type: String })
  @ApiQuery({ name: "maxRetries", required: false, type: Number })
  @ApiResponse({ status: 200, description: "Executed synthetic journey report" })
  async runJourney(
    @Res({ passthrough: true }) res: Response,
    @Query("simulateFailureStep") simulateFailureStep?: string,
    @Query("maxRetries") maxRetries?: string,
    @Headers("x-synthetic-admin-token") adminToken?: string,
  ): Promise<SyntheticJourneyReport> {
    if (simulateFailureStep) {
      this.assertFaultInjectionAuthorized(adminToken);
    }

    const parsedRetries = maxRetries !== undefined ? Number.parseInt(maxRetries, 10) : 0;
    const boundedRetries = Number.isFinite(parsedRetries)
      ? Math.min(Math.max(parsedRetries, 0), 3)
      : 0;

    const report = await this.syntheticMonitorService.runJourney({
      trigger: "MANUAL",
      simulateFailureStep,
      maxStepRetries: boundedRetries,
    });

    if (report.status === "FAILED") {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    } else if (report.status === "DEGRADED") {
      res.status(HttpStatus.OK);
    }

    return report;
  }

  private assertFaultInjectionAuthorized(providedToken?: string): void {
    const expectedToken = process.env.SYNTHETIC_FAULT_INJECTION_TOKEN;
    if (!expectedToken) {
      if (process.env.NODE_ENV === "production") {
        throw new ForbiddenException(
          "Fault injection is disabled in production unless SYNTHETIC_FAULT_INJECTION_TOKEN is configured.",
        );
      }
      return;
    }

    if (!providedToken) {
      throw new ForbiddenException("Missing x-synthetic-admin-token for fault injection.");
    }

    const expectedBuf = Buffer.from(expectedToken, "utf8");
    const providedBuf = Buffer.from(providedToken, "utf8");
    if (
      expectedBuf.length !== providedBuf.length ||
      !timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new ForbiddenException("Invalid x-synthetic-admin-token for fault injection.");
    }
  }
}
