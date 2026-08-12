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
- FFmpeg and ffprobe for in-process video transcoding
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
console. Host-based development also requires `ffmpeg` and `ffprobe` on `PATH`; the production
runtime image installs both tools.

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
Use a separate strong `AUTH_CODE_PEPPER` for email verification and password reset code hashing.
For a fully public Bearer-token API, set `CORS_ORIGINS=*`.

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

- `@hono/node-server@2.0.10`, pulled in by Prisma through `@prisma/dev`
- `brace-expansion@5.0.9`, pulled in by `minimatch`
- `fast-uri@3.1.5`, pulled in by Ajv
- `hono@4.13.0`, pulled in by Prisma through `@prisma/dev`
- `ip-address@10.4.0`, pulled in by `express-rate-limit`
- `minimatch@10.2.6`, pulled in by ESLint, typescript-eslint, and Testcontainers
- `postcss@8.5.25`, pulled in by Vite
- `undici@8.10.0`, pulled in by Testcontainers
- `valibot@1.4.2`, pulled in by Prisma through `@prisma/dev`

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
bun run test:unit
bun run test:integration
```

To run the standard verification suite at once:

```bash
bun run check
```

`bun run check` runs typecheck, lint, formatting, Prisma validation, bounded-concurrency unit
tests, Testcontainers-backed integration tests, dependency audit, and the production build in order.
The test scripts set `SHARP_CONCURRENCY=1` by default for reproducible image-processing tests; set
`SHARP_CONCURRENCY` explicitly to a positive integer in the environment to override it.

## Video source uploads

Multipart video uploads declare their total size when initialized. PostgreSQL reserves that size
and an immutable source key before S3 is contacted. Each session writes below
`<user>/<video>/sources/<upload-session>/original.mp4`, so replacing a source cannot overwrite the
previous object. Replaced or ambiguously written sources continue to count toward the per-user
quota until object storage reconciliation confirms their absence.

`POST /videos` accepts an optional `allowComments` boolean when creating the video metadata. It
defaults to `true` and is fixed for that video at creation in this API version; there is no
post-upload comment-settings route.

Before completing a multipart source session, a client may upload or replace an optional thumbnail
with `PUT /videos/:videoId/upload/multipart/:uploadSessionId/thumbnail` using the multipart field
`thumbnail`. JPEG, PNG, and WebP inputs are signature-validated and normalized to a center-cropped
1280x720 WebP. Only a thumbnail already confirmed when `complete` freezes the source is used; an
in-flight thumbnail is discarded through reconciliation and transcoding falls back to the
FFmpeg-generated frame.

The same durable reconciliation engine owns profile-media cleanup and exact or prefix video
resources. PostgreSQL records intent before an ambiguous S3 write, deletions wait a fixed hour,
and workers claim due targets with expiring leases. Failures remain durable with capped
exponential backoff. Account deletion removes the user and lets database cascades remove business
rows while external-resource targets survive until S3 confirms every object or prefix absent.

## Video transcoding

Transcoding runs inside the backend process with direct, supervised `ffprobe` and `ffmpeg` child
processes. PostgreSQL claims queued work with `FOR UPDATE SKIP LOCKED`; stale heartbeats make an
abandoned job claimable again under a new `executionId`. The per-process concurrency setting covers
the complete download, probe, encode, upload, verification, and publication cycle. Setting
`VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS=0` keeps a replica from claiming work.

Every execution reserves a durable `writing` generation and its cleanup prefixes before creating
or uploading artifacts. FFmpeg creates only the 480p, 720p, and 1080p H.264 renditions that fit
within the source resolution, plus six-second HLS VOD segments, optional AAC audio, and a WebP
thumbnail. All artifacts use an immutable generation namespace and are checked in object storage
before publication.

A confirmed custom thumbnail replaces the local FFmpeg poster before upload, so the final bytes
are copied into each generation's own immutable thumbnail key. Its temporary source object becomes
eligible for delayed reconciliation cleanup only after that generation is published.

Publication is one PostgreSQL transaction fenced by the current job `executionId`, current source,
and `writing` generation. It activates the new generation, exposes its master playlist and
thumbnail, completes the job, and moves the previous generation to `retiring` with durable
one-hour-delayed prefix cleanup. A late process from an execution taken over elsewhere therefore
cannot publish.

## Public HLS playback

`GET /videos` returns the public main feed in reverse creation order. It uses the same
`public` + `approved` + `ready` scope and the same `(createdAt, publicId)` cursor as
`GET /videos/search`, without applying a text filter or exposing an alternative sort. Feed cards
contain only the public id, title, creation time, opaque thumbnail path, creator identity, view
count, and duration in whole seconds. Both public lists use `Cache-Control: no-store`.

`GET /videos/:publicId` returns the playback-page detail for a readable video. It combines video
metadata including its persisted duration in whole seconds, creator identity, opaque avatar and
thumbnail paths, rating, view, and comment aggregates, optional current-user rating, and the opaque
master-playlist path in one short PostgreSQL `RepeatableRead` snapshot. The route accepts anonymous
requests, treats invalid optional authentication as anonymous, and always sends
`Cache-Control: no-store`. Its `commentsOpen` field reports whether a new comment can currently be
posted; it combines the owner's preference with the stricter engagement scope, while existing
threads can remain readable when it is false.

An authenticated non-owner load schedules one best-effort view per video and UTC day after the
snapshot commits. Anonymous and owner loads never count. The write is deduplicated atomically and
does not delay or fail playback, so the count returned by a request may precede that request's own
increment. Public responses expose only `viewCount`; personal view days are available only through
the authenticated account-data export and are removed, with their aggregate contribution, when the
account is deleted.

Rating reads follow the same public/unlisted + ready policy as playback, including for `rejected`
videos. `PUT /videos/:publicId/rating` remains stricter and refuses new or updated votes after
rejection.

Readable videos expose public paginated comment threads through
`GET /videos/:publicId/comments` and
`GET /videos/:publicId/comments/:rootCommentId/replies`. Root threads are newest-first, replies
oldest-first, and both use a stable `(createdAt, id)` cursor. Creating a root or reply requires an
authenticated user, enabled comments, and the stricter engagement scope that excludes rejected
videos. Replies remain one level deep in storage while `replyingToCommentId` identifies the
specific participant being addressed. Authors can soft-delete their own comments. The current video
owner and moderators or administrators can also soft-delete comments without depending on video
readability or engagement state. A deleted root is returned as a content-free placeholder only while
active replies still preserve its thread.
All comment responses use `Cache-Control: no-store`.

The public master URL is
`GET /videos/:publicId/hls/master.m3u8`; it resolves the current active generation and needs no
authentication. Rendition playlists and segments use generation-qualified immutable URLs. The API
rewrites playlist URI lines, but segment bodies are never proxied: their route returns a temporary
redirect to a freshly signed object-storage URL.

`GET /videos/:publicId/thumbnail` uses the same public/unlisted, readiness, and moderation policy
and returns a temporary signed redirect to the active generation poster. Thumbnail and segment
redirect responses use `Cache-Control: no-store` because the embedded signature expires.

Because the browser follows that redirect to a different origin, configure CORS on the video
bucket in MinIO/S3 as well as on the API. Allow each player origin to issue `GET` and `HEAD`, allow
the `Range` header (or all request headers if required by the provider), and expose
`Accept-Ranges`, `Content-Length`, `Content-Range`, and `ETag`. The bucket remains private and the
signed URL supplies authorization. `CORS_ORIGINS` configures Express only; it does not cover the
redirected MinIO/S3 request.

## Maintenance and runtime lifecycle

The existing periodic auth cleanup is now the single general maintenance job. It sequentially and
independently cleans expired sessions and tokens, reconciles user media, expires multipart
sessions, schedules abandoned `writing` generations through the durable reconciliation engine,
and reconciles video targets. A token-safe, renewable Redis lock excludes concurrent instances;
loss of ownership stops the run before its next step.

Maintenance and transcoding start only after the HTTP server is listening. Graceful shutdown stops
maintenance, aborts and requeues owned transcodes while draining local slots, closes HTTP, and then
disconnects Prisma and Redis. Each shutdown step is attempted even if an earlier one fails.

### Integration tests

Integration tests run with Vitest and Testcontainers. They start real PostgreSQL and Redis
containers plus MinIO, apply Prisma migrations, then exercise the runtime services and HTTP API
against those real dependencies.

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
