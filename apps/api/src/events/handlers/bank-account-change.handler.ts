import { Injectable } from "@nestjs/common";

import { Prisma } from "../../generated/prisma/client";
import { PayrollEventType } from "../../generated/prisma/enums";
import { PermanentPayrollError } from "../../payroll/payroll.errors";
import { BankAccountChangePayload } from "../dto/payloads";
import { HandlerContext, PayrollEventHandler } from "./event-handler.interface";

@Injectable()
export class BankAccountChangeHandler implements PayrollEventHandler {
  readonly type = PayrollEventType.BANK_ACCOUNT_CHANGE;

  validate(ctx: HandlerContext): void {
    const { iban } = ctx.payload as unknown as BankAccountChangePayload;

    // Sanctioned-country example of a rule that no retry can satisfy.
    if (iban.startsWith("XX")) {
      throw new PermanentPayrollError(
        `IBAN country ${iban.slice(0, 2)} is not supported for payroll`,
        "UNSUPPORTED_IBAN_COUNTRY",
      );
    }
  }

  apply(ctx: HandlerContext): Prisma.EmployeePayrollProfileUpdateInput {
    const { iban } = ctx.payload as unknown as BankAccountChangePayload;
    return { iban };
  }
}
