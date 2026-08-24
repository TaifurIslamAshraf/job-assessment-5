import { Injectable } from "@nestjs/common";

import { Prisma } from "../../generated/prisma/client";
import { PayrollEventType } from "../../generated/prisma/enums";
import { AddressChangePayload } from "../dto/payloads";
import { HandlerContext, PayrollEventHandler } from "./event-handler.interface";

@Injectable()
export class AddressChangeHandler implements PayrollEventHandler {
  readonly type = PayrollEventType.ADDRESS_CHANGE;

  validate(): void {
    // Shape and country code are already enforced by AddressChangePayload.
  }

  apply(ctx: HandlerContext): Prisma.EmployeePayrollProfileUpdateInput {
    const { street, city, postalCode, country } =
      ctx.payload as unknown as AddressChangePayload;
    return { street, city, postalCode, country };
  }
}
