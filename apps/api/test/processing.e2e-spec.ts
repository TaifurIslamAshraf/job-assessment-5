import { INestApplication } from "@nestjs/common";
import { Queue } from "bullmq";
import request from "supertest";
import type { App } from "supertest/types";

import { PayrollEventStatus } from "../src/generated/prisma/enums";
import { PrismaService } from "../src/prisma/prisma.service";
import { PayrollProviderService } from "../src/payroll/payroll-provider.service";
import {
  PermanentPayrollError,
  TransientPayrollError,
} from "../src/payroll/payroll.errors";
import { RecoveryService } from "../src/events/recovery.service";
import {
  createApi,
  createWorker,
  drainQueue,
  resetDatabase,
  uniqueEmployee,
  waitFor,
} from "./helpers";

/**
 * End-to-end tests: API + worker + Postgres + Redis, wired exactly as in
 * production but in one process. These are the tests that actually prove the
 * reliability requirements, so the provider is stubbed per-case rather than
 * left random.
 */
describe("Payroll processing (e2e)", () => {
  let app: INestApplication;
  let worker: INestApplication;
  let prisma: PrismaService;
  let queue: Queue;
  let provider: PayrollProviderService;

  beforeAll(async () => {
    ({ app, prisma, queue } = await createApi());
    worker = await createWorker();
    provider = worker.get(PayrollProviderService);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await worker.close();
    await drainQueue(queue);
    await app.close();
  });

  const submit = (body: Record<string, unknown>) =>
    request(app.getHttpServer() as App)
      .post("/api/events")
      .send(body);

  const salary = (employeeId: string, newSalary = 65000) => ({
    type: "SALARY_CHANGE",
    employeeId,
    effectiveDate: "2026-09-01",
    payload: { newSalary, currency: "EUR" },
  });

  const readEvent = (id: string) =>
    prisma.payrollEvent.findUniqueOrThrow({ where: { id } });

  function stubProvider() {
    return jest.spyOn(provider, "submit").mockResolvedValue({
      providerReference: "PP-TEST",
      acknowledgedAt: new Date().toISOString(),
      latencyMs: 1,
    });
  }

  it("processes an accepted event and persists the result", async () => {
    stubProvider();
    const employeeId = uniqueEmployee();

    const res = await submit(salary(employeeId)).expect(202);

    const done = await waitFor(
      () => readEvent(res.body.id as string),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
    );

    expect(done.result).toMatchObject({ providerReference: "PP-TEST" });
    expect(done.completedAt).not.toBeNull();
    expect(done.processingStartedAt).not.toBeNull();

    // The business change is actually applied, not just marked done.
    const profile = await prisma.employeePayrollProfile.findUniqueOrThrow({
      where: { employeeId },
    });
    expect(Number(profile.salaryAmount)).toBe(65000);
    expect(profile.lastAppliedEventId).toBe(res.body.id);
  });

  it("writes a full transition history", async () => {
    stubProvider();
    const res = await submit(salary(uniqueEmployee())).expect(202);

    await waitFor(
      () => readEvent(res.body.id as string),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
    );

    const transitions = await prisma.payrollEventTransition.findMany({
      where: { eventId: res.body.id as string },
      orderBy: { createdAt: "asc" },
    });

    expect(transitions.map((t) => t.toStatus)).toEqual([
      PayrollEventStatus.ACCEPTED,
      PayrollEventStatus.PROCESSING,
      PayrollEventStatus.SUCCEEDED,
    ]);
  });

  it("retries a transient failure and eventually succeeds", async () => {
    // Fails twice, then works — the event must not be marked FAILED in between.
    let calls = 0;
    jest.spyOn(provider, "submit").mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) {
        throw new TransientPayrollError("provider is having a bad day");
      }
      return {
        providerReference: "PP-RECOVERED",
        acknowledgedAt: new Date().toISOString(),
        latencyMs: 1,
      };
    });

    const res = await submit(salary(uniqueEmployee())).expect(202);

    const done = await waitFor(
      () => readEvent(res.body.id as string),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );

    expect(done.attempts).toBe(3);
    expect(done.result).toMatchObject({ providerReference: "PP-RECOVERED" });
    // Cleared on success so a resolved event shows no stale error.
    expect(done.failureReason).toBeNull();

    const retried = await prisma.payrollEventTransition.findMany({
      where: {
        eventId: res.body.id as string,
        toStatus: PayrollEventStatus.PENDING_RETRY,
      },
    });
    expect(retried).toHaveLength(2);
  });

  it("marks an event FAILED without retrying when the error is permanent", async () => {
    const spy = jest
      .spyOn(provider, "submit")
      .mockRejectedValue(new PermanentPayrollError("nope", "TEST_PERMANENT"));

    const res = await submit(salary(uniqueEmployee())).expect(202);

    const failed = await waitFor(
      () => readEvent(res.body.id as string),
      (e) => e.status === PayrollEventStatus.FAILED,
    );

    expect(failed.failureCode).toBe("TEST_PERMANENT");
    expect(failed.attempts).toBe(1);
    // The whole point: a permanent error costs exactly one provider call.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fails a business-rule violation before ever calling the provider", async () => {
    const spy = stubProvider();

    // Above the automatic approval limit enforced by SalaryChangeHandler.
    const res = await submit(salary(uniqueEmployee(), 2_000_000)).expect(202);

    const failed = await waitFor(
      () => readEvent(res.body.id as string),
      (e) => e.status === PayrollEventStatus.FAILED,
    );

    expect(failed.failureCode).toBe("SALARY_ABOVE_APPROVAL_LIMIT");
    expect(spy).not.toHaveBeenCalled();
  });

  it("dead-letters after exhausting attempts and explains why", async () => {
    jest
      .spyOn(provider, "submit")
      .mockRejectedValue(new TransientPayrollError("permanently unavailable"));

    const res = await submit(salary(uniqueEmployee())).expect(202);

    const failed = await waitFor(
      () => readEvent(res.body.id as string),
      (e) => e.status === PayrollEventStatus.FAILED,
      { timeoutMs: 60_000 },
    );

    expect(failed.failureCode).toBe("RETRIES_EXHAUSTED");
    expect(failed.failureReason).toContain("permanently unavailable");
    expect(failed.attempts).toBe(failed.maxAttempts);
  });

  it("applies a duplicate submission only once", async () => {
    stubProvider();
    const employeeId = uniqueEmployee();
    const body = salary(employeeId);

    const first = await submit(body).expect(202);
    await submit(body).expect(200);
    await submit(body).expect(200);

    await waitFor(
      () => readEvent(first.body.id as string),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
    );

    expect(await prisma.payrollEvent.count({ where: { employeeId } })).toBe(1);

    const applied = await prisma.payrollEventTransition.count({
      where: {
        eventId: first.body.id as string,
        toStatus: PayrollEventStatus.SUCCEEDED,
      },
    });
    expect(applied).toBe(1);
  });

  it("is a no-op when a finished event is redelivered", async () => {
    // Requirement 8: the worker crashed after committing but before acking,
    // so the same job comes back. Re-adding the job simulates that exactly.
    stubProvider();
    const employeeId = uniqueEmployee();
    const res = await submit(salary(employeeId)).expect(202);
    const id = res.body.id as string;

    const done = await waitFor(
      () => readEvent(id),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
    );

    const job = await queue.getJob(id);
    await job?.remove();
    await queue.add(
      "SALARY_CHANGE",
      { eventId: id, employeeId },
      { jobId: id },
    );

    await new Promise((r) => setTimeout(r, 2_000));

    const after = await readEvent(id);
    expect(after.attempts).toBe(done.attempts);
    expect(after.completedAt?.getTime()).toBe(done.completedAt?.getTime());

    const profile = await prisma.employeePayrollProfile.findUniqueOrThrow({
      where: { employeeId },
    });
    expect(profile.lastAppliedEventId).toBe(id);
  });

  it("processes events for one employee in accept order", async () => {
    stubProvider();
    const employeeId = uniqueEmployee();

    // Address first, then salary. The salary event must not overtake it.
    const a = await submit({
      type: "ADDRESS_CHANGE",
      employeeId,
      effectiveDate: "2026-09-01",
      payload: {
        street: "Hauptstrasse 12",
        city: "Berlin",
        postalCode: "10115",
        country: "DE",
      },
    }).expect(202);

    const b = await submit(salary(employeeId, 80000)).expect(202);

    await waitFor(
      () => readEvent(b.body.id as string),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );

    const first = await readEvent(a.body.id as string);
    const second = await readEvent(b.body.id as string);

    expect(first.status).toBe(PayrollEventStatus.SUCCEEDED);
    expect(first.completedAt!.getTime()).toBeLessThanOrEqual(
      second.completedAt!.getTime(),
    );

    // The later event's write is the one that stuck.
    const profile = await prisma.employeePayrollProfile.findUniqueOrThrow({
      where: { employeeId },
    });
    expect(profile.lastAppliedSequence).toBe(second.sequence);
    expect(profile.city).toBe("Berlin");
    expect(Number(profile.salaryAmount)).toBe(80000);
  });

  it("recovers an event abandoned by a crashed worker", async () => {
    stubProvider();
    const employeeId = uniqueEmployee();
    const res = await submit(salary(employeeId)).expect(202);
    const id = res.body.id as string;

    await waitFor(
      () => readEvent(id),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
    );

    // Simulate the aftermath of a SIGKILL mid-processing: the row is stuck in
    // PROCESSING with a stale claim and no job in Redis.
    await prisma.payrollEvent.update({
      where: { id },
      data: {
        status: PayrollEventStatus.PROCESSING,
        lockedBy: "dead-worker#1",
        lockedAt: new Date(Date.now() - 10 * 60 * 1000),
        completedAt: null,
      },
    });

    const recovered = await worker.get(RecoveryService).recoverStuckEvents();
    expect(recovered).toBe(1);

    const done = await waitFor(
      () => readEvent(id),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );
    expect(done.status).toBe(PayrollEventStatus.SUCCEEDED);
  });
});
