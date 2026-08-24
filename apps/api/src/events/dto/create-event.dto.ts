import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

import { PayrollEventType } from "../../generated/prisma/enums";
import {
  AddressChangePayload,
  BankAccountChangePayload,
  SalaryChangePayload,
} from "./payloads";

/**
 * The envelope is validated by the global ValidationPipe; `payload` is
 * validated a second time against the schema for `type` in EventsService,
 * because class-validator cannot pick a nested class from a sibling property.
 */
export class CreateEventDto {
  @ApiProperty({
    enum: PayrollEventType,
    example: PayrollEventType.SALARY_CHANGE,
  })
  @IsEnum(PayrollEventType, {
    message: `type must be one of: ${Object.values(PayrollEventType).join(", ")}`,
  })
  type!: PayrollEventType;

  @ApiProperty({ example: "emp-1001" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  employeeId!: string;

  @ApiProperty({ example: "2026-09-01", format: "date" })
  @IsDateString()
  effectiveDate!: string;

  @ApiProperty({
    description: "Fields required by the chosen `type`.",
    oneOf: [
      { $ref: getSchemaPath(BankAccountChangePayload) },
      { $ref: getSchemaPath(AddressChangePayload) },
      { $ref: getSchemaPath(SalaryChangePayload) },
    ],
  })
  @IsObject()
  @Type(() => Object)
  payload!: Record<string, unknown>;

  /**
   * Optional; when omitted the service derives a stable key by hashing the
   * business content, so a client that simply retries the same body still
   * gets deduplicated.
   */
  @ApiPropertyOptional({
    description:
      "Client-supplied idempotency key. Omit to derive one from the request body.",
    example: "a1f4c2e8-1b7d-4f0a-9c3e-2d5b8a7f6e10",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}
