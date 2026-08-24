/** Single queue for every payroll event type; the handler is chosen by `type`. */
export const PAYROLL_QUEUE = "payroll-events";

/** Payload put on the queue. Deliberately thin — the row in Postgres is the
 *  source of truth, the job only carries what the worker needs to find it. */
export interface PayrollJobData {
  eventId: string;
  employeeId: string;
}
