![TypeScript](https://img.shields.io/badge/TypeScript-3178C6)
![License](https://img.shields.io/badge/License-GNU%20AGPLv3-blue.svg)

# Fairplay API

This repository contains the Fairplay backend API built with:

* TypeScript
* Express.js
* PostgreSQL
* Prisma
* MinIO
* FFmpeg
* Bun

It uses **session-based authentication** and versioned Prisma migrations.

Documentation is available at:
[https://apiv2.fairplay.video/docs](https://apiv2.fairplay.video/docs)

---

## Requirements

You need:

* Bun -> [https://bun.sh](https://bun.sh)
* A PostgreSQL database
* A MinIO instance (or compatible S3 storage)
* FFmpeg installed on your system

To simplify the setup of PostgreSQL and MinIO, you can use **Docker Desktop**.
Running them with Docker is usually faster and avoids manual installation issues.

---

## Setup

1. **Install dependencies**

```bash
bun i
```

2. **Create your environment file**

```bash
cp .env.example .env
```

Then fill in the values you want to use.

Important environment notes:

* `FRONTEND_URL` is used to build email verification links
* `PLAYBACK_TOKEN_SECRET` should be set in production to sign short-lived HLS playback URLs returned by `GET /videos/:id`
* `PLAYBACK_TOKEN_TTL_SECONDS` controls how long those signed playback URLs stay valid (default: 3600 seconds)
* `TRUST_PROXY` should be set in production if the API is behind Nginx, Caddy, Cloudflare, or another reverse proxy. Use `1` for a single trusted proxy hop, or `true` if your full proxy chain is trusted.
* `JSON_BODY_LIMIT_BYTES` and `URLENCODED_BODY_LIMIT_BYTES` cap non-file request payloads globally (defaults: 1MB JSON, 256KB URL-encoded)
* `CLEANUP_INTERVAL_MINUTES` controls how often expired sessions and stale chunk upload folders are cleaned up
* `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` are required to send verification emails
* The API can start without SMTP configured, but registration and resend-verification endpoints will return `503` until those values are set
* Direct upload endpoints accept videos up to **95MB** to stay under Cloudflare's request limit; use the chunked upload flow for larger files
* Chunked uploads are capped to protect temporary disk usage and currently allow up to **3040MB** total

3. **Generate Prisma client**

```bash
bunx prisma generate
```

4. **Apply the initial migration**

```bash
bun run prisma:migrate:deploy
```

For local schema changes during development:

```bash
bun run prisma:migrate:dev
```

---

## Development

Run in development mode:

```bash
bun run dev
```

Run the lightweight verification suite:

```bash
bun run check
```

Contribution notes:
[CONTRIBUTING.md](./CONTRIBUTING.md)

Check migration state:

```bash
bun run prisma:migrate:status
```

---

## Production

Build:

```bash
bun run build
```

Start:

```bash
bun run start
```

Database deployment:

```bash
bun run prisma:migrate:deploy
```

---

If something does not work, check:

* Your `.env` values
* That PostgreSQL is running
* That MinIO is accessible
* That FFmpeg is installed
* That `FRONTEND_URL` points to your frontend
* That `TRUST_PROXY` is configured correctly if you are behind a reverse proxy
* That your SMTP settings are configured if you want registration and email verification to work
