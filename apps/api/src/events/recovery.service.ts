import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Queue } from "bullmq";

import { PayrollEventStatus } from "../generated/prisma/enums";
import { PrismaService } from "../prisma/prisma.service";
import { PAYROLL_QUEUE, PayrollJobData } from "../queue/queue.constants";

/** Job states that mean a job really is still queued for this event. */
const PENDING_JOB_STATES = new Set([
  "waiting",
  "waiting-children",
  "active",
  "delayed",
  "prioritized",
]);

/** A claim older than this is assumed to belong to a worker that died. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

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
    @InjectQueue(PAYROLL_QUEUE) private readonly queue: Queue<PayrollJobData>,
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
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS);

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
      await this.enqueue(event.id, event.employeeId);
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
      const job = await this.queue.getJob(event.id);
      // A job in a finished set does not count as backing the row — the row is
      // ready to run, so a completed/failed job means the two have diverged.
      if (job && PENDING_JOB_STATES.has(await job.getState())) continue;

      await this.enqueue(event.id, event.employeeId);
      requeued += 1;
      this.logger.warn(`Re-enqueued orphaned event ${event.id}`);
    }

    return requeued;
  }

  /**
   * `jobId` is the event id, which is what makes enqueueing idempotent — but
   * BullMQ *silently ignores* an add whose jobId already exists, including one
   * sitting in the completed set from a previous run. Recovery must therefore
   * clear the old job first, or the re-enqueue is a no-op and the event stays
   * stuck forever.
   */
  private async enqueue(eventId: string, employeeId: string): Promise<void> {
    const existing = await this.queue.getJob(eventId);
    if (existing) {
      // Throws if the job is currently active; that worker owns it, so leaving
      // it alone is correct.
      await existing.remove().catch(() => undefined);
    }

    await this.queue.add(
      "recovery",
      { eventId, employeeId },
      { jobId: eventId },
    );
  }
}
