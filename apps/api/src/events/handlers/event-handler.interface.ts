import { Prisma } from "../../generated/prisma/client";
import { PayrollEventType } from "../../generated/prisma/enums";

export interface HandlerContext {
  eventId: string;
  employeeId: string;
  sequence: number;
  effectiveDate: Date;
  payload: Record<string, unknown>;
}

/**
 * One handler per event type.
 *
 * `validate` runs business rules that need more than shape checking — it may
 * throw PermanentPayrollError, which skips retries entirely.
 *
 * `apply` returns the profile mutation to write. It must be pure: the caller
 * runs it inside the same transaction that flips the event to SUCCEEDED, so a
 * handler that performs its own writes would break crash-consistency.
 */
export interface PayrollEventHandler {
  readonly type: PayrollEventType;

  validate(ctx: HandlerContext): Promise<void> | void;

  apply(ctx: HandlerContext): Prisma.EmployeePayrollProfileUpdateInput;
}

export const PAYROLL_EVENT_HANDLER = Symbol("PAYROLL_EVENT_HANDLER");
