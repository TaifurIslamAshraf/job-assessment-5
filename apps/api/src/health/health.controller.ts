import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Redis } from "ioredis";

import { PrismaService } from "../prisma/prisma.service";
import { REDIS_CLIENT } from "../redis/redis.module";

type Check = { status: "up" | "down"; latencyMs?: number; error?: string };

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Checks both dependencies, because an API that cannot reach Postgres or
   * Redis cannot accept an event — reporting "up" would be misleading.
   * Returns 503 when either is down so an orchestrator can act on it.
   */
  @Get()
  @ApiOperation({ summary: "Liveness and dependency readiness" })
  @ApiOkResponse({ description: "All dependencies reachable." })
  async check() {
    const [database, redis] = await Promise.all([
      this.timed(() => this.prisma.$queryRaw`SELECT 1`),
      this.timed(() => this.redis.ping()),
    ]);

    const body = {
      status:
        database.status === "up" && redis.status === "up" ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database, redis },
    };

    if (body.status !== "ok") {
      throw new ServiceUnavailableException(body);
    }

    return body;
  }

  private async timed(fn: () => Promise<unknown>): Promise<Check> {
    const start = Date.now();
    try {
      await fn();
      return { status: "up", latencyMs: Date.now() - start };
    } catch (error) {
      return { status: "down", error: (error as Error).message };
    }
  }
}
