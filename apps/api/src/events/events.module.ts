import { Module } from "@nestjs/common";

import { PayrollModule } from "../payroll/payroll.module";
import { QueueModule } from "../queue/queue.module";
import { EventsController } from "./events.controller";
import { EventsService } from "./events.service";
import { AddressChangeHandler } from "./handlers/address-change.handler";
import { BankAccountChangeHandler } from "./handlers/bank-account-change.handler";
import { HandlerRegistry } from "./handlers/handler.registry";
import { SalaryChangeHandler } from "./handlers/salary-change.handler";

/**
 * Shared by both entrypoints. The API imports it for the controller and
 * producer; the worker imports it for the handler registry. The processor
 * itself is registered only in WorkerModule so an API instance never consumes
 * jobs.
 */
@Module({
  imports: [QueueModule, PayrollModule],
  controllers: [EventsController],
  providers: [
    EventsService,
    HandlerRegistry,
    BankAccountChangeHandler,
    AddressChangeHandler,
    SalaryChangeHandler,
  ],
  exports: [EventsService, HandlerRegistry, QueueModule],
})
export class EventsModule {}
