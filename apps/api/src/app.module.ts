import { Module } from "@nestjs/common";

import { CoreModule } from "./core.module";
import { EmployeesModule } from "./employees/employees.module";
import { EventsModule } from "./events/events.module";
import { HealthModule } from "./health/health.module";

/**
 * The HTTP API. It produces jobs but registers no processor, so scaling the
 * API does not scale the number of consumers.
 */
@Module({
  imports: [CoreModule, EventsModule, EmployeesModule, HealthModule],
})
export class AppModule {}
