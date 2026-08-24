import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";

import { WorkerModule } from "./worker.module";

/**
 * Standalone Nest context — no HTTP server. Background processing therefore
 * cannot depend on an open request, and the worker scales independently.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  // Lets BullMQ drain in-flight jobs and Prisma close its pool on SIGTERM
  // instead of leaving events stranded in PROCESSING.
  app.enableShutdownHooks();

  logger.log(
    `Worker ready (concurrency=${process.env.WORKER_CONCURRENCY ?? 5}, pid=${process.pid})`,
  );
}

void bootstrap();
