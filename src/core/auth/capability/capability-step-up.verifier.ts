import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TwoFactorAuth, TwoFactorStatus } from "../entities/auth.entity";
import { EnhancedAuthService } from "../enhanced-auth.service";

/**
 * Step-up proof required before a capability token is minted (#273).
 *
 * Accounts with verified TOTP must present a fresh code; a stolen access
 * token alone is then not enough to authorize a sensitive action. Accounts
 * without 2FA rely on the interactive session (API keys can never mint).
 */
export interface CapabilityStepUpVerifier {
  /** True when the account must present a step-up code to mint. */
  isRequired(userId: string): Promise<boolean>;
  /** True when `code` is a currently valid step-up code for the account. */
  verify(userId: string, code: string): Promise<boolean>;
}

export const CAPABILITY_STEP_UP_VERIFIER = "CAPABILITY_STEP_UP_VERIFIER";

@Injectable()
export class TotpCapabilityStepUpVerifier implements CapabilityStepUpVerifier {
  constructor(
    @InjectRepository(TwoFactorAuth)
    private readonly twoFactor: Repository<TwoFactorAuth>,
    private readonly enhancedAuth: EnhancedAuthService,
  ) {}

  async isRequired(userId: string): Promise<boolean> {
    const record = await this.twoFactor.findOne({
      where: { userId, isEnabled: true, status: TwoFactorStatus.VERIFIED },
    });
    return Boolean(record?.secret);
  }

  verify(userId: string, code: string): Promise<boolean> {
    return this.enhancedAuth.validateTotpToken(userId, code);
  }
}
