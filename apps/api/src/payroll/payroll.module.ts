import { Module } from "@nestjs/common";

import { PayrollProviderService } from "./payroll-provider.service";

@Module({
  providers: [PayrollProviderService],
  exports: [PayrollProviderService],
})
export class PayrollModule {}
