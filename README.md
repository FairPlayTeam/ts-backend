[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/D1D31GU3L5)

# Fairplay / Rewind TypeScript API

This repository is the backend API built with:

* TypeScript
* Express.js
* PostgreSQL
* Prisma
* MinIO
* FFmpeg
* Bun

It uses **session-based authentication**.

Documentation is available at:
[https://apiv2.fairplay.video/docs](https://apiv2.fairplay.video/docs)

---

## Requirements

You need:

* Bun → [https://bun.sh](https://bun.sh)
* A PostgreSQL database
* A MinIO instance (or compatible S3 storage)
* FFmpeg installed on your system

To simplify the setup of PostgreSQL and MinIO, you can use **Docker Desktop**.
Running them with Docker is usually faster and avoids manual installation issues.

For example, with Docker you can quickly spin up:

* A PostgreSQL container
* A MinIO container

Instead of installing them directly on your machine.

---

## Setup

1. **Install dependencies**

```bash
bun i
```

2. **Create your environment file**

Copy the example file and edit it:

```bash
cp .env.example .env
```

Then fill in your database, MinIO and other config values.

3. **Generate Prisma client**

```bash
bunx prisma generate
```

4. **Push schema to database**

```bash
bunx prisma db push
```

---

## Development

Run in development mode:

```bash
bun run dev
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

---

If something doesn’t work, check:

* Your `.env` values
* That PostgreSQL is running
* That MinIO is accessible
* That FFmpeg is installed
* That your Docker containers (if used) are running
