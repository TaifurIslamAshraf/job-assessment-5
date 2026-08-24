import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";

import { PayrollEventStatus } from "../generated/prisma/enums";
import { CreateEventDto } from "./dto/create-event.dto";
import { EventsService } from "./events.service";

@ApiTags("events")
@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Submit a payroll event",
    description:
      "Validates and persists the event, then queues it. Returns immediately — " +
      "processing happens in the worker. A repeated submission of the same " +
      "business content returns 200 with the original event instead of 202.",
  })
  @ApiCreatedResponse({ description: "Event accepted for processing (202)." })
  async create(
    @Body() dto: CreateEventDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { event, created } = await this.events.submit(dto);

    // 202 for a newly accepted event, 200 when an existing one was returned,
    // so a client can tell a duplicate apart without inspecting the body.
    res.status(created ? HttpStatus.ACCEPTED : HttpStatus.OK);

    return {
      id: event.id,
      status: event.status,
      type: event.type,
      employeeId: event.employeeId,
      sequence: event.sequence,
      idempotencyKey: event.idempotencyKey,
      duplicate: !created,
      acceptedAt: event.acceptedAt,
    };
  }

  @Get()
  @ApiOperation({ summary: "List submitted events, newest first" })
  @ApiQuery({ name: "employeeId", required: false })
  @ApiQuery({ name: "status", required: false, enum: PayrollEventStatus })
  @ApiQuery({ name: "take", required: false, example: 25 })
  @ApiQuery({ name: "skip", required: false, example: 0 })
  async findAll(
    @Query("employeeId") employeeId?: string,
    @Query("status", new ParseEnumPipe(PayrollEventStatus, { optional: true }))
    status?: PayrollEventStatus,
    @Query("take", new DefaultValuePipe(25), ParseIntPipe) take = 25,
    @Query("skip", new DefaultValuePipe(0), ParseIntPipe) skip = 0,
  ) {
    return this.events.findMany({
      employeeId,
      status,
      take: Math.min(take, 100),
      skip,
    });
  }

  @Get(":id")
  @ApiOperation({
    summary: "Fetch one event with its full transition history",
  })
  @ApiOkResponse({
    description: "The event, its status, result and audit trail.",
  })
  @ApiNotFoundResponse({ description: "No event with that id." })
  async findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.events.findOne(id);
  }
}
