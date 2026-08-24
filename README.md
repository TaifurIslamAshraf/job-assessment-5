# Payroll Event Processing Service

A backend service that accepts employee payroll change events over HTTP and
processes them asynchronously through a Redis/BullMQ queue, with a minimal
Next.js frontend for demonstrating the behavior.

The engineering problem here is not the payroll math — it is staying correct
when the external system is slow and flaky, when clients retry, when multiple
workers compete, and when a worker dies mid-flight.

---

## Architecture

```
                 ┌──────────────┐
                 │   Frontend   │  Next.js · :3000
                 │  (apps/web)  │  submit · list · inspect · poll
                 └──────┬───────┘
                        │ HTTP (JSON)
                        ▼
┌───────────────────────────────────────────────────────┐
│                  API  ·  NestJS  :3001                │
│                    (apps/api → main.ts)               │
│                                                       │
│  POST /api/events   validate → persist → enqueue → 202│
│  GET  /api/events   list                              │
│  GET  /api/events/:id   status + result + audit trail │
│  GET  /api/health   Postgres + Redis probe            │
└───────┬───────────────────────────────┬───────────────┘
        │ write (source of truth)       │ enqueue (jobId = event.id)
        ▼                               ▼
┌───────────────────┐          ┌──────────────────┐
│    PostgreSQL     │          │      Redis       │
│                   │          │    (BullMQ)      │
│ payroll_event     │◄────┐    │  payroll-events  │
│ ..._transition    │     │    └────────┬─────────┘
│ employee_profile  │     │             │ consume
└───────────────────┘     │             ▼
                          │   ┌────────────────────────────┐
                          └───┤  Worker · NestJS standalone│
                    read+write│    (apps/api → worker.ts)  │
                              │                            │
                              │  1 already finished? no-op │
                              │  2 earlier event open?     │
                              │      → delay, keep order   │
                              │  3 claim (compare-and-set) │
                              │  4 handler.validate()      │
                              │  5 provider.submit()  ←── simulated,
                              │  6 TX: apply + SUCCEEDED       slow, flaky
                              │  7 recovery sweep (30s)    │
                              └────────────────────────────┘
```

The API and the worker are **the same codebase with two entrypoints**
(`src/main.ts`, `src/worker.ts`) sharing `CoreModule` and `EventsModule`. The
API registers no BullMQ processor, so scaling the API never scales consumers,
and background work never depends on an open HTTP request.

### Event lifecycle

```
                    ┌──────────────────────────────┐
   POST /events     │                              │
        │           ▼                              │
        └──────► ACCEPTED ──► PROCESSING ──► SUCCEEDED
                    ▲             │
                    │             ├──► PENDING_RETRY ──┘  (transient, backoff)
                    │             │
                    │             └──► FAILED             (permanent, or
                    │                                      attempts exhausted)
                    └── recovery sweep releases a stale
                        PROCESSING claim from a dead worker
```

---

## Quick start

```bash
git clone <repo> && cd job-assesment
docker compose up --build
```

That starts Postgres, Redis, migrations, the API, a worker, and the frontend.

| Service  | URL                              |
| -------- | -------------------------------- |
| Frontend | http://localhost:3000            |
| API      | http://localhost:3001/api        |
| Swagger  | http://localhost:3001/api/docs   |
| Health   | http://localhost:3001/api/health |

The `migrate` service applies migrations and exits; `api` and `worker` both
wait for it via `service_completed_successfully`, so neither ever starts
against a schema that does not exist.

To exercise the multi-worker guarantees:

```bash
docker compose up --scale worker=3
```

### Local development (without Docker)

```bash
pnpm install
docker compose up -d postgres redis     # just the infrastructure
cp apps/api/.env.example apps/api/.env

pnpm --filter api db:migrate            # create the schema
pnpm --filter api dev                   # API   :3001
pnpm --filter api dev:worker            # worker (separate terminal)
pnpm --filter web dev                   # frontend :3000
```

---

## Environment variables

Defined and validated in [`src/config/env.validation.ts`](apps/api/src/config/env.validation.ts).
The process refuses to boot on an invalid value rather than failing on the
first request.

| Variable               | Default                     | Purpose                                         |
| ---------------------- | --------------------------- | ----------------------------------------------- |
| `NODE_ENV`             | `development`               | Switches log format (pretty vs JSON).           |
| `DATABASE_URL`         | —                           | Postgres connection string. **Required.**       |
| `REDIS_URL`            | —                           | Redis connection string. **Required.**          |
| `PORT`                 | `3001`                      | API listen port.                                |
| `WORKER_CONCURRENCY`   | `5`                         | Jobs one worker handles in parallel.            |
| `MAX_ATTEMPTS`         | `5`                         | Attempts before an event is permanently FAILED. |
| `PAYROLL_FAILURE_RATE` | `0.25`                      | Chance the simulated provider fails (0–1).      |
| `LOG_LEVEL`            | `info`                      | pino level.                                     |
| `NEXT_PUBLIC_API_URL`  | `http://localhost:3001/api` | Baked into the frontend bundle at build time.   |

Raise `PAYROLL_FAILURE_RATE` to make retries and dead-lettering easy to
demonstrate; the test suite pins it to `0` and injects failures explicitly.

---

## Database design

Three tables, in [`prisma/schema.prisma`](apps/api/prisma/schema.prisma).

**`PayrollEvent`** — the submitted request and its processing state.

- `idempotencyKey` (unique) — what makes duplicate submission impossible.
- `payload` (JSONB) — type-specific fields. A new event type needs no migration.
- `sequence` (unique, autoincrement) — the order the system _accepted_ events,
  which is what ordering is defined against. Queue arrival order is not
  trustworthy once retries and delays are involved.
- `lockedBy` / `lockedAt` — who is processing it and since when, so an
  abandoned claim is detectable.
- `failureCode` / `failureReason` — why it failed, in terms an engineer can act on.

**`PayrollEventTransition`** — append-only audit trail, one row per state
change. Never updated, so the history cannot be rewritten by a later attempt.

**`EmployeePayrollProfile`** — the state events actually mutate: the projection
standing in for the external payroll system. `lastAppliedSequence` records
which event last wrote it.

### Why a JSONB payload instead of a table per event type

Three tables of near-identical shape, joined by type, would make adding
`BONUS_PAYMENT` a migration plus a join plus a repository change. With JSONB
plus a per-type validation class, adding an event type touches three files and
no SQL. The trade-off is that Postgres no longer enforces payload shape — which
is why validation is strict at the boundary and the payload is validated again
against its type before it is ever persisted.

---

## How each reliability requirement is met

### Duplicate requests (#5)

`idempotencyKey` is unique. A client may supply one; otherwise the service
derives it as `sha256(type + employeeId + effectiveDate + canonical(payload))`,
so a plain retry of the same body is recognized without the client doing
anything.

A repeated submission returns **200** with the original event; a new one
returns **202**. Two _concurrent_ retries can both pass the pre-check, so the
unique index — not the lookup — is the real guarantee: the loser catches
`P2002` and returns the winner's event.

The queue is deduplicated the same way: `jobId` is the event id, so one event
can never have two jobs.

### Temporary vs permanent failure (#4)

Two error classes, in [`payroll.errors.ts`](apps/api/src/payroll/payroll.errors.ts):

- `TransientPayrollError` → status `PENDING_RETRY`, rethrown so BullMQ retries
  with exponential backoff. Becomes `FAILED` only once `MAX_ATTEMPTS` is spent,
  with `failureCode = RETRIES_EXHAUSTED`.
- `PermanentPayrollError` → straight to `FAILED` on the first attempt, and the
  job is _completed_ rather than thrown, because further retries are waste.

Business validation runs _before_ the provider call, so a permanent rejection
never costs a network round trip. Unrecognized errors are treated as transient —
an unknown failure gets the benefit of the doubt.

### Multiple workers (#6)

Claiming is a compare-and-set:

```ts
updateMany({
  where: { id, status: { in: [ACCEPTED, PENDING_RETRY] } },
  data: { status: PROCESSING, attempts: { increment: 1 }, lockedBy, lockedAt },
});
```

Postgres serializes the two updates; exactly one gets `count === 1` and
proceeds. The other yields. No distributed lock, no Redis lock — the row is
already the shared resource.

### Processing consistency after a crash (#8)

The profile write and the flip to `SUCCEEDED` happen **in one transaction**.
There is therefore no window where the change is applied but the event is not
marked done. A redelivered job sees a finished event and no-ops.

Belt and braces: the transaction also refuses to write when
`profile.lastAppliedSequence >= event.sequence`, so even a doubly-executed
transaction cannot apply the same change twice or resurrect a superseded one.

### Ordering per employee (#9)

Before claiming, the worker asks: _is any event for this employee with a lower
`sequence` still open?_ If so it calls `job.moveToDelayed()` and throws
`DelayedError` — which puts the job back **without consuming a retry attempt**,
the reason this is not simply a thrown error.

Different employees never block each other, so throughput stays parallel;
`WORKER_CONCURRENCY` controls how parallel.

### Worker failure and recovery (#7)

BullMQ's stalled-job detection recovers the _job_. That leaves the _row_ stuck
in `PROCESSING`, so [`RecoveryService`](apps/api/src/events/recovery.service.ts)
sweeps every 30 seconds and:

1. releases `PROCESSING` rows whose `lockedAt` is older than 2 minutes back to
   `PENDING_RETRY`, recording a `WORKER_LOST` transition, and re-enqueues them;
2. re-enqueues rows that are ready to run but have no job in Redis — the gap
   that opens if the process dies between `COMMIT` and `queue.add`.

The sweeper runs only in the worker process.

### Extensibility (#10)

Adding `BONUS_PAYMENT` means:

1. a payload class in `dto/payloads.ts`, registered in `PAYLOAD_SCHEMAS`;
2. a handler implementing `PayrollEventHandler`;
3. one line in `HandlerRegistry`'s constructor and the Prisma enum.

The queue, worker loop, retry policy, ordering logic, API and audit trail are
untouched. Handlers are pure — `apply()` returns the mutation instead of
performing it — precisely so the caller can keep it inside the success
transaction.

---

## API

Swagger UI at `/api/docs`, OpenAPI JSON at `/api/docs-json`.

```bash
# Submit
curl -X POST http://localhost:3001/api/events \
  -H 'content-type: application/json' \
  -d '{
        "type": "SALARY_CHANGE",
        "employeeId": "emp-1001",
        "effectiveDate": "2026-09-01",
        "payload": { "newSalary": 65000, "currency": "EUR" }
      }'
# → 202 {"id":"…","status":"ACCEPTED","sequence":1,"duplicate":false}

# The same call again → 200 with duplicate:true and the same id.

# Status, result and audit trail
curl http://localhost:3001/api/events/<id>

# Health
curl http://localhost:3001/api/health
```

Demo a permanent failure with `"newSalary": 2000000` (above the approval
limit), and an invalid request with `"currency": "XYZ"`.

---

## Testing

```bash
pnpm --filter api test        # unit — no infrastructure needed
pnpm --filter api test:e2e    # functional + e2e — needs Postgres and Redis
```

| Layer          | Where                         | What it proves                                                                                                                                                                                                                                                     |
| -------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Unit**       | `src/**/*.spec.ts`            | Handler business rules; idempotency-key derivation; per-type payload validation. Prisma and BullMQ are doubles, so these are fast and deterministic.                                                                                                               |
| **Functional** | `test/events.e2e-spec.ts`     | The HTTP contract against real Postgres and Redis, with **no worker running** — which is what proves submission does not process inline. Validation, 202 vs 200, concurrent deduplication, 404/400.                                                                |
| **End-to-end** | `test/processing.e2e-spec.ts` | API + worker + both datastores in one process. Successful processing, result persistence, transient retry then success, permanent failure without retry, dead-lettering, duplicate applied once, redelivery no-op, per-employee ordering, crashed-worker recovery. |

The provider is stubbed per test rather than left random — a randomly failing
dependency makes for a flaky suite, and each failure mode deserves its own
deterministic test. `PAYROLL_FAILURE_RATE=0` is set in `test/setup-env.ts`.

E2E runs with `maxWorkers: 1`: the tests share one Postgres and one Redis, and
parallel suites would interfere with each other's queue state.

---

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs three jobs:

- **static** — formatting, lint, types, build. No services, so it fails fast.
- **test** — spins up Postgres and Redis as service containers, applies
  migrations, then runs unit and e2e suites. The reliability guarantees only
  hold against real infrastructure, so testing them against mocks would prove
  nothing.
- **docker** — builds both images and boots the whole compose stack, polling
  `/api/health` until it answers. `docker compose up` is the first thing a
  reviewer runs; CI should be what discovers it is broken.

---

## Trade-offs and things I would do differently at scale

- **Ordering via a delay loop.** A blocked job is re-delayed 500ms at a time.
  Simple and correct, but it burns a Redis round trip per check. At high volume
  I would use BullMQ Pro's job groups, or one queue partitioned by
  `hash(employeeId)` so a single consumer owns each employee and ordering is
  structural rather than checked.

- **Polling frontend.** The UI polls every 2s. SSE or WebSockets would be
  better, but polling is fewer moving parts for a demo, and the requirement is
  that state changes are _observable_, not instant.

- **Runtime image copies the whole `/app` tree.** pnpm's symlinked
  `node_modules` only resolves inside the workspace root. `pnpm deploy` would
  produce a smaller image; I chose the predictable option over the small one.

- **The recovery sweep is a fixed 30s cron with a 2-minute staleness window.**
  Both should be config, and at scale the sweep should be leader-elected rather
  than run by every worker — currently N workers do N redundant scans.

- **`payload` as JSONB** trades database-level shape enforcement for
  extensibility. Justified above; the mitigation is strict boundary validation.

- **No authentication.** Explicitly out of scope. In production `POST /events`
  would be service-to-service authenticated, and `employeeId` would be
  authorization-checked rather than trusted from the body.

---

## Repository layout

```
apps/
  api/                  NestJS — API + worker (two entrypoints, one codebase)
    prisma/schema.prisma
    src/
      config/           env validation
      events/           controller, service, handlers, processor, recovery
      payroll/          simulated external provider + error taxonomy
      prisma/  redis/  queue/  health/
      main.ts           API entrypoint
      worker.ts         worker entrypoint
    test/               functional + e2e suites
  web/                  Next.js frontend
packages/               shared eslint / tsconfig / ui
docker-compose.yml
.github/workflows/ci.yml
```
