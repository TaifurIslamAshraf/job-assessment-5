-- CreateEnum
CREATE TYPE "PayrollEventType" AS ENUM ('BANK_ACCOUNT_CHANGE', 'ADDRESS_CHANGE', 'SALARY_CHANGE');

-- CreateEnum
CREATE TYPE "PayrollEventStatus" AS ENUM ('ACCEPTED', 'PROCESSING', 'PENDING_RETRY', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "PayrollEvent" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "PayrollEventType" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PayrollEventStatus" NOT NULL DEFAULT 'ACCEPTED',
    "sequence" SERIAL NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "result" JSONB,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollEventTransition" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "fromStatus" "PayrollEventStatus",
    "toStatus" "PayrollEventStatus" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollEventTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeePayrollProfile" (
    "employeeId" TEXT NOT NULL,
    "iban" TEXT,
    "street" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "salaryAmount" DECIMAL(12,2),
    "salaryCurrency" TEXT,
    "lastAppliedSequence" INTEGER,
    "lastAppliedEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeePayrollProfile_pkey" PRIMARY KEY ("employeeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEvent_idempotencyKey_key" ON "PayrollEvent"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEvent_sequence_key" ON "PayrollEvent"("sequence");

-- CreateIndex
CREATE INDEX "PayrollEvent_employeeId_sequence_idx" ON "PayrollEvent"("employeeId", "sequence");

-- CreateIndex
CREATE INDEX "PayrollEvent_status_sequence_idx" ON "PayrollEvent"("status", "sequence");

-- CreateIndex
CREATE INDEX "PayrollEventTransition_eventId_createdAt_idx" ON "PayrollEventTransition"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "PayrollEventTransition" ADD CONSTRAINT "PayrollEventTransition_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "PayrollEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
