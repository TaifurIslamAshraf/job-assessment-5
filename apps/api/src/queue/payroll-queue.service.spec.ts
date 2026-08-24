import { getQueueToken } from "@nestjs/bullmq";
import { Test } from "@nestjs/testing";

import { PayrollQueueService } from "./payroll-queue.service";
import { PAYROLL_QUEUE } from "./queue.constants";

describe("PayrollQueueService", () => {
  let service: PayrollQueueService;
  let queue: { add: jest.Mock; getJob: jest.Mock };

  beforeEach(async () => {
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PayrollQueueService,
        { provide: getQueueToken(PAYROLL_QUEUE), useValue: queue },
      ],
    }).compile();

    service = moduleRef.get(PayrollQueueService);
  });

  it("uses the event id as the job id so redelivery cannot duplicate", async () => {
    await service.enqueue("SALARY_CHANGE", "evt-42", "emp-1001");

    expect(queue.add).toHaveBeenCalledWith(
      "SALARY_CHANGE",
      { eventId: "evt-42", employeeId: "emp-1001" },
      { jobId: "evt-42" },
    );
  });

  it("clears the finished job before re-enqueueing", async () => {
    // BullMQ ignores an add whose jobId is still in the completed set, so
    // skipping this makes the re-enqueue a silent no-op.
    const remove = jest.fn().mockResolvedValue(undefined);
    queue.getJob.mockResolvedValue({
      remove,
      getState: async () => "completed",
    });

    await service.reenqueue("retry", "evt-42", "emp-1001", { attempts: 10 });

    expect(remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      "retry",
      { eventId: "evt-42", employeeId: "emp-1001" },
      { attempts: 10, jobId: "evt-42" },
    );
  });

  it("re-enqueues even when the running worker refuses to release the job", async () => {
    queue.getJob.mockResolvedValue({
      remove: jest.fn().mockRejectedValue(new Error("job is active")),
      getState: async () => "active",
    });

    await expect(
      service.reenqueue("recovery", "evt-42", "emp-1001"),
    ).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalled();
  });

  it("does not count a finished job as backing the event", async () => {
    queue.getJob.mockResolvedValue({ getState: async () => "completed" });
    expect(await service.hasPendingJob("evt-42")).toBe(false);

    queue.getJob.mockResolvedValue({ getState: async () => "delayed" });
    expect(await service.hasPendingJob("evt-42")).toBe(true);
  });
});
