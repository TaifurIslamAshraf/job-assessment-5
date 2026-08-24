import { plainToInstance, Transform } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsString,
  Max,
  Min,
  validateSync,
} from "class-validator";

export enum NodeEnv {
  Development = "development",
  Test = "test",
  Production = "production",
}

/**
 * Fail fast on a misconfigured environment: a missing DATABASE_URL should stop
 * the process at boot, not surface as a confusing error on the first request.
 */
export class EnvConfig {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  REDIS_URL!: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3001;

  /** Jobs a single worker process handles in parallel (across employees). */
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  WORKER_CONCURRENCY: number = 5;

  /** Attempts BullMQ makes before an event is treated as permanently failed. */
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  MAX_ATTEMPTS: number = 5;

  /**
   * Probability the simulated payroll provider throws a transient error.
   * Set to 0 in tests for deterministic behavior.
   */
  @Transform(({ value }) => Number(value))
  @Min(0)
  @Max(1)
  PAYROLL_FAILURE_RATE: number = 0.25;

  @IsString()
  LOG_LEVEL: string = "info";
}

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const config = plainToInstance(EnvConfig, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(", ")}`,
      )
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return config;
}
