import { Injectable, Logger } from "@nestjs/common";

import { PayrollEventType } from "../../generated/prisma/enums";
import { PermanentPayrollError } from "../../payroll/payroll.errors";
import { AddressChangeHandler } from "./address-change.handler";
import { BankAccountChangeHandler } from "./bank-account-change.handler";
import { PayrollEventHandler } from "./event-handler.interface";
import { SalaryChangeHandler } from "./salary-change.handler";

/**
 * Resolves an event type to its handler. Adding a new type means writing a
 * handler, a payload DTO, and adding it to this constructor — the queue,
 * worker, retry policy and API stay untouched.
 */
@Injectable()
export class HandlerRegistry {
  private readonly logger = new Logger(HandlerRegistry.name);
  private readonly handlers = new Map<PayrollEventType, PayrollEventHandler>();

  constructor(
    bankAccount: BankAccountChangeHandler,
    address: AddressChangeHandler,
    salary: SalaryChangeHandler,
  ) {
    for (const handler of [bankAccount, address, salary]) {
      this.handlers.set(handler.type, handler);
    }
    this.logger.log(
      `Registered handlers: ${[...this.handlers.keys()].join(", ")}`,
    );
  }

  get(type: PayrollEventType): PayrollEventHandler {
    const handler = this.handlers.get(type);
    if (!handler) {
      // Reaching here means a row exists for a type with no code to process it,
      // which no amount of retrying fixes.
      throw new PermanentPayrollError(
        `No handler registered for event type ${type}`,
        "UNKNOWN_EVENT_TYPE",
      );
    }
    return handler;
  }

  supports(type: PayrollEventType): boolean {
    return this.handlers.has(type);
  }
}
