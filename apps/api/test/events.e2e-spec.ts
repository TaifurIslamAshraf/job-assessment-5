import { INestApplication } from "@nestjs/common";
import { Queue } from "bullmq";
import request from "supertest";
import type { App } from "supertest/types";

import { PayrollEventStatus } from "../src/generated/prisma/enums";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  createApi,
  drainQueue,
  resetDatabase,
  uniqueEmployee,
} from "./helpers";

/**
 * Functional API tests: real Postgres and real Redis, no worker running.
 * They cover the synchronous half of the contract — validation, persistence,
 * idempotency, and the shape of the status response.
 */
describe("Events API (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue;

  beforeAll(async () => {
    ({ app, prisma, queue } = await createApi());
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await drainQueue(queue);
  });

  afterAll(async () => {
    await drainQueue(queue);
    await app.close();
  });

  const valid = (employeeId: string) => ({
    type: "SALARY_CHANGE",
    employeeId,
    effectiveDate: "2026-09-01",
    payload: { newSalary: 65000, currency: "EUR" },
  });

  it("accepts a valid event with 202 and does not process it inline", async () => {
    const employeeId = uniqueEmployee();

    const res = await request(app.getHttpServer() as App)
      .post("/api/events")
      .send(valid(employeeId))
      .expect(202);

    expect(res.body).toMatchObject({
      status: PayrollEventStatus.ACCEPTED,
      duplicate: false,
      employeeId,
    });

    // The response returns before any processing: still ACCEPTED in the DB.
    const row = await prisma.payrollEvent.findUniqueOrThrow({
      where: { id: res.body.id as string },
    });
    expect(row.status).toBe(PayrollEventStatus.ACCEPTED);

    // ...and a job exists for it, keyed by the event id.
    expect(await queue.getJob(row.id)).toBeDefined();
  });

  it("records an ACCEPTED transition for the audit trail", async () => {
    const res = await request(app.getHttpServer() as App)
      .post("/api/events")
      .send(valid(uniqueEmployee()))
      .expect(202);

    const detail = await request(app.getHttpServer() as App)
      .get(`/api/events/${res.body.id}`)
      .expect(200);

    expect(detail.body.transitions).toHaveLength(1);
    expect(detail.body.transitions[0].toStatus).toBe(
      PayrollEventStatus.ACCEPTED,
    );
  });

  describe("validation", () => {
    it("rejects an unknown event type", async () => {
      await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({ ...valid(uniqueEmployee()), type: "EMPLOYEE_TERMINATION" })
        .expect(400);
    });

    it("rejects a payload missing a required field", async () => {
      await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({
          ...valid(uniqueEmployee()),
          payload: { newSalary: 65000 },
        })
        .expect(400);
    });

    it("rejects unknown properties on the envelope", async () => {
      await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({ ...valid(uniqueEmployee()), sneaky: true })
        .expect(400);
    });

    it("rejects a malformed effectiveDate", async () => {
      await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({ ...valid(uniqueEmployee()), effectiveDate: "yesterday" })
        .expect(400);
    });
  });

  describe("duplicate submissions", () => {
    it("returns 200 and the original event when the same body is retried", async () => {
      const body = valid(uniqueEmployee());

      const first = await request(app.getHttpServer() as App)
        .post("/api/events")
        .send(body)
        .expect(202);

      const second = await request(app.getHttpServer() as App)
        .post("/api/events")
        .send(body)
        .expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.duplicate).toBe(true);
      expect(await prisma.payrollEvent.count()).toBe(1);
    });

    it("deduplicates concurrent identical submissions", async () => {
      const body = valid(uniqueEmployee());

      // Simulates a client retrying before the first response arrived: both
      // requests race past the lookup, and the unique index decides.
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer() as App)
            .post("/api/events")
            .send(body),
        ),
      );

      const ids = new Set(responses.map((r) => r.body.id));
      expect(ids.size).toBe(1);
      expect(await prisma.payrollEvent.count()).toBe(1);
    });

    it("treats a different salary for the same employee as a new event", async () => {
      const employeeId = uniqueEmployee();

      await request(app.getHttpServer() as App)
        .post("/api/events")
        .send(valid(employeeId))
        .expect(202);

      await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({
          ...valid(employeeId),
          payload: { newSalary: 70000, currency: "EUR" },
        })
        .expect(202);

      expect(await prisma.payrollEvent.count()).toBe(2);
    });

    it("honours an explicit idempotency key across different bodies", async () => {
      const employeeId = uniqueEmployee();
      const idempotencyKey = `key-${Date.now()}`;

      const first = await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({ ...valid(employeeId), idempotencyKey })
        .expect(202);

      const second = await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({
          ...valid(employeeId),
          payload: { newSalary: 99000, currency: "EUR" },
          idempotencyKey,
        })
        .expect(200);

      expect(second.body.id).toBe(first.body.id);
    });
  });

  describe("retrieval", () => {
    it("returns 404 for an unknown event", async () => {
      await request(app.getHttpServer() as App)
        .get("/api/events/3f1a9c5e-0000-4000-8000-000000000000")
        .expect(404);
    });

    it("returns 400 for a malformed id", async () => {
      await request(app.getHttpServer() as App)
        .get("/api/events/not-a-uuid")
        .expect(400);
    });

    it("assigns increasing sequence numbers in accept order", async () => {
      const employeeId = uniqueEmployee();

      const a = await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({
          ...valid(employeeId),
          payload: { newSalary: 1000, currency: "EUR" },
        });
      const b = await request(app.getHttpServer() as App)
        .post("/api/events")
        .send({
          ...valid(employeeId),
          payload: { newSalary: 2000, currency: "EUR" },
        });

      expect(b.body.sequence).toBeGreaterThan(a.body.sequence);
    });
  });

  describe("health", () => {
    it("reports both dependencies as up", async () => {
      const res = await request(app.getHttpServer() as App)
        .get("/api/health")
        .expect(200);

      expect(res.body.status).toBe("ok");
      expect(res.body.checks.database.status).toBe("up");
      expect(res.body.checks.redis.status).toBe("up");
    });
  });
});
