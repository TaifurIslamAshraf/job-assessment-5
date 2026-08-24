import { Controller, Get, Param } from "@nestjs/common";
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { EmployeesService } from "./employees.service";

@ApiTags("employees")
@Controller("employees")
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get(":employeeId/profile")
  @ApiOperation({
    summary: "Read the payroll state an employee's events have produced",
    description:
      "The projection standing in for the external payroll system. " +
      "`lastAppliedSequence` names the event that last wrote it, which is how " +
      "ordering and single-apply can be checked without a database client.",
  })
  @ApiOkResponse({ description: "Current IBAN, address and salary." })
  @ApiNotFoundResponse({ description: "No event has succeeded for them yet." })
  async profile(@Param("employeeId") employeeId: string) {
    return this.employees.findProfile(employeeId);
  }
}
