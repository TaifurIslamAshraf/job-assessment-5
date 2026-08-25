# Payroll Event Processing Service

## Getting started

### Prerequisites

Node 18 or newer, pnpm 9, and Docker with the compose plugin. The versions are
pinned in the root `package.json` under `engines` and `packageManager`.

### Everything in Docker

```bash
git clone <repo> && cd job-assesment
docker compose up --build        # or: pnpm docker:up
```

That brings up Postgres, Redis, migrations, the API, one worker and the
frontend. Nothing else to install.

| Service  | URL                              |
| -------- | -------------------------------- |
| Frontend | http://localhost:3000            |
| API      | http://localhost:3001/api        |
| Swagger  | http://localhost:3001/api/docs   |
| Health   | http://localhost:3001/api/health |

The `migrate` service applies migrations and exits. Both `api` and `worker`
wait on it with `service_completed_successfully`, so neither can start against
a schema that isn't there yet.

To watch the multi-worker behaviour:

```bash
docker compose up --scale worker=3
```

Tear down with `docker compose down -v` (or `pnpm docker:down`). The `-v` drops
the Postgres and Redis volumes too, so you get a clean slate next time.

### Running it locally

Infrastructure in Docker, application processes on the host. This is the loop I
actually used while building it, because the API and worker restart in about a
second instead of rebuilding an image.

```bash
pnpm install

docker compose up -d postgres redis      # infrastructure only
cp apps/api/.env.example apps/api/.env   # already points at localhost

pnpm --filter api db:migrate             # create the schema, generate the client
```

Then three terminals:

```bash
pnpm --filter api dev          # API      :3001
pnpm --filter api dev:worker   # worker   (no HTTP server)
pnpm --filter web dev          # frontend :3000
```

Running the worker as its own process is the point, not a convenience. Stop the
API and queued events keep processing normally, which is the quickest way to
convince yourself that submission and processing really are decoupled.

### Database setup and migrations

Prisma, configured in
[`apps/api/prisma.config.ts`](apps/api/prisma.config.ts). The schema lives in
`prisma/schema.prisma` and migrations in `prisma/migrations/`.

| Command                         | What it does                                                             |
| ------------------------------- | ------------------------------------------------------------------------ |
| `pnpm db:migrate`               | Creates and applies a migration from schema changes, regenerates client. |
| `pnpm db:deploy`                | Applies existing migrations only. Used by Docker and CI.                 |
| `pnpm --filter api db:generate` | Regenerates the Prisma client without touching the database.             |
| `pnpm --filter api db:reset`    | Drops everything and replays migrations from scratch.                    |
| `pnpm db:studio`                | Opens Prisma Studio to poke at rows directly.                            |

---

## Environment variables

Everything is validated at boot in
[`src/config/env.validation.ts`](apps/api/src/config/env.validation.ts).

| Variable               | Default                 | Purpose                                                             |
| ---------------------- | ----------------------- | ------------------------------------------------------------------- |
| `NODE_ENV`             | `development`           | Switches log format (pretty vs JSON).                               |
| `DATABASE_URL`         | —                       | Postgres connection string. Required.                               |
| `REDIS_URL`            | —                       | Redis connection string. Required.                                  |
| `PORT`                 | `3001`                  | API listen port.                                                    |
| `WORKER_CONCURRENCY`   | `5`                     | Jobs one worker handles in parallel.                                |
| `MAX_ATTEMPTS`         | `5`                     | Attempts before an event is permanently FAILED.                     |
| `STALE_CLAIM_MS`       | `120000`                | How long a `PROCESSING` claim may sit before the sweep reclaims it. |
| `PAYROLL_FAILURE_RATE` | `0.25`                  | Chance the simulated provider fails (0–1).                          |
| `PAYROLL_LATENCY_MS`   | —                       | Pins provider latency instead of a random 200–1000ms.               |
| `LOG_LEVEL`            | `info`                  | pino level.                                                         |
| `API_ORIGIN`           | `http://localhost:3001` | Where the frontend proxies `/api/*`. Read at runtime.               |
| `NEXT_PUBLIC_API_URL`  | —                       | Optional build arg. Makes the browser call the API directly.        |

Turn `PAYROLL_FAILURE_RATE` up if you want to see retries and dead-lettering
without waiting for luck. The test suite pins it to `0` and injects failures
explicitly instead.

## Testing

```bash
pnpm --filter api test        # unit — no infrastructure needed
pnpm --filter api test:e2e    # functional + e2e — needs Postgres and Redis
```

| **Unit** | `src/**/*.spec.ts`
| **Functional** | `test/events.e2e-spec.ts`
| **End-to-end** | `test/processing.e2e-spec.ts`
| **End-to-end** | `test/retry.e2e-spec.ts`
| **End-to-end** | `test/profile.e2e-spec.ts`

---

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs three jobs:

- **static** does formatting, lint, types and build. No services, so it fails
  fast on the cheap problems.
- **test** spins up Postgres and Redis as service containers, applies
  migrations, then runs the unit and e2e suites. The reliability guarantees only
  hold against real infrastructure, so testing them against mocks would prove
  nothing worth knowing.
- **docker** builds both images and boots the whole compose stack, polling
  `/api/health` until it answers. `docker compose up` is the first thing a
  reviewer runs, so CI should be what finds out it is broken.

---

## Repository layout

```
apps/
  api/                  NestJS — API + worker (two entrypoints, one codebase)
    prisma/schema.prisma
    src/
      config/           env validation
      events/           controller, service, handlers, processor, recovery
      employees/        applied-state read model
      payroll/          simulated external provider + error taxonomy
      prisma/  redis/  queue/  health/
      main.ts           API entrypoint
      worker.ts         worker entrypoint
    test/               functional + e2e suites
  web/                  Next.js frontend
packages/               shared eslint / tsconfig / ui
scripts/demo-crash.sh   live worker-crash recovery demo
docker-compose.yml
.github/workflows/ci.yml
```
