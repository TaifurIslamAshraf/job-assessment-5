import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ClassConstructor, plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { createHash } from "node:crypto";

import { PayrollEvent, Prisma } from "../generated/prisma/client";
import {
  PayrollEventStatus,
  PayrollEventType,
} from "../generated/prisma/enums";
import { RETRIES_EXHAUSTED } from "../payroll/payroll.errors";
import { PrismaService } from "../prisma/prisma.service";
import { PayrollQueueService } from "../queue/payroll-queue.service";
import { CreateEventDto } from "./dto/create-event.dto";
import { PAYLOAD_SCHEMAS } from "./dto/payloads";

export interface SubmitResult {
  event: PayrollEvent;
  /** False when an existing event was returned for a repeated submission. */
  created: boolean;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PayrollQueueService,
    private readonly config: ConfigService,
  ) {}

  async submit(dto: CreateEventDto): Promise<SubmitResult> {
    const payload = this.validatePayload(dto.type, dto.payload);
    const idempotencyKey = dto.idempotencyKey ?? this.deriveIdempotencyKey(dto);

    const existing = await this.prisma.payrollEvent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      this.logger.log(
        `Duplicate submission for key ${idempotencyKey}; returning event ${existing.id}`,
      );
      // Re-enqueue is safe: the job id equals the event id, so BullMQ drops it
      // if the job still exists, and the worker no-ops on a finished event.
      await this.enqueue(existing);
      return { event: existing, created: false };
    }

    let event: PayrollEvent;
    try {
      event = await this.prisma.$transaction(async (tx) => {
        const created = await tx.payrollEvent.create({
          data: {
            idempotencyKey,
            employeeId: dto.employeeId,
            type: dto.type,
            effectiveDate: new Date(dto.effectiveDate),
            payload: payload as Prisma.InputJsonValue,
          },
        });

        await tx.payrollEventTransition.create({
          data: {
            eventId: created.id,
            toStatus: PayrollEventStatus.ACCEPTED,
            message: "Event accepted and queued for processing",
          },
        });

        return created;
      });
    } catch (error) {
      // Two concurrent retries of the same request can both pass the lookup
      // above; the unique index is the real guarantee.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await this.prisma.payrollEvent.findUniqueOrThrow({
          where: { idempotencyKey },
        });
        return { event: winner, created: false };
      }
      throw error;
    }

    this.logger.log(
      `Event accepted id=${event.id} type=${event.type} employee=${event.employeeId} seq=${event.sequence}`,
    );

    await this.enqueue(event);

    return { event, created: true };
  }

  async findOne(
    id: string,
  ): Promise<PayrollEvent & { transitions: unknown[] }> {
    const event = await this.prisma.payrollEvent.findUnique({
      where: { id },
      include: { transitions: { orderBy: { createdAt: "asc" } } },
    });

    if (!event) {
      throw new NotFoundException(`Payroll event ${id} not found`);
    }

    return event;
  }

  async findMany(params: {
    employeeId?: string;
    status?: PayrollEventStatus;
    take: number;
    skip: number;
  }): Promise<{ items: PayrollEvent[]; total: number }> {
    const where: Prisma.PayrollEventWhereInput = {
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
      ...(params.status ? { status: params.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.payrollEvent.findMany({
        where,
        orderBy: { sequence: "desc" },
        take: params.take,
        skip: params.skip,
      }),
      this.prisma.payrollEvent.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Operator action on a dead-lettered event: put it back on the queue with a
   * fresh attempt budget.
   */
  async retry(id: string, force: boolean): Promise<PayrollEvent> {
    const event = await this.prisma.payrollEvent.findUnique({ where: { id } });

    if (!event) {
      throw new NotFoundException(`Payroll event ${id} not found`);
    }

    if (event.status !== PayrollEventStatus.FAILED) {
      throw new ConflictException(
        `Event ${id} is ${event.status}; only a FAILED event can be retried`,
      );
    }

    // A permanent failure will be rejected the same way again, so retrying it
    // has to be a deliberate choice rather than the default.
    if (!force && event.failureCode !== RETRIES_EXHAUSTED) {
      throw new ConflictException(
        `Event ${id} failed permanently (${event.failureCode}); retrying will not help. Pass force=true to retry anyway.`,
      );
    }

    // `attempts` counts total effort and is never reset, so the budget has to
    // be raised instead — otherwise the event is exhausted on arrival.
    const maxAttempts =
      event.attempts + (this.config.get<number>("MAX_ATTEMPTS") ?? 5);

    const claimed = await this.prisma.payrollEvent.updateMany({
      where: { id, status: PayrollEventStatus.FAILED },
      data: {
        status: PayrollEventStatus.PENDING_RETRY,
        maxAttempts,
        failureCode: null,
        failureReason: null,
        completedAt: null,
        lockedBy: null,
        lockedAt: null,
      },
    });

    // Two operators clicking retry at once: only the first moves the row, and
    // the loser must not enqueue a second job.
    if (claimed.count === 0) {
      throw new ConflictException(`Event ${id} is already being retried`);
    }

    await this.prisma.payrollEventTransition.create({
      data: {
        eventId: id,
        fromStatus: PayrollEventStatus.FAILED,
        toStatus: PayrollEventStatus.PENDING_RETRY,
        attempt: event.attempts,
        message: "Manual retry requested",
        metadata: {
          force,
          previousFailureCode: event.failureCode,
        } as Prisma.InputJsonObject,
      },
    });

    await this.queue.reenqueue("retry", id, event.employeeId, {
      attempts: maxAttempts,
    });

    this.logger.log(
      `Manual retry queued for event ${id} (attempts ${event.attempts}/${maxAttempts}, force=${force})`,
    );

    return this.prisma.payrollEvent.findUniqueOrThrow({ where: { id } });
  }

  /**
   * The job id is the event id, which makes enqueueing idempotent: a duplicate
   * submission or a replayed request cannot produce two jobs for one event.
   */
  private async enqueue(event: PayrollEvent): Promise<void> {
    await this.queue.enqueue(event.type, event.id, event.employeeId);
  }

  /**
   * Validates `payload` against the class registered for `type`. Done here
   * rather than in the ValidationPipe because the target class depends on a
   * sibling property's value.
   */
  private validatePayload(
    type: PayrollEventType,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = PAYLOAD_SCHEMAS[type];
    if (!schema) {
      throw new BadRequestException(`Unsupported event type: ${type}`);
    }

    // The union of payload classes has no common shape, so the constructor is
    // widened here; validateSync below is what actually enforces the schema.
    const instance = plainToInstance(
      schema as ClassConstructor<object>,
      payload,
      { excludeExtraneousValues: false },
    );

    const errors = validateSync(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      throw new BadRequestException({
        message: errors.flatMap((e) =>
          Object.values(e.constraints ?? {}).map((c) => `payload.${c}`),
        ),
        error: "Bad Request",
        statusCode: 400,
      });
    }

    return instance as unknown as Record<string, unknown>;
  }

  /**
   * Without a client-supplied key, the business content itself identifies the
   * request. Two identical submissions are the same change; a different
   * salary for the same employee and date is a different one.
   */
  private deriveIdempotencyKey(dto: CreateEventDto): string {
    const canonical = JSON.stringify({
      type: dto.type,
      employeeId: dto.employeeId,
      effectiveDate: dto.effectiveDate,
      payload: sortKeys(dto.payload),
    });

    return createHash("sha256").update(canonical).digest("hex");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
