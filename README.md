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
bunx prisma migrate dev
bun run dev
```

## Setup

### Install dependencies

```bash
bun install
```

### Create your environment file

```bash
cp .env.example .env
```

Then fill in the values you want to use.

### Used env variables:

- `PORT` Specifies the port on which the backend listens (e.g. 3000). The service will be available at http://localhost:3000
- `DATABASE_URL` the URL to your postgres instance, for example `postgresql://myuser:mypass@localhost:5432/mydb?schema=public`, which means your database will be accessible at the user `myuser`, using the `mypass` password, at `localhost:5432`, on the `mydb` database, and on the schema `public`
- `BASE_URL` the URL leading to your backend, for example `http://localhost:3000`
- `BCRYPT_ROUNDS` how many iterations bcrypt will perform to hash passwords, for example `12`
- `JSON_BODY_LIMIT_BYTES` a fixed limit for JSON body size
- `TRUST_PROXY` indicate if express can trust the proxy, if it's running behind a proxy, for example `false` or `loopback`
- `CORS_ORIGINS` allowed URLs for requests
- `REDIS_URL` Redis connection URL used for distributed rate limiting, for example `redis://localhost:6379`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` are required to send emails. You can customize these values depending on the SMTP provider you're using.
- `FRONTEND_URL` the URL of your frontend, for example `http://localhost:3001`. It's mainly used to generate verification links for email verification.

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
```

or if you want to verify everything at once:

```bash
bun run check
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
