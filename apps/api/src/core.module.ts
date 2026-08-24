import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";

import { validateEnv } from "./config/env.validation";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";

/**
 * Everything the API and the worker both need: validated config, structured
 * logging, Postgres and Redis. Imported by AppModule and WorkerModule alike.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [".env.local", ".env"],
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        // Human-readable locally, JSON lines in Docker/CI where a log shipper
        // would consume them.
        transport:
          process.env.NODE_ENV === "production"
            ? undefined
            : { target: "pino-pretty", options: { singleLine: true } },
        redact: {
          paths: ["req.headers.authorization", "req.headers.cookie"],
          remove: true,
        },
        autoLogging: { ignore: (req) => req.url === "/api/health" },
      },
    }),
    PrismaModule,
    RedisModule,
  ],
})
export class CoreModule {}
