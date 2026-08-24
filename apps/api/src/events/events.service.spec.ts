import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";

import { PayrollEventType } from "../generated/prisma/enums";
import { PrismaService } from "../prisma/prisma.service";
import { PayrollQueueService } from "../queue/payroll-queue.service";
import { CreateEventDto } from "./dto/create-event.dto";
import { EventsService } from "./events.service";

/**
 * Unit test: Prisma and BullMQ are both doubles. This isolates the two
 * decisions that live in the service — per-type payload validation and
 * idempotency-key derivation — from anything I/O bound.
 */
describe("EventsService", () => {
  let service: EventsService;
  let prisma: {
    payrollEvent: { findUnique: jest.Mock; create: jest.Mock };
    payrollEventTransition: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let queue: { enqueue: jest.Mock };

  beforeEach(async () => {
    prisma = {
      payrollEvent: { findUnique: jest.fn(), create: jest.fn() },
      payrollEventTransition: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PayrollQueueService, useValue: queue },
        { provide: ConfigService, useValue: { get: () => 5 } },
      ],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  const dto = (overrides: Partial<CreateEventDto> = {}): CreateEventDto =>
    ({
      type: PayrollEventType.SALARY_CHANGE,
      employeeId: "emp-1001",
      effectiveDate: "2026-09-01",
      payload: { newSalary: 65_000, currency: "EUR" },
      ...overrides,
    }) as CreateEventDto;

  describe("payload validation", () => {
    it("rejects a payload missing a field the type requires", async () => {
      await expect(
        service.submit(dto({ payload: { newSalary: 65_000 } })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a payload belonging to a different event type", async () => {
      await expect(
        service.submit(
          dto({
            type: PayrollEventType.BANK_ACCOUNT_CHANGE,
            payload: { newSalary: 65_000, currency: "EUR" },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects an IBAN that fails the format check", async () => {
      await expect(
        service.submit(
          dto({
            type: PayrollEventType.BANK_ACCOUNT_CHANGE,
            payload: { iban: "not-an-iban" },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("idempotency", () => {
    it("returns the existing event instead of creating a second one", async () => {
      const existing = {
        id: "evt-1",
        employeeId: "emp-1001",
        type: "SALARY_CHANGE",
      };
      prisma.payrollEvent.findUnique.mockResolvedValue(existing);

      const result = await service.submit(dto());

      expect(result.created).toBe(false);
      expect(result.event).toBe(existing);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("derives the same key for two identical submissions", async () => {
      prisma.payrollEvent.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockResolvedValue({
        id: "evt-1",
        type: "SALARY_CHANGE",
        employeeId: "emp-1001",
        sequence: 1,
      });

      await service.submit(dto());
      const first = prisma.payrollEvent.findUnique.mock.calls[0][0].where
        .idempotencyKey as string;

      // Same content, keys written in a different order.
      await service.submit(
        dto({ payload: { currency: "EUR", newSalary: 65_000 } }),
      );
      const second = prisma.payrollEvent.findUnique.mock.calls[1][0].where
        .idempotencyKey as string;

      expect(second).toBe(first);
    });

    it("derives a different key when the business content differs", async () => {
      prisma.payrollEvent.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockResolvedValue({
        id: "evt-1",
        type: "SALARY_CHANGE",
        employeeId: "emp-1001",
        sequence: 1,
      });

      await service.submit(dto());
      await service.submit(
        dto({ payload: { newSalary: 70_000, currency: "EUR" } }),
      );

      const [a, b] = prisma.payrollEvent.findUnique.mock.calls.map(
        (c) => c[0].where.idempotencyKey as string,
      );
      expect(a).not.toBe(b);
    });
  });

  it("enqueues the accepted event by id", async () => {
    prisma.payrollEvent.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockResolvedValue({
      id: "evt-42",
      type: "SALARY_CHANGE",
      employeeId: "emp-1001",
      sequence: 7,
    });

    await service.submit(dto());

    expect(queue.enqueue).toHaveBeenCalledWith(
      "SALARY_CHANGE",
      "evt-42",
      "emp-1001",
    );
  });
});
