import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { CoreModule } from "./core.module";
import { EventsModule } from "./events/events.module";
import { PayrollProcessor } from "./events/payroll.processor";
import { RecoveryService } from "./events/recovery.service";
import { PayrollModule } from "./payroll/payroll.module";

/**
 * The background worker. Shares CoreModule and EventsModule with the API but
 * adds the BullMQ processor and the recovery sweeper, and serves no HTTP.
 *
 * PayrollModule is imported directly: the processor injects the provider, and
 * EventsModule keeps it internal rather than re-exporting a transitive dep.
 */
@Module({
  imports: [CoreModule, EventsModule, PayrollModule, ScheduleModule.forRoot()],
  providers: [PayrollProcessor, RecoveryService],
})
export class WorkerModule {}
