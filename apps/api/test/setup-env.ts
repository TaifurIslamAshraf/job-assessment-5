import "dotenv/config";

// Deterministic provider: failure scenarios are injected per-test, never random.
process.env.PAYROLL_FAILURE_RATE = "0";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
process.env.NODE_ENV = "test";
