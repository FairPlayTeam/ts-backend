# Backend Architecture

> This document covers the backend runtime shape, deployment model, and authentication flow.

The backend is organized around small composable factories and dependencies are injected explicitly to improve testability.

## Overview

```mermaid
flowchart TD
index["src/index.ts<br/>Bootstrap runtime"] --> app["createApp()"]
index --> authInstance["auth.instance.ts"]
index --> cleanup["createMaintenanceCleanupJob()"]
index --> readiness["Readiness checks"]
index --> transcodeRunner["In-process transcode runner"]

authInstance --> authService["createAuthService()"]
authService --> prisma["Prisma"]
authService --> mailer["mailer"]
authService --> objectStorage["Object storage"]
authService --> crypto["Token / Hash"]
authService --> clock["clock"]

app --> routes["Auto-loaded routes"]
routes --> controller["AuthController"]
controller --> authService

app --> middleware["Middleware<br/>CORS, Helmet, Logger, Rate Limit"]
middleware --> redis["Redis optional, required in production"]
cleanup --> redisLock["Redis distributed lock<br/>when Redis is configured"]
index --> videoService["Video upload service"]
videoService --> videoStorage["Video object storage bucket"]
videoService --> externalTargets["Durable external resource targets"]
```

## Runtime modes

The backend supports three common runtime modes:

- local development: Bun runs on the host, while PostgreSQL, Redis, and MinIO provide local
  versions of the external infrastructure through Docker Compose
- local full stack: Docker Compose builds and runs the backend, the one-shot migrator, PostgreSQL,
  Redis, and MinIO on the same local Docker network
- production: the runtime image runs behind a reverse proxy or load balancer, with shared
  PostgreSQL, Redis, and object storage infrastructure

The same application code is used in every mode. The differences are the process manager, network
addresses, and environment variables.

## Deployment architecture

```mermaid
flowchart TD
client["Client / Frontend"] --> proxy["Load balancer"]
proxy --> apiA["Backend instance A<br/>runtime image"]
proxy --> apiB["Backend instance B<br/>runtime image"]

apiA --> db["Shared PostgreSQL"]
apiB --> db

apiA --> redis["Shared Redis"]
apiB --> redis
apiA --> objectStore["Shared object storage"]
apiB --> objectStore

migrator["Migrator image<br/>run once per release"] --> db
```

The backend instances are designed to be horizontally scalable as long as every instance uses the
same PostgreSQL, Redis, and object storage services:

- user data, sessions, verification tokens, and password reset tokens are stored in PostgreSQL
- Redis stores distributed rate limit state, cooldown state, and the renewable maintenance lock
- user-uploaded profile media and immutable video sources are stored in shared S3-compatible
  object storage, using independently configurable buckets
- the maintenance job can run in every process, but only the instance holding the Redis lock runs
  its ordered auth, media, multipart, generation, and reconciliation steps
- migrations are not run by every backend instance; they are run once through the migrator image
  before the new runtime replicas are started

Sticky sessions are not required for the current backend because authenticated state is stored in
the database and sent by clients through request credentials. Any instance can validate a request as
long as it can reach the shared database.

### Managed data services

PostgreSQL, Redis, and S3-compatible object storage are external data services. Each one may be
self-hosted or provided by a managed service; MinIO is simply the local S3-compatible implementation
used by Compose, the same way the Compose `postgres` and `redis` services are local implementations
of PostgreSQL and Redis:

- managed PostgreSQL is still the source of truth for users, sessions, verification tokens, and
  password reset tokens
- managed Redis is still the shared distributed store for rate limits, email cooldowns, and the
  renewable maintenance lock
- managed S3-compatible storage is still the shared store for profile media, immutable video
  sources, and generated video artifacts
- every backend instance must point to the same PostgreSQL and Redis services
- every backend instance must point to the same user-media and video object storage buckets
- migrations should use the provider's direct database connection when both pooled and direct
  PostgreSQL URLs are available
- Redis provider URLs should use the provider's Redis-compatible endpoint, with TLS enabled when
  required

Provider-specific credentials are deployment secrets and are not part of the repository.

### Cloudflare Tunnel origins

Cloudflare Tunnel can be used as the direct origin connector for each backend server:

```mermaid
flowchart LR
cloudflare["Cloudflare<br/>Load Balancer / Tunnel"] --> tunnelA["cloudflared<br/>server A"]
cloudflare --> tunnelB["cloudflared<br/>server B"]
tunnelA --> apiA["Backend A<br/>127.0.0.1:3000"]
tunnelB --> apiB["Backend B<br/>127.0.0.1:3000"]
apiA --> db["Shared PostgreSQL"]
apiB --> db
apiA --> redis["Shared Redis"]
apiB --> redis
```

When `cloudflared` forwards to the backend over loopback, `TRUST_PROXY=loopback` is the preferred
configuration. Express then trusts forwarded headers only for requests received from loopback.

When `cloudflared` runs as a separate container or in a private network and is the direct proxy in
front of the backend, `TRUST_PROXY=1` is acceptable. In that layout, the backend port must remain
private and must not be exposed directly to the public Internet.

Cloudflare health checks should target `/health/ready`.

### Docker Compose network

The local Compose stack contains these services by default:

```mermaid
flowchart LR
backend["backend<br/>runtime target"] --> postgres["postgres:5432"]
backend --> redis["redis:6379"]
backend --> minio["minio:9000"]
migrate["migrate<br/>migrator target"] --> postgres

subgraph network["fairplay-backend-network"]
backend
migrate
postgres
redis
minio
end
```

Within this Docker network, services use Docker DNS names:

- `DATABASE_URL=postgresql://user:password@postgres:5432/fairplay?schema=public`
- `REDIS_URL=redis://redis:6379`
- `OBJECT_STORAGE_ENDPOINT=http://minio:9000`

Docker Compose is a local development and verification tool for this repository. It is not the
production deployment model. The production runtime receives the same standard runtime variables
(`DATABASE_URL`, `REDIS_URL`, `OBJECT_STORAGE_*`) from the orchestrator or secret manager and points
to shared infrastructure directly.

The `COMPOSE_OBJECT_STORAGE_*` variables in `docker-compose.yml` are only Compose interpolation
inputs. They keep host development values such as `OBJECT_STORAGE_ENDPOINT=http://localhost:9000`
separate from container-network values such as `http://minio:9000`. They should be treated like
local Compose plumbing, not as a production configuration layer.

When Bun runs on the host for local development, those internal names are not available. The `.env`
file should use host-reachable addresses instead:

- `DATABASE_URL=postgresql://user:password@localhost:5432/fairplay?schema=public`
- `REDIS_URL=redis://localhost:6379`
- `OBJECT_STORAGE_ENDPOINT=http://localhost:9000`

### Production image layout

The Dockerfile exposes two deployment targets:

- `runtime`: production API image with compiled `dist`, production dependencies, Prisma client,
  FFmpeg/ffprobe, non-root `bun` user, and a `/health/ready` healthcheck
- `migrator`: one-shot image that runs `bun run prisma:migrate:deploy`

The production release order is:

1. Build and publish the `runtime` and `migrator` images for the same source revision.
2. Run the migrator image once with production database credentials.
3. Start or roll the runtime replicas.
4. Route traffic through the reverse proxy or load balancer after readiness checks pass.

## Health checks

The health routes are:

- `/health/live`: process liveness only
- `/health/ready`: checks database connectivity, Redis connectivity when Redis is configured, and
  every configured object storage bucket
- `/health`: lightweight process status

Production orchestrators should use `/health/ready` before routing traffic to an instance.

## App startup

The entry point is [`src/index.ts`](src/index.ts), it:

- reads the config
- creates external clients like Redis and object storage when configured
- prepares readiness checks
- assembles the Express app
- starts the server
- starts the periodic maintenance job and in-process transcode runner only after the server is
  listening
- on shutdown, stops maintenance, drains and requeues owned transcodes, closes the HTTP server,
  then disconnects Prisma and Redis

In production, Redis and object storage are required. In development, Redis can be unavailable; the
backend then falls back to in-memory rate limiting and skips distributed maintenance locks. Object
storage-dependent routes return a service-level error when object storage is not configured or not
ready.

## Maintenance lifecycle

A single non-overlapping maintenance job extends the existing auth cleanup. It runs these isolated
steps in order: expired sessions, expired auth tokens, user-media targets, expired multipart
sessions, abandoned artifact generations, and video targets. A failed step is reported in the
aggregate summary without preventing later steps from running.

When Redis is configured, a token-valued lock excludes other instances. The owner renews the TTL
with a compare-and-expire script, releases it with compare-and-delete, and stops before the next
step if ownership is lost. Without Redis, local overlap is still prevented but cross-process
exclusion is unavailable.

A `writing` artifact generation becomes abandoned only after the same heartbeat staleness window
used for transcode takeover, and only when no live job with the same `executionId` owns it.
Maintenance then changes its existing durable prefix targets from `present` to delayed `absent`;
the canonical one-hour quiescence and reconciliation backoff rules perform the actual cleanup.

Shutdown steps remain ordered even if one fails. Maintenance stops first, then transcode polling is
stopped and locally owned work is aborted and requeued, followed by the HTTP server, Prisma, and
Redis.

## Durable video source reservation

The database is authoritative for ownership and intent, while S3 holds the bytes. Multipart source
initialization therefore follows this order:

1. A serializable PostgreSQL transaction reserves the declared size, an upload session, and an
   exact external-resource target.
2. The session id is embedded in an immutable object key under
   `<user>/<video>/sources/<session>/original.mp4`.
3. Only after the transaction commits does the backend initiate S3 multipart upload and persist its
   handle.

An ambiguous S3 or PostgreSQL failure leaves a durable target that maintenance can reconcile.
Quota is the sum of source targets not yet confirmed absent, so an in-flight upload or replaced
source cannot disappear from accounting before its external bytes are known to be gone. External
targets deliberately retain scalar user and video ids without cascading foreign keys; cleanup
intent must survive deletion of the corresponding account or video.

## External resource reconciliation

`ExternalResourceTarget` is the canonical durable intent for video sources, generated prefixes,
thumbnails, and profile media. An exact selector is never inferred from path formatting, and a
prefix selector is deleted in bounded batches. Claims use unique expiring leases; final state and
optional domain transitions commit together only while the lease is still owned. Failed work
releases its lease, records a bounded error, and retries with exponential backoff capped at 24
hours.

Deletion requests move a target to `quiescing` no earlier than one hour after the request, and a
later request can extend but never shorten that deadline. Exact cleanup aborts persisted and
discoverable multipart uploads before deleting and confirming the object absent. Present
reconciliation is exact-only, verifies the object with HEAD, and checks its reserved size when
known.

Two residual risks are accepted without adding a distributed owner fence: an external write that
continues for more than the one-hour quiescence window could finish after cleanup, and transcode
ownership assumes independently generated UUID `executionId` values do not collide. The latter is
cryptographically negligible; a monotonic claim version would add coordination complexity without
a proportionate benefit here.

Profile-media uploads reserve a writing target before PUT. Persisting the asset and confirming its
target happen in one serializable transaction; replacement schedules the previous exact target in
that same transaction. Account deletion locks the user’s transcode jobs, schedules every retained
target, deletes only the user row, and relies on PostgreSQL cascades for sessions, tokens, videos,
and media rows. Temporary S3 failures therefore report deferred cleanup without rolling back the
business deletion.

## In-process video transcoding

There is no separate transcode worker service or queue runtime. Each backend process may claim
PostgreSQL jobs up to its local `VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS` limit, which is held for the
entire source download, probe, FFmpeg execution, artifact upload, verification, and publication
cycle. A value of `0` disables claims on that replica.

```mermaid
sequenceDiagram
participant Runner
participant DB as PostgreSQL
participant S3 as Object storage
participant FF as ffprobe / ffmpeg

Runner ->> DB: claim queued or stale job (SKIP LOCKED)
DB -->> Runner: processing + new executionId
Runner ->> S3: download persisted current source
Runner ->> DB: verify completed/current source and executionId
Runner ->> DB: reserve writing generation + prefix targets
Runner ->> FF: probe, then direct supervised encode
Runner ->> S3: upload immutable generation artifacts
Runner ->> S3: HEAD every required file and segment
Runner ->> DB: publish in one fenced transaction
DB -->> Runner: active generation + completed job
```

Heartbeats retain job ownership. A stale `processing` job can be reclaimed with a fresh
`executionId`; losing the conditional heartbeat aborts the local execution and terminates FFmpeg.
Shutdown stops polling, aborts local processes, requeues jobs still owned by the process, and waits
for every local slot to drain.

FFprobe metadata is validated before encoding. A single direct FFmpeg process emits H.264/CRF 24
HLS VOD renditions at 480p, 720p, and 1080p without upscaling, with even dimensions, six-second
segments, AAC 128k audio when the source has audio, and a WebP thumbnail. Encoder and filter
threads are bounded by `VIDEO_TRANSCODE_THREADS_PER_JOB`; child output retained in memory is also
bounded. Abort sends `SIGTERM`, followed by `SIGKILL` after five seconds if necessary.

Each execution writes to a unique generation namespace. Its database generation and prefix cleanup
targets are reserved before any potentially ambiguous artifact upload. The runner verifies the
master playlist, thumbnail, every rendition playlist, and at least one real segment per rendition
before attempting publication. Publication locks and checks the job, current source,
`executionId`, and `writing` generation in one serializable transaction. The same transaction
activates the new generation and renditions, completes the job, and moves the prior active
generation to `retiring` with one-hour-delayed prefix cleanup. A late execution cannot publish
after takeover; ambiguous upload failures leave a durable generation that can only be cleaned, not
mistaken for active output.

## Factories

Example of a factory in this repository:

```ts
createAuthService({
  prisma,
  hasher,
  token,
  mailer,
  clock,
  config,
  logger,
});
```

The [createAuthService()](src/services/auth.service.ts) factory enables testing without a real database, SMTP server, or runtime dependencies.

## Dependency injection

The dependency injection is very light here.

We simply assemble objects by hand:

```mermaid
flowchart LR
realDeps["Real dependencies<br/>Prisma, bcrypt, mailer, crypto"] --> factory["createAuthService()"]
testDeps["Fake dependencies<br/>stubs, fake clock, mocks"] --> factory
factory --> service["AuthService"]
```

## Controllers and Services

How a standard HTTP request is processed:

```mermaid
flowchart TD
request["HTTP Request"] --> validation["Zod validation middleware"]
validation --> controller["Controller"]
controller --> service["Service"]
service --> db["Prisma / Database"]
service --> mail["Mailer"]
service --> controller
controller --> response["HTTP Response"]
```

### Controller

The controller handles the following tasks:

- Read `req.body`, `req.params`, `req.ip`
- call the service
- transform dates into ISO strings
- choose the HTTP status
- send errors to the global middleware

It shouldn't contain the business logic.

### Service

The service contains the business rules:

- create a user
- verify a password
- create a session
- refuse a banned user
- delete expired sessions and tokens
- send a verification email

It does not depend on Express.

## Simplified auth flow

```mermaid
sequenceDiagram
participant Client
participant Route as /auth/login
participant Validation as Zod
participant Controller
participant Service
participant DB as Prisma

Client ->> Route: POST /auth/login
Route ->> Validation: validate the body
Validation ->> Controller: normalized body
Controller ->> Service: login(emailOrUsername, password, ip, userAgent)
Service ->> DB: search for the user
Service ->> Service: verify the password, ban state, and email
Service ->> DB: create hashed session and update lastLogin
Service -->> Controller: user + sessionKey
Controller -->> Client: JSON response
```

## Feature Structure

New features should follow this structure:

- validation goes into Zod schemas
- HTTP goes into the controller
- the business into the service
- external dependencies are injected
