import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { DelayedError, Job } from "bullmq";
import { hostname } from "node:os";

import { Prisma } from "../generated/prisma/client";
import { PayrollEventStatus } from "../generated/prisma/enums";
import { PayrollProviderService } from "../payroll/payroll-provider.service";
import {
  isPermanent,
  PermanentPayrollError,
  RETRIES_EXHAUSTED,
} from "../payroll/payroll.errors";
import { PrismaService } from "../prisma/prisma.service";
import { PAYROLL_QUEUE, PayrollJobData } from "../queue/queue.constants";
import { HandlerRegistry } from "./handlers/handler.registry";

/** How long a later event waits when an earlier one for the same employee is open. */
const ORDERING_BACKOFF_MS = 500;

const WORKER_ID = `${hostname()}#${process.pid}`;

@Processor(PAYROLL_QUEUE, {
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
})
export class PayrollProcessor extends WorkerHost {
  private readonly logger = new Logger(PayrollProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly handlers: HandlerRegistry,
    private readonly provider: PayrollProviderService,
  ) {
    super();
  }

  async process(job: Job<PayrollJobData>, token?: string): Promise<unknown> {
    const { eventId } = job.data;

    const event = await this.prisma.payrollEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      // The row is the source of truth; a job without one is not retryable.
      throw new PermanentPayrollError(
        `Event ${eventId} no longer exists`,
        "EVENT_NOT_FOUND",
      );
    }

    // ── Requirement 8: crash-after-commit ────────────────────────────────
    // The profile write and the SUCCEEDED flip happen in one transaction, so a
    // finished event means the change is already applied. Redelivery no-ops.
    if (
      event.status === PayrollEventStatus.SUCCEEDED ||
      event.status === PayrollEventStatus.FAILED
    ) {
      this.logger.log(
        `Event ${eventId} already ${event.status}; skipping redelivered job`,
      );
      return { skipped: true, status: event.status };
    }

    // ── Requirement 9: per-employee ordering ─────────────────────────────
    // Accept order is `sequence`. If any earlier event for this employee is
    // still open, put this job back with a short delay. Using moveToDelayed
    // rather than throwing means waiting does not burn a retry attempt.
    const blocker = await this.prisma.payrollEvent.findFirst({
      where: {
        employeeId: event.employeeId,
        sequence: { lt: event.sequence },
        status: {
          in: [
            PayrollEventStatus.ACCEPTED,
            PayrollEventStatus.PROCESSING,
            PayrollEventStatus.PENDING_RETRY,
          ],
        },
      },
      orderBy: { sequence: "asc" },
    });

    if (blocker) {
      this.logger.debug(
        `Event ${eventId} (seq ${event.sequence}) waiting on ${blocker.id} (seq ${blocker.sequence})`,
      );
      await job.moveToDelayed(Date.now() + ORDERING_BACKOFF_MS, token);
      throw new DelayedError();
    }

    // ── Requirement 6: multiple workers ──────────────────────────────────
    // Compare-and-set on status. Exactly one worker can move a given event out
    // of ACCEPTED/PENDING_RETRY, so two workers cannot both process it.
    const claim = await this.prisma.payrollEvent.updateMany({
      where: {
        id: eventId,
        status: {
          in: [PayrollEventStatus.ACCEPTED, PayrollEventStatus.PENDING_RETRY],
        },
      },
      data: {
        status: PayrollEventStatus.PROCESSING,
        processingStartedAt: event.processingStartedAt ?? new Date(),
        attempts: { increment: 1 },
        lockedBy: WORKER_ID,
        lockedAt: new Date(),
      },
    });

    if (claim.count === 0) {
      this.logger.warn(
        `Event ${eventId} claimed by another worker; yielding this job`,
      );
      return { skipped: true, reason: "claimed-elsewhere" };
    }

    const attempt = event.attempts + 1;
    await this.recordTransition(
      eventId,
      event.status,
      PayrollEventStatus.PROCESSING,
      attempt,
      `Processing started by ${WORKER_ID}`,
    );
    this.logger.log(
      `Processing started event=${eventId} attempt=${attempt} worker=${WORKER_ID}`,
    );

    try {
      const handler = this.handlers.get(event.type);
      const ctx = {
        eventId: event.id,
        employeeId: event.employeeId,
        sequence: event.sequence,
        effectiveDate: event.effectiveDate,
        payload: event.payload as Record<string, unknown>,
      };

      // Business validation first — a permanent rejection should not cost a
      // round trip to the provider.
      await handler.validate(ctx);

      // Slow, unreliable call. Deliberately outside any transaction so a long
      // provider call never holds a Postgres lock.
      const result = await this.provider.submit(event.id, event.idempotencyKey);

      const mutation = handler.apply(ctx);
      let superseded: number | null = null;

      await this.prisma.$transaction(async (tx) => {
        // Requirement 8 again: the guard makes the write itself idempotent even
        // if this transaction somehow ran twice.
        const profile = await tx.employeePayrollProfile.findUnique({
          where: { employeeId: event.employeeId },
        });

        superseded =
          profile?.lastAppliedSequence != null &&
          profile.lastAppliedSequence >= event.sequence
            ? profile.lastAppliedSequence
            : null;

        if (superseded !== null) {
          this.logger.warn(
            `Event ${eventId} (seq ${event.sequence}) superseded by seq ${superseded}; not re-applying`,
          );
        } else {
          await tx.employeePayrollProfile.upsert({
            where: { employeeId: event.employeeId },
            create: {
              employeeId: event.employeeId,
              ...(mutation as object),
              lastAppliedSequence: event.sequence,
              lastAppliedEventId: event.id,
            },
            update: {
              ...mutation,
              lastAppliedSequence: event.sequence,
              lastAppliedEventId: event.id,
            },
          });
        }

        await tx.payrollEvent.update({
          where: { id: eventId },
          data: {
            status: PayrollEventStatus.SUCCEEDED,
            result:
              superseded === null
                ? { ...result }
                : { ...result, applied: false, supersededBy: superseded },
            completedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
            failureCode: null,
            failureReason: null,
          },
        });

        await tx.payrollEventTransition.create({
          data: {
            eventId,
            fromStatus: PayrollEventStatus.PROCESSING,
            toStatus: PayrollEventStatus.SUCCEEDED,
            attempt,
            message:
              superseded === null
                ? `Applied via ${result.providerReference}`
                : `Provider accepted ${result.providerReference}, but sequence ${superseded} already superseded this change`,
            metadata: { ...result },
          },
        });
      });

      this.logger.log(
        `Processing succeeded event=${eventId} attempt=${attempt} ref=${result.providerReference}`,
      );
      return result;
    } catch (error) {
      return this.handleFailure(eventId, attempt, event.maxAttempts, error);
    }
  }

  /**
   * Requirement 4: a permanent error fails the event immediately; a transient
   * one is rethrown so BullMQ retries with exponential backoff, and only
   * becomes permanent once attempts are exhausted.
   */
  private async handleFailure(
    eventId: string,
    attempt: number,
    maxAttempts: number,
    error: unknown,
  ): Promise<never | unknown> {
    const err = error as Error & { code?: string };
    const permanent = isPermanent(error);
    const exhausted = attempt >= maxAttempts;

    if (permanent || exhausted) {
      const code = permanent ? (err.code ?? "PERMANENT") : RETRIES_EXHAUSTED;
      const reason = permanent
        ? err.message
        : `Giving up after ${attempt} attempts. Last error: ${err.message}`;

      await this.prisma.payrollEvent.update({
        where: { id: eventId },
        data: {
          status: PayrollEventStatus.FAILED,
          failureCode: code,
          failureReason: reason,
          completedAt: new Date(),
          lockedBy: null,
          lockedAt: null,
        },
      });

      await this.recordTransition(
        eventId,
        PayrollEventStatus.PROCESSING,
        PayrollEventStatus.FAILED,
        attempt,
        reason,
        { code, permanent },
      );

      this.logger.error(
        `Processing failed permanently event=${eventId} attempt=${attempt} code=${code}: ${err.message}`,
      );

      // Returning (not throwing) marks the job completed: the failure is fully
      // represented in Postgres and further BullMQ retries would be pointless.
      return { failed: true, code, reason };
    }

    await this.prisma.payrollEvent.update({
      where: { id: eventId },
      data: {
        status: PayrollEventStatus.PENDING_RETRY,
        failureCode: err.code ?? "TRANSIENT",
        failureReason: err.message,
        lockedBy: null,
        lockedAt: null,
      },
    });

    await this.recordTransition(
      eventId,
      PayrollEventStatus.PROCESSING,
      PayrollEventStatus.PENDING_RETRY,
      attempt,
      err.message,
      { code: err.code ?? "TRANSIENT", nextAttempt: attempt + 1, maxAttempts },
    );

    this.logger.warn(
      `Processing failed transiently event=${eventId} attempt=${attempt}/${maxAttempts}: ${err.message}`,
    );

    // Rethrow so BullMQ applies the configured backoff and retries.
    throw error;
  }

  private async recordTransition(
    eventId: string,
    fromStatus: PayrollEventStatus | null,
    toStatus: PayrollEventStatus,
    attempt: number,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.payrollEventTransition.create({
      data: {
        eventId,
        fromStatus,
        toStatus,
        attempt,
        message,
        metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<PayrollJobData> | undefined, error: Error): void {
    if (error instanceof DelayedError) return;
    this.logger.warn(
      `Job ${job?.id} failed (will retry if attempts remain): ${error.message}`,
    );
  }

  @OnWorkerEvent("error")
  onError(error: Error): void {
    this.logger.error(`Worker error: ${error.message}`, error.stack);
  }
}
