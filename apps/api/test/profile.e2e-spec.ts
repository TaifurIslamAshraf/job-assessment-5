import { INestApplication } from "@nestjs/common";
import { Queue } from "bullmq";
import request from "supertest";
import type { App } from "supertest/types";

import { PayrollEventStatus } from "../src/generated/prisma/enums";
import { PayrollProviderService } from "../src/payroll/payroll-provider.service";
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
 * The applied state, read back over HTTP. These are the tests that show the
 * ordering and single-apply guarantees produce the right *result*, not just
 * the right event statuses.
 */
describe("Employee payroll profile (e2e)", () => {
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
    jest.spyOn(provider, "submit").mockResolvedValue({
      providerReference: "PP-TEST",
      acknowledgedAt: new Date().toISOString(),
      latencyMs: 1,
    });
  });

  afterAll(async () => {
    await worker.close();
    await drainQueue(queue);
    await app.close();
  });

  const server = () => app.getHttpServer() as App;

  const submit = (body: Record<string, unknown>) =>
    request(server()).post("/api/events").send(body);

  const salary = (employeeId: string, newSalary: number) => ({
    type: "SALARY_CHANGE",
    employeeId,
    effectiveDate: "2026-09-01",
    payload: { newSalary, currency: "EUR" },
  });

  const getProfile = (employeeId: string) =>
    request(server()).get(`/api/employees/${employeeId}/profile`);

  const settled = (id: string) =>
    waitFor(
      () => prisma.payrollEvent.findUniqueOrThrow({ where: { id } }),
      (e) => e.status === PayrollEventStatus.SUCCEEDED,
      { timeoutMs: 30_000 },
    );

  it("404s until an event has actually succeeded", async () => {
    const employeeId = uniqueEmployee();

    const missing = await getProfile(employeeId).expect(404);
    expect(missing.body.message).toContain(employeeId);

    const res = await submit(salary(employeeId, 65000)).expect(202);
    await settled(res.body.id as string);

    await getProfile(employeeId).expect(200);
  });

  it("settles on the last event accepted for that employee", async () => {
    const employeeId = uniqueEmployee();

    const ids: string[] = [];
    for (const amount of [50000, 60000, 70000]) {
      const res = await submit(salary(employeeId, amount)).expect(202);
      ids.push(res.body.id as string);
    }

    const last = await settled(ids[2]!);

    const { body } = await getProfile(employeeId).expect(200);
    expect(body.salary).toEqual({ amount: 70000, currency: "EUR" });
    expect(body.lastAppliedSequence).toBe(last.sequence);
    expect(body.lastAppliedEventId).toBe(ids[2]);
  });

  it("merges different event types into one profile", async () => {
    const employeeId = uniqueEmployee();

    await submit({
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

    const second = await submit(salary(employeeId, 82000)).expect(202);
    await settled(second.body.id as string);

    const { body } = await getProfile(employeeId).expect(200);
    expect(body.address).toEqual({
      street: "Hauptstrasse 12",
      city: "Berlin",
      postalCode: "10115",
      country: "DE",
    });
    expect(body.salary.amount).toBe(82000);
  });

  it("is untouched by a duplicate submission", async () => {
    const employeeId = uniqueEmployee();
    const body = salary(employeeId, 65000);

    const first = await submit(body).expect(202);
    await settled(first.body.id as string);
    const before = (await getProfile(employeeId).expect(200)).body;

    await submit(body).expect(200);
    await new Promise((r) => setTimeout(r, 2_000));

    const after = (await getProfile(employeeId).expect(200)).body;
    expect(after).toEqual(before);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("omits sections no event has written yet", async () => {
    const employeeId = uniqueEmployee();
    const res = await submit(salary(employeeId, 65000)).expect(202);
    await settled(res.body.id as string);

    const { body } = await getProfile(employeeId).expect(200);
    expect(body.address).toBeNull();
    expect(body.iban).toBeNull();
  });
});
