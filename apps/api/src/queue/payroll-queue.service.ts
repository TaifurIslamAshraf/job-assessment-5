import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { JobsOptions, Queue } from "bullmq";

import { PAYROLL_QUEUE, PayrollJobData } from "./queue.constants";

/** Job states that mean a job really is still queued for this event. */
const PENDING_JOB_STATES = new Set([
  "waiting",
  "waiting-children",
  "active",
  "delayed",
  "prioritized",
]);

/**
 * Owns the invariant every producer depends on: the job id is the event id, so
 * one event can never have two jobs.
 */
@Injectable()
export class PayrollQueueService {
  constructor(
    @InjectQueue(PAYROLL_QUEUE) private readonly queue: Queue<PayrollJobData>,
  ) {}

  async enqueue(
    name: string,
    eventId: string,
    employeeId: string,
    opts?: JobsOptions,
  ): Promise<void> {
    await this.queue.add(
      name,
      { eventId, employeeId },
      { ...opts, jobId: eventId },
    );
  }

  /**
   * Runs an event again after it already had a job. BullMQ *silently ignores*
   * an add whose jobId already exists, including one sitting in the completed
   * set, so the old job has to be cleared first or this is a no-op and the
   * event stays stuck forever.
   */
  async reenqueue(
    name: string,
    eventId: string,
    employeeId: string,
    opts?: JobsOptions,
  ): Promise<void> {
    const existing = await this.queue.getJob(eventId);
    if (existing) {
      // Throws if the job is currently active; that worker owns it, so leaving
      // it alone is correct.
      await existing.remove().catch(() => undefined);
    }

    await this.enqueue(name, eventId, employeeId, opts);
  }

  /**
   * Whether a job is still backing this event. A job in a finished set does not
   * count — a row that is ready to run means the two have diverged.
   */
  async hasPendingJob(eventId: string): Promise<boolean> {
    const job = await this.queue.getJob(eventId);
    if (!job) return false;

    return PENDING_JOB_STATES.has(await job.getState());
  }
}
