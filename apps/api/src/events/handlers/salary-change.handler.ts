import { Injectable } from "@nestjs/common";

import { Prisma } from "../../generated/prisma/client";
import { PayrollEventType } from "../../generated/prisma/enums";
import { PermanentPayrollError } from "../../payroll/payroll.errors";
import { SalaryChangePayload } from "../dto/payloads";
import { HandlerContext, PayrollEventHandler } from "./event-handler.interface";

const MAX_ANNUAL_SALARY = 1_000_000;

@Injectable()
export class SalaryChangeHandler implements PayrollEventHandler {
  readonly type = PayrollEventType.SALARY_CHANGE;

  validate(ctx: HandlerContext): void {
    const { newSalary } = ctx.payload as unknown as SalaryChangePayload;

    // A salary above the approval threshold can never be applied automatically,
    // so retrying is pointless — this is a permanent failure by design.
    if (newSalary > MAX_ANNUAL_SALARY) {
      throw new PermanentPayrollError(
        `Salary ${newSalary} exceeds the automatic approval limit of ${MAX_ANNUAL_SALARY}`,
        "SALARY_ABOVE_APPROVAL_LIMIT",
      );
    }
  }

  apply(ctx: HandlerContext): Prisma.EmployeePayrollProfileUpdateInput {
    const { newSalary, currency } =
      ctx.payload as unknown as SalaryChangePayload;
    return {
      salaryAmount: new Prisma.Decimal(newSalary),
      salaryCurrency: currency,
    };
  }
}
