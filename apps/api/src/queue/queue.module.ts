import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { PayrollQueueService } from "./payroll-queue.service";
import { PAYROLL_QUEUE } from "./queue.constants";

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.getOrThrow<string>("REDIS_URL"),
          // BullMQ blocks on Redis; retry-per-request must be disabled.
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueueAsync({
      name: PAYROLL_QUEUE,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        defaultJobOptions: {
          attempts: config.get<number>("MAX_ATTEMPTS") ?? 5,
          backoff: { type: "exponential", delay: 1_000 },
          // Keep finished jobs briefly so the queue can be inspected during a demo.
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 24 * 3_600 },
        },
      }),
    }),
  ],
  providers: [PayrollQueueService],
  exports: [BullModule, PayrollQueueService],
})
export class QueueModule {}
