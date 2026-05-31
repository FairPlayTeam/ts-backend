# Backend Architecture

> This document covers the backend runtime shape, deployment model, and authentication flow.

The backend is organized around small composable factories and dependencies are injected explicitly to improve testability.

## Overview

```mermaid
flowchart TD
index["src/index.ts<br/>Bootstrap runtime"] --> app["createApp()"]
index --> authInstance["auth.instance.ts"]
index --> cleanup["createAuthCleanupJob()"]
index --> readiness["Readiness checks"]

authInstance --> authService["createAuthService()"]
authService --> prisma["Prisma"]
authService --> mailer["mailer"]
authService --> crypto["Token / Hash"]
authService --> clock["clock"]

app --> routes["Auto-loaded routes"]
routes --> controller["AuthController"]
controller --> authService

app --> middleware["Middleware<br/>CORS, Helmet, Logger, Rate Limit"]
middleware --> redis["Redis optional, required in production"]
cleanup --> redisLock["Redis distributed lock<br/>when Redis is configured"]
```

## Runtime modes

The backend supports three common runtime modes:

- local development: Bun runs on the host, PostgreSQL and Redis run through Docker Compose
- local full stack: Docker Compose builds and runs the backend, the one-shot migrator, PostgreSQL,
  and Redis on the same Docker network
- production: the runtime image runs behind a reverse proxy or load balancer, with shared
  PostgreSQL and Redis infrastructure

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

migrator["Migrator image<br/>run once per release"] --> db
```

The backend instances are designed to be horizontally scalable as long as every instance uses the
same PostgreSQL and Redis services:

- user data, sessions, verification tokens, and password reset tokens are stored in PostgreSQL
- Redis stores distributed rate limit state, cooldown state, and the auth cleanup lock
- the auth cleanup job can run in every process, but only the instance holding the Redis lock
  removes expired sessions and tokens
- migrations are not run by every backend instance; they are run once through the migrator image
  before the new runtime replicas are started

Sticky sessions are not required for the current backend because authenticated state is stored in
the database and sent by clients through request credentials. Any instance can validate a request as
long as it can reach the shared database.

### Managed data services

PostgreSQL and Redis may be self-hosted or provided by managed services. Neon and Upstash are valid
examples of managed providers for this architecture:

- managed PostgreSQL is still the source of truth for users, sessions, verification tokens, and
  password reset tokens
- managed Redis is still the shared distributed store for rate limits, email cooldowns, and the
  auth cleanup lock
- every backend instance must point to the same managed PostgreSQL and Redis services
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

The local Compose stack contains these services:

```mermaid
flowchart LR
backend["backend<br/>runtime target"] --> postgres["postgres:5432"]
backend --> redis["redis:6379"]
migrate["migrate<br/>migrator target"] --> postgres

subgraph network["fairplay-backend-network"]
backend
migrate
postgres
redis
end
```

Within this Docker network, services use Docker DNS names:

- `DATABASE_URL=postgresql://user:password@postgres:5432/fairplay?schema=public`
- `REDIS_URL=redis://redis:6379`

When Bun runs on the host for local development, those internal names are not available. The `.env`
file should use host-reachable addresses instead:

- `DATABASE_URL=postgresql://user:password@localhost:5432/fairplay?schema=public`
- `REDIS_URL=redis://localhost:6379`

### Production image layout

The Dockerfile exposes two deployment targets:

- `runtime`: production API image with compiled `dist`, production dependencies, Prisma client,
  non-root `bun` user, and a `/health/ready` healthcheck
- `migrator`: one-shot image that runs `bun run prisma:migrate:deploy`

The production release order is:

1. Build and publish the `runtime` and `migrator` images for the same source revision.
2. Run the migrator image once with production database credentials.
3. Start or roll the runtime replicas.
4. Route traffic through the reverse proxy or load balancer after readiness checks pass.

## Health checks

The health routes are:

- `/health/live`: process liveness only
- `/health/ready`: checks database connectivity and Redis connectivity when Redis is configured
- `/health`: lightweight process status

Production orchestrators should use `/health/ready` before routing traffic to an instance.

## App startup

The entry point is [`src/index.ts`](src/index.ts), it:

- reads the config
- creates external clients like Redis when configured
- prepares readiness checks
- assembles the Express app
- starts the server
- starts the periodic auth cleanup after the server is listening
- and gracefully shuts down Prisma, Redis, and the HTTP server

In production, Redis is required. In development, Redis can be unavailable; the backend then falls
back to in-memory rate limiting and skips distributed maintenance locks.

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
