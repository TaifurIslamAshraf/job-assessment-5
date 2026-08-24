import { PermanentPayrollError } from "../../payroll/payroll.errors";
import { HandlerContext } from "./event-handler.interface";
import { SalaryChangeHandler } from "./salary-change.handler";

/**
 * Unit test: no Nest container, no database. The handler is a pure function of
 * its context, which is exactly why the retry policy can be reasoned about.
 */
describe("SalaryChangeHandler", () => {
  const handler = new SalaryChangeHandler();

  const ctx = (payload: Record<string, unknown>): HandlerContext => ({
    eventId: "evt-1",
    employeeId: "emp-1",
    sequence: 1,
    effectiveDate: new Date("2026-09-01"),
    payload,
  });

  it("accepts a salary within the approval limit", () => {
    expect(() =>
      handler.validate(ctx({ newSalary: 65_000, currency: "EUR" })),
    ).not.toThrow();
  });

  it("rejects a salary above the approval limit as permanent", () => {
    // Permanent, not transient: no number of retries makes this succeed, so
    // the processor must dead-letter it on the first attempt.
    expect(() =>
      handler.validate(ctx({ newSalary: 2_000_000, currency: "EUR" })),
    ).toThrow(PermanentPayrollError);
  });

  it("maps the payload onto the profile mutation", () => {
    const mutation = handler.apply(ctx({ newSalary: 70_000, currency: "USD" }));

    expect(mutation.salaryCurrency).toBe("USD");
    expect(String(mutation.salaryAmount)).toBe("70000");
  });
});
