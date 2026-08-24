/**
 * The retry policy keys off these two classes, not off error messages.
 * A handler that throws anything else is treated as transient (unknown errors
 * get the benefit of the doubt until `maxAttempts` is exhausted).
 */

export class TransientPayrollError extends Error {
  readonly code: string;

  constructor(message: string, code = "PROVIDER_UNAVAILABLE") {
    super(message);
    this.name = "TransientPayrollError";
    this.code = code;
  }
}

/** Retrying will never help — e.g. business rules rejected the change. */
export class PermanentPayrollError extends Error {
  readonly code: string;

  constructor(message: string, code = "BUSINESS_RULE_VIOLATION") {
    super(message);
    this.name = "PermanentPayrollError";
    this.code = code;
  }
}

export function isPermanent(error: unknown): error is PermanentPayrollError {
  return error instanceof PermanentPayrollError;
}
