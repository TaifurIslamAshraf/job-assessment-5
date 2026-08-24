import { ApiProperty } from "@nestjs/swagger";
import {
  IsIn,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

/**
 * One class per event type. `PAYLOAD_SCHEMAS` below is the single place a new
 * event type gets registered for validation — adding EMPLOYEE_TERMINATION means
 * adding a class here and a handler in `processors/`, nothing else.
 */

export class BankAccountChangePayload {
  @ApiProperty({ example: "DE89370400440532013000" })
  @IsString()
  @Matches(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, {
    message: "iban must be a valid IBAN",
  })
  iban!: string;
}

export class AddressChangePayload {
  @ApiProperty({ example: "Hauptstrasse 12" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  street!: string;

  @ApiProperty({ example: "Berlin" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @ApiProperty({ example: "10115" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  postalCode!: string;

  @ApiProperty({
    example: "DE",
    description: "ISO 3166-1 alpha-2 country code",
  })
  @IsISO31661Alpha2()
  country!: string;
}

export class SalaryChangePayload {
  @ApiProperty({ example: 65000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  newSalary!: number;

  @ApiProperty({ example: "EUR", enum: ["EUR", "USD", "GBP", "CHF"] })
  @IsIn(["EUR", "USD", "GBP", "CHF"])
  currency!: string;
}

export const PAYLOAD_SCHEMAS = {
  BANK_ACCOUNT_CHANGE: BankAccountChangePayload,
  ADDRESS_CHANGE: AddressChangePayload,
  SALARY_CHANGE: SalaryChangePayload,
} as const;

export type PayloadSchemaMap = typeof PAYLOAD_SCHEMAS;
