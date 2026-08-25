import { INestApplication } from "@nestjs/common";
import { Queue } from "bullmq";
import request from "supertest";
import type { App } from "supertest/types";

import { PayrollEventStatus } from "../src/generated/prisma/enums";
import { PayrollProviderService } from "../src/payroll/payroll-provider.service";
import {
  PermanentPayrollError,
  TransientPayrollError,
} from "../src/payroll/payroll.errors";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  createApi,
  createWorker,
  drainQueue,
  resetDatabase,
  uniqueEmployee,
  waitFor,
} from "./helpers";

/**
 * Operator retry of a dead-lettered event. The interesting part is not the
 * endpoint but what it has to undo: a finished BullMQ job and an exhausted
 * attempt budget.
 */
describe("Event retry (e2e)", () => {
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

  const server = () => app.getHttpServer() as App;

  const salary = (employeeId: string, newSalary = 65000) => ({
    type: "SALARY_CHANGE",
    employeeId,
    effectiveDate: "2026-09-01",
    payload: { newSalary, currency: "EUR" },
  });

  const retry = (id: string, force = false) =>
    request(server()).post(
      `/api/events/${id}/retry${force ? "?force=true" : ""}`,
    );

  const readEvent = (id: string) =>
    prisma.payrollEvent.findUniqueOrThrow({ where: { id } });

  function succeedingProvider() {
    return jest.spyOn(provider, "submit").mockResolvedValue({
      providerReference: "PP-TEST",
      acknowledgedAt: new Date().toISOString(),
      latencyMs: 1,
    });
  }

  /** Submits an event and drives it to FAILED with the given error. */
  async function failedEvent(
    error: Error,
    employeeId = uniqueEmployee(),
    timeoutMs = 60_000,
  ): Promise<string> {
    jest.spyOn(provider, "submit").mockRejectedValue(error);

    const res = await request(server())
      .post("/api/events")
      .send(salary(employeeId))
      .expect(202);

    const id = res.body.id as string;
    await waitFor(
      () => readEvent(id),
      (e) => e.status === PayrollEventStatus.FAILED,
      { timeoutMs },
    );

    return id;
  }

  it("re-runs a dead-lettered event and applies it", async () => {
    const employeeId = uniqueEmployee();
    const id = await failedEvent(
      new TransientPayrollError("provider down"),
      employeeId,
    );

    const exhausted = await readEvent(id);
    expect(exhausted.failureCode).toBe("RETRIES_EXHAUSTED");

    succeedingProvider();
    const res = await retry(id).expect(202);
    // The budget is extended rather than reset, so the row keeps recording the
    // total effort spent on this event.
    expect(res.body.maxAttempts).toBe(exhausted.attempts + 5);

    const done = await waitFor(
      () => readEvent(id),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );

    expect(done.attempts).toBe(exhausted.attempts + 1);
    expect(done.failureCode).toBeNull();

    const profile = await prisma.employeePayrollProfile.findUniqueOrThrow({
      where: { employeeId },
    });
    expect(Number(profile.salaryAmount)).toBe(65000);
    expect(profile.lastAppliedEventId).toBe(id);
  });

  it("records the manual retry in the audit trail", async () => {
    const id = await failedEvent(
      new PermanentPayrollError("nope", "TEST_PERMANENT"),
    );

    succeedingProvider();
    await retry(id, true).expect(202);

    await waitFor(
      () => readEvent(id),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );

    const transitions = await prisma.payrollEventTransition.findMany({
      where: { eventId: id },
      orderBy: { createdAt: "asc" },
    });

    expect(transitions.map((t) => t.toStatus)).toEqual([
      PayrollEventStatus.ACCEPTED,
      PayrollEventStatus.PROCESSING,
      PayrollEventStatus.FAILED,
      PayrollEventStatus.PENDING_RETRY,
      PayrollEventStatus.PROCESSING,
      PayrollEventStatus.SUCCEEDED,
    ]);
    expect(transitions[3]).toMatchObject({
      message: "Manual retry requested",
      metadata: { force: true, previousFailureCode: "TEST_PERMANENT" },
    });
  });

  it("refuses a permanent failure unless force is set", async () => {
    const id = await failedEvent(
      new PermanentPayrollError("above the limit", "TEST_PERMANENT"),
    );

    const refused = await retry(id).expect(409);
    expect(refused.body.message).toContain("TEST_PERMANENT");
    expect(refused.body.message).toContain("force=true");

    // Refusing must not have touched the row.
    const untouched = await readEvent(id);
    expect(untouched.status).toBe(PayrollEventStatus.FAILED);
    expect(untouched.failureCode).toBe("TEST_PERMANENT");
  });

  it("applies once when two operators retry the same event at the same time", async () => {
    const employeeId = uniqueEmployee();
    const id = await failedEvent(
      new PermanentPayrollError("nope", "TEST_PERMANENT"),
      employeeId,
    );

    succeedingProvider();
    const responses = await Promise.all([retry(id, true), retry(id, true)]);

    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);

    await waitFor(
      () => readEvent(id),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );

    const applied = await prisma.payrollEventTransition.count({
      where: { eventId: id, toStatus: PayrollEventStatus.SUCCEEDED },
    });
    expect(applied).toBe(1);

    const profile = await prisma.employeePayrollProfile.findUniqueOrThrow({
      where: { employeeId },
    });
    expect(profile.lastAppliedEventId).toBe(id);
  });

  it("refuses to retry an event that is not FAILED", async () => {
    succeedingProvider();
    const res = await request(server())
      .post("/api/events")
      .send(salary(uniqueEmployee()))
      .expect(202);

    const id = res.body.id as string;
    await waitFor(
      () => readEvent(id),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
    );

    const refused = await retry(id, true).expect(409);
    expect(refused.body.message).toContain("SUCCEEDED");
  });

  it("does not silently overwrite a later change when a retry is superseded", async () => {
    const employeeId = uniqueEmployee();

    // The first event fails; the second, accepted later, succeeds and wins.
    let calls = 0;
    jest.spyOn(provider, "submit").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new PermanentPayrollError("needs approval", "TEST_PERMANENT");
      }
      return {
        providerReference: "PP-TEST",
        acknowledgedAt: new Date().toISOString(),
        latencyMs: 1,
      };
    });

    const first = await request(server())
      .post("/api/events")
      .send(salary(employeeId, 90000))
      .expect(202);
    const second = await request(server())
      .post("/api/events")
      .send(salary(employeeId, 70000))
      .expect(202);

    const firstId = first.body.id as string;
    const secondId = second.body.id as string;

    await waitFor(
      () => readEvent(firstId),
      (e) => e.status === PayrollEventStatus.FAILED,
    );
    const winner = await waitFor(
      () => readEvent(secondId),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );

    // An operator gets approval and retries the older, larger raise.
    await retry(firstId, true).expect(202);
    const replayed = await waitFor(
      () => readEvent(firstId),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );

    // It reaches SUCCEEDED, but the record must say it did not apply rather
    // than claiming it did — and the later change must survive.
    expect(replayed.result).toMatchObject({
      applied: false,
      supersededBy: winner.sequence,
    });

    const profile = await prisma.employeePayrollProfile.findUniqueOrThrow({
      where: { employeeId },
    });
    expect(Number(profile.salaryAmount)).toBe(70000);
    expect(profile.lastAppliedEventId).toBe(secondId);
  });

  it("404s for an event that does not exist", async () => {
    await retry("00000000-0000-4000-8000-000000000000").expect(404);
  });
});
