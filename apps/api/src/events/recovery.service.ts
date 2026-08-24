import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";

import { PayrollEventStatus } from "../generated/prisma/enums";
import { PrismaService } from "../prisma/prisma.service";
import { PayrollQueueService } from "../queue/payroll-queue.service";

/**
 * Requirement 7: a worker that is SIGKILLed mid-event leaves the row in
 * PROCESSING with nobody working on it. BullMQ's stalled-job detection
 * recovers the *job*; this recovers the *row* and covers the other gap too —
 * an event that was committed but never enqueued because Redis was down.
 *
 * Runs on the worker process only (see WorkerModule).
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PayrollQueueService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    const recovered = await this.recoverStuckEvents();
    const requeued = await this.requeueOrphans();

    if (recovered > 0 || requeued > 0) {
      this.logger.log(
        `Recovery sweep: ${recovered} stale claim(s) released, ${requeued} orphan(s) re-enqueued`,
      );
    }
  }

  /** PROCESSING rows whose worker never came back. */
  async recoverStuckEvents(): Promise<number> {
    const staleClaimMs = this.config.get<number>("STALE_CLAIM_MS") ?? 120_000;
    const cutoff = new Date(Date.now() - staleClaimMs);

    const stuck = await this.prisma.payrollEvent.findMany({
      where: {
        status: PayrollEventStatus.PROCESSING,
        lockedAt: { lt: cutoff },
      },
      select: { id: true, employeeId: true, attempts: true, lockedBy: true },
    });

    for (const event of stuck) {
      // Guarded by status so a worker that wakes up and finishes normally in
      // the meantime is not clobbered.
      const released = await this.prisma.payrollEvent.updateMany({
        where: { id: event.id, status: PayrollEventStatus.PROCESSING },
        data: {
          status: PayrollEventStatus.PENDING_RETRY,
          failureCode: "WORKER_LOST",
          failureReason: `Claim by ${event.lockedBy} expired; event released for retry`,
          lockedBy: null,
          lockedAt: null,
        },
      });

      if (released.count === 0) continue;

      await this.prisma.payrollEventTransition.create({
        data: {
          eventId: event.id,
          fromStatus: PayrollEventStatus.PROCESSING,
          toStatus: PayrollEventStatus.PENDING_RETRY,
          attempt: event.attempts,
          message: "Recovered from lost worker",
          metadata: { lockedBy: event.lockedBy },
        },
      });

      this.logger.warn(
        `Recovered stuck event ${event.id} from lost worker ${event.lockedBy}`,
      );
      await this.queue.reenqueue("recovery", event.id, event.employeeId);
    }

    return stuck.length;
  }

  /** Rows that are ready to run but have no job in Redis backing them. */
  async requeueOrphans(): Promise<number> {
    const candidates = await this.prisma.payrollEvent.findMany({
      where: {
        status: {
          in: [PayrollEventStatus.ACCEPTED, PayrollEventStatus.PENDING_RETRY],
        },
        acceptedAt: { lt: new Date(Date.now() - 30_000) },
      },
      select: { id: true, employeeId: true },
      take: 100,
    });

    let requeued = 0;
    for (const event of candidates) {
      if (await this.queue.hasPendingJob(event.id)) continue;

      await this.queue.reenqueue("recovery", event.id, event.employeeId);
      requeued += 1;
      this.logger.warn(`Re-enqueued orphaned event ${event.id}`);
    }

    return requeued;
  }
}
