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
- Bun
- Pino

## New V2 features and improvements

- Full OpenAPI schema generation
- Centralized logging with Pino
- Improved validation and error handling
- Cleaner project structure

## Quick start

```bash
bun install
cp .env.example .env
docker compose up -d
bunx prisma migrate dev
bun run dev
```

Make sure to read [CONTRIBUTING.md](CONTRIBUTING.md) for more complete setup instructions.

## Notes

### Dependency overrides

Some dependencies are pinned through `package.json` `overrides` to apply security fixes before upstream packages update their dependency ranges.

These overrides should be reviewed periodically and removed once the parent dependencies resolve to patched versions on their own.

Current overrides:

- `qs`: security fix for the version pulled by Express/body-parser.
- `fast-uri`: security fix for the version pulled by Prisma tooling/AJV.
- `brace-expansion`: security fix for the version pulled by ESLint tooling.
- `hono` and `@hono/node-server`: security fixes for versions pulled by Prisma tooling.

See https://bun.sh/docs/pm/overrides for more details about overrides.

## API documentation:

Since we're now adding OpenAPI to the backend, you can now access a full detailed documentation about our routes. Once your backend is launched, go to:

```text
http://localhost:3000/docs
```

or

```text
http://localhost:3000/openapi.json
```

## Checks

This backend contains different commands you can use to make sure the code is clean and respects conventions.

### Scripts

```bash
bun run typecheck
bun run lint
bun run lint:fix
bun run format:check
bun run format
bun test
bun run test:integration
```

or if you want to verify everything at once:

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
