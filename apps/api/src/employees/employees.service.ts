import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

/**
 * The state payroll events actually mutate. Reading it back is what makes the
 * ordering and idempotency guarantees observable — the event list shows that
 * processing happened, this shows what it produced.
 */
export interface EmployeeProfileView {
  employeeId: string;
  iban: string | null;
  address: {
    street: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  salary: { amount: number; currency: string | null } | null;
  lastAppliedSequence: number | null;
  lastAppliedEventId: string | null;
  updatedAt: Date;
}

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findProfile(employeeId: string): Promise<EmployeeProfileView> {
    const profile = await this.prisma.employeePayrollProfile.findUnique({
      where: { employeeId },
    });

    if (!profile) {
      throw new NotFoundException(
        `No payroll profile for employee ${employeeId}. It is created by the first event that succeeds.`,
      );
    }

    const hasAddress =
      profile.street ?? profile.city ?? profile.postalCode ?? profile.country;

    return {
      employeeId: profile.employeeId,
      iban: profile.iban,
      address: hasAddress
        ? {
            street: profile.street,
            city: profile.city,
            postalCode: profile.postalCode,
            country: profile.country,
          }
        : null,
      salary:
        profile.salaryAmount === null
          ? null
          : {
              amount: Number(profile.salaryAmount),
              currency: profile.salaryCurrency,
            },
      lastAppliedSequence: profile.lastAppliedSequence,
      lastAppliedEventId: profile.lastAppliedEventId,
      updatedAt: profile.updatedAt,
    };
  }
}
