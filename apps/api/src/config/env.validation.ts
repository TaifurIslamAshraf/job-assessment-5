import { plainToInstance, Transform } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from "class-validator";

/** Keeps an unset optional variable undefined instead of turning it into NaN. */
const optionalNumber = ({ value }: { value: unknown }): number | undefined =>
  value === undefined || value === null || value === ""
    ? undefined
    : Number(value);

export enum NodeEnv {
  Development = "development",
  Test = "test",
  Production = "production",
}

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

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1_000)
  STALE_CLAIM_MS: number = 2 * 60 * 1000;

  @Transform(({ value }) => Number(value))
  @Min(0)
  @Max(1)
  PAYROLL_FAILURE_RATE: number = 0.25;

  @Transform(optionalNumber)
  @IsOptional()
  @IsInt()
  @Min(0)
  PAYROLL_LATENCY_MS?: number;

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
