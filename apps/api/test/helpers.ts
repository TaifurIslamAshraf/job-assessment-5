import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Queue } from "bullmq";
import { getQueueToken } from "@nestjs/bullmq";

import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PAYROLL_QUEUE } from "../src/queue/queue.constants";
import { WorkerModule } from "../src/worker.module";

export async function createApi(): Promise<{
  app: INestApplication;
  prisma: PrismaService;
  queue: Queue;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    queue: app.get<Queue>(getQueueToken(PAYROLL_QUEUE)),
  };
}

/** Boots the worker as its own Nest context, exactly as `dist/worker` does. */
export async function createWorker() {
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.payrollEventTransition.deleteMany();
  await prisma.payrollEvent.deleteMany();
  await prisma.employeePayrollProfile.deleteMany();
}

export async function drainQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}

/** Polls until `predicate` holds or the timeout elapses. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 20_000, intervalMs = 150 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;

  for (;;) {
    last = await fn();
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const uniqueEmployee = (): string =>
  `emp-${Math.random().toString(36).slice(2, 10)}`;
