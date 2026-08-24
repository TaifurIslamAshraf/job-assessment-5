import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { TransientPayrollError } from "./payroll.errors";

export interface ProviderResult {
  providerReference: string;
  acknowledgedAt: string;
  latencyMs: number;
}

/**
 * Stand-in for the external payroll system. It is slow and unreliable on
 * purpose so retry, dead-lettering and recovery can be demonstrated.
 *
 * `PAYROLL_FAILURE_RATE=0` makes it deterministic, which is what the
 * integration tests use.
 */
@Injectable()
export class PayrollProviderService {
  private readonly logger = new Logger(PayrollProviderService.name);

  constructor(private readonly config: ConfigService) {}

  async submit(
    eventId: string,
    idempotencyKey: string,
  ): Promise<ProviderResult> {
    const latencyMs =
      this.config.get<number>("PAYROLL_LATENCY_MS") ??
      200 + Math.floor(Math.random() * 800);
    await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const failureRate = this.config.get<number>("PAYROLL_FAILURE_RATE") ?? 0;
    if (Math.random() < failureRate) {
      this.logger.warn(
        `Simulated provider outage for event ${eventId} after ${latencyMs}ms`,
      );
      throw new TransientPayrollError(
        "Payroll provider returned 503 Service Unavailable",
      );
    }

    return {
      // Derived from the idempotency key so a replayed call yields the same
      // reference — mirroring how a real provider would deduplicate.
      providerReference: `PP-${idempotencyKey.slice(0, 12).toUpperCase()}`,
      acknowledgedAt: new Date().toISOString(),
      latencyMs,
    };
  }
}
