![TypeScript](https://img.shields.io/badge/TypeScript-3178C6)
![License](https://img.shields.io/badge/License-GNU%20AGPLv3-blue.svg)

# FairPlay API v2

> Work in progress rewrite of the FairPlay backend

## About

FairPlay is an experimental ethical video platform focused on transparency, creator fairness, and open infrastructure.

This repository contains the backend API for the v2 rewrite.

## Tech stack

This repository contains the FairPlay backend API built with:

- TypeScript
- Express.js
- PostgreSQL
- Prisma
- S3-compatible object storage, with MinIO as the local default
- Bun
- Pino

## New V2 features and improvements

- Full OpenAPI schema generation
- Centralized logging with Pino
- Improved validation and error handling
- Cleaner project structure

## Quick start

There are two common ways to run the backend locally:

- run Bun on the host while PostgreSQL, Redis, and MinIO run in Docker, which is the recommended
  development flow
- run the whole local stack with Docker Compose

### Local development

```bash
bun install
cp .env.example .env
docker compose up -d postgres redis minio
bunx prisma migrate dev
bun run dev
```

The API runs on http://localhost:3000 and logs are pretty-printed by the development entrypoint.
MinIO runs locally on http://localhost:9000 for object storage and http://localhost:9001 for its
console.

### Docker Compose stack

```bash
docker compose up --build
```

The Compose stack builds the runtime image, starts local PostgreSQL, Redis, and MinIO services on
the same Docker network, runs the Prisma migrations once through the `migrate` service, then starts
the API on http://localhost:3000.

Make sure to read [CONTRIBUTING.md](CONTRIBUTING.md) for more complete setup instructions.

## Deployment

Production deployments should use the Dockerfile targets:

```bash
docker build --target runtime -t fairplay-backend:<tag> .
docker build --target migrator -t fairplay-backend-migrator:<tag> .
```

Run the migrator image once per release, then run one or more replicas of the runtime image behind
a reverse proxy or load balancer. Production requires shared PostgreSQL, Redis, and object storage
instances, SMTP configuration, and a strong `RATE_LIMIT_KEY_SECRET`.

Managed PostgreSQL, Redis, and S3-compatible object storage providers are supported. For example,
Neon can provide PostgreSQL, Upstash can provide Redis, and Infomaniak Object Storage or another
S3-compatible provider can provide object storage. Keep provider credentials in deployment
environment files or secret managers, never in Git.

Cloudflare Tunnel deployments should prefer `TRUST_PROXY=loopback` when `cloudflared` forwards to
the backend over `127.0.0.1:3000`. Use `/health/ready` for origin health checks.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deployment model and
[CONTRIBUTING.md](CONTRIBUTING.md) for the environment variables.

## Notes

### Dependency overrides

Some dependencies are pinned through `package.json` `overrides` to apply security fixes before upstream packages update their dependency ranges.

These overrides should be reviewed periodically and removed once the parent dependencies resolve to patched versions on their own.

Current overrides:

- `@hono/node-server`
- `form-data`
- `hono`
- `nodemailer`
- `protobufjs`
- `vite`

See https://bun.sh/docs/pm/overrides for more details about overrides.

## API Documentation

Once the backend is running, the generated OpenAPI documentation is available at:

```text
http://localhost:3000/docs
```

or

```text
http://localhost:3000/openapi.json
```

## Checks

This backend contains different commands for checking code quality and project conventions.

### Scripts

```bash
bun run typecheck
bun run build
bun run lint
bun run lint:fix
bun run format:check
bun run format
bun test
bun run test:integration
```

To run the standard verification suite at once:

```bash
bun run check
```

### Integration tests

Integration tests run with Vitest and Testcontainers. They start real PostgreSQL and Redis
containers, apply Prisma migrations, then exercise the HTTP API through the real Express app.

Docker must be running locally before launching them:

```bash
bun run test:integration
```

## Routes

Route files under `src/routes` are mounted automatically from their file path. For example:

```text
src/routes/index.ts -> /
src/routes/auth.ts -> /auth
src/routes/health.ts -> /health
```

## License

Licensed under the GNU AGPLv3.
See the LICENSE file for more information.
