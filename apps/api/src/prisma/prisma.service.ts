import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";

/**
 * Prisma 7 runs the query compiler, so a driver adapter is required.
 * `PrismaPg` wraps a `pg` pool and owns its lifecycle.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>("DATABASE_URL");

    // Query logging only in development: production wants signal, and tests
    // would otherwise drown their own output in SQL.
    super({
      adapter: new PrismaPg({ connectionString }),
      log:
        config.get<string>("NODE_ENV") === "development"
          ? ["query", "warn", "error"]
          : ["warn", "error"],
    });
  }

  async onModuleInit(): Promise<void> {
    // `$connect` is lazy with a driver adapter, so probe to surface a bad
    // DATABASE_URL at boot instead of on the first request.
    await this.$connect();
    try {
      await this.$queryRaw`SELECT 1`;
      this.logger.log("Connected to Postgres");
    } catch (error) {
      this.logger.error(`Postgres is unreachable: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log("Disconnected from Postgres");
  }
}
