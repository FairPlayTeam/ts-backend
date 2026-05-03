![TypeScript](https://img.shields.io/badge/TypeScript-3178C6)
![License](https://img.shields.io/badge/License-GNU%20AGPLv3-blue.svg)

# FairPlay API V2 WIP

FairPlay backend API built with TypeScript, Express, Prisma, and Bun.

## New V2 features and improvements
- Full OpenAPI and Swagger support
- Better architecture
- Global cleanup

## Setup

```bash
bun install
cp .env.example .env
```

Fill `.env`, then run:

```bash
bun run dev
```

API documentation:

```text
http://localhost:3000/docs
http://localhost:3000/openapi.json
```

## Checks

```bash
bun run typecheck
bun run lint
bun run format:check
bun test
```

## Routes

Route files under `src/routes` are mounted automatically from their file path. For example:

```text
src/routes/auth.ts -> /auth
src/routes/health.ts -> /health
```
