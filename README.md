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
- FFmpeg and ffprobe in the isolated video-transcoder image
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
console. Host-based development also requires `ffmpeg` and `ffprobe` on `PATH`; the local Compose
combined image and production transcoder image install both tools.

### Docker Compose stack

```bash
docker compose up --build
```

The Compose stack builds the local combined image, starts local PostgreSQL, Redis, and MinIO services on
the same Docker network, runs the Prisma migrations once through the `migrate` service, then starts
the API on http://localhost:3000.

Make sure to read [CONTRIBUTING.md](CONTRIBUTING.md) for more complete setup instructions.

## Deployment

The Dockerfile separates the production API from the transcoder:

```bash
docker build --target runtime -t fairplay-backend:production-api .
docker build --target transcoder -t fairplay-backend:production-transcoder .
docker build --target migrator -t fairplay-backend-migrator:<tag> .
```

Run the migrator image once per release. Start the API with `RUNTIME_ROLE=api` and
`VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS=0` behind a reverse proxy; start one isolated worker with
`RUNTIME_ROLE=transcoder` and one slot. The API image does not contain FFmpeg. The worker image has
no Docker HTTP healthcheck and does not bind a port. The initial no-orchestrator DL360 deployment
uses the example [systemd units](deploy/systemd); its resource budget and temporary-filesystem setup
are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

Production requires shared cloud PostgreSQL, Redis (API only), and S3-compatible object storage,
SMTP configuration for the API, and a strong `RATE_LIMIT_KEY_SECRET`.
Use a separate strong `AUTH_CODE_PEPPER` for email verification and password reset code hashing.
Set the same random 64-hex-character `FOLLOWING_CURSOR_ENCRYPTION_KEY` on every API replica;
rotating it invalidates followed-profile cursors that clients have not consumed yet.
For a fully public Bearer-token API, set `CORS_ORIGINS=*`.
Profile media uses the `user-media` bucket, while video sources and artifacts use `videos`.

Managed PostgreSQL, Redis, and S3-compatible object storage providers are supported. The initial
production setup uses cloud PostgreSQL and Redis, with Backblaze B2 for all object data. Keep
provider credentials in protected deployment environment files or secret managers, never in Git.

Cloudflare Tunnel deployments should prefer `TRUST_PROXY=loopback` when `cloudflared` forwards to
the backend over `127.0.0.1:3000`. Use `/health/ready` for origin health checks.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deployment model and
[CONTRIBUTING.md](CONTRIBUTING.md) for the environment variables.

## Notes

### Dependency overrides

Some dependencies are pinned through `package.json` `overrides` to apply security fixes before upstream packages update their dependency ranges.

These overrides should be reviewed periodically and removed once the parent dependencies resolve to patched versions on their own.

Current overrides:

- `decode-uri-component@0.5.0`, pulled in by MinIO through `query-string`
- `deepmerge-ts@8.0.2`, pulled in by Prisma through `@prisma/config`
- `mysql2@3.24.5`, pulled in directly by the Prisma CLI

Other patched transitive dependencies, including `@grpc/grpc-js`, `brace-expansion`, `fast-uri`,
`fast-copy`, `ip-address`, `nanoid`, `proxy-addr`, `qs`, `source-map-js`, and `undici`, resolve
through their parent package's declared semver range and therefore do not require an override.

`bun audit` currently reports three moderate advisories for `minio > stream-json@1.9.1`
(`GHSA-hqr4-qq8f-hg3x`, `GHSA-mjw6-4jj6-33hc`, and `GHSA-528h-pc64-c93x`). MinIO declares
`stream-json@^1.8.0` and uses its JSONL parser. The patched `stream-json` 3.x line is not API-compatible
with MinIO's `jsonl/Parser.js` and `.make()` usage, so forcing it through an override would risk
breaking the storage client. Keep these findings visible until MinIO publishes a compatible
dependency range; do not silence them or force the major upgrade.

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

`POST /videos` does not accept a visibility preference. Every video is created as `unlisted`, and
only moderation controls later visibility: approval makes it `public` unless administrative
deletion is already pending, while rejection and administrative deletion make it `unlisted`.
Transcoding never changes visibility. A `ready` unlisted video remains accessible by direct link
but is absent from public catalogs.

The route accepts an optional `allowComments` boolean when creating the video metadata. It defaults
to `true` and is fixed for that video at creation in this API version; there is no post-upload
comment-settings route.

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

Production transcoding runs in a dedicated worker process and Docker image with direct, supervised
`ffprobe` and `ffmpeg` child processes. The API uses `RUNTIME_ROLE=api` and
`VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS=0`; the worker uses `RUNTIME_ROLE=transcoder` and one job slot.
The worker does not create Express, bind a socket, or connect to Redis. PostgreSQL claims queued
work with `FOR UPDATE SKIP LOCKED`; stale heartbeats make an abandoned job claimable again under a
new `executionId`. A slot covers the complete download, probe, encode, upload, verification, and
publication cycle.

Multipart initialization is admitted before object storage is contacted. The serializable
transaction counts queued/processing jobs and active upload reservations, with defaults of ten
outstanding globally and two per account. Capacity transfers atomically from an upload reservation
to its queued job when completion commits. A full limit returns the same retryable 429 and does not
create an S3 multipart upload.

Every execution reserves a durable `writing` generation and its cleanup prefixes before creating
or uploading artifacts. FFmpeg creates a 240p-only rendition for sources from 240p through 479p;
sources at 480p and above keep the 480p, 720p, and 1080p ladder entries that fit without upscaling.
Sources below 240p fail permanently. Renditions use six-second HLS VOD segments, optional AAC
audio, and a WebP thumbnail. All artifacts use an immutable generation namespace and are checked
in object storage before publication.

Before encoding, ffprobe rejects sources longer than 30 minutes, wider or taller than 3840 pixels,
above 8,294,400 raster or square-pixel display pixels, above a 4:1 raster or display aspect ratio in
either orientation, or above 30 average FPS. An FFmpeg decoder-level pixel ceiling repeats the
metadata pixel check, and anamorphic inputs are normalized to square-pixel artifacts. FFprobe and
FFmpeg also account for quarter-turn container rotation before producing oriented square-pixel
artifacts; other rotation angles are rejected. They have independent 30-second and two-hour
deadlines. Both accept only the local `file` input protocol and the MP4-family `mov` demuxer;
FFmpeg also caps every rendition at 30 FPS and applies a VBV maximum rate and buffer alongside CRF.
A generation whose cumulative local artifacts exceeds 4 GiB is rejected before any artifact
upload. These defaults are configurable through the
`VIDEO_TRANSCODE_MAX_*`, `VIDEO_TRANSCODE_FFPROBE_TIMEOUT_MS`, and
`VIDEO_TRANSCODE_FFMPEG_TIMEOUT_MS` variables listed in `.env.example`.
The 3 GiB source and 4 GiB artifact ceiling imply about 7 GiB of expected local temporary data per
slot. The initial worker's `TMPDIR` is bound to a dedicated 32 GiB filesystem, so local scratch
remains bounded even though all durable object data is stored in Backblaze B2.

A confirmed custom thumbnail replaces the local FFmpeg poster before upload, so the final bytes
are copied into each generation's own immutable thumbnail key. Its temporary source object becomes
eligible for delayed reconciliation cleanup only after that generation is published.

Publication is one PostgreSQL transaction fenced by the current job `executionId`, current source,
and `writing` generation. It activates the new generation, exposes its master playlist and
thumbnail, completes the job, and moves the previous generation to `retiring` with durable
one-hour-delayed prefix cleanup. A late process from an execution taken over elsewhere therefore
cannot publish.

## Public profiles and followed profiles

Public profile and followed-profile JSON is field-whitelisted and does not expose PostgreSQL user
UUIDs. `GET /profiles/me/following` returns a single authenticated opaque cursor rather than its
internal `(followedAt, followingId)` keyset. Invalid, altered, and obsolete cursors return the same
generic 400 response.

## Public HLS playback

`GET /videos` returns the public main feed in reverse creation order. It uses the same
`public` + `approved` + `ready` scope and the same `(createdAt, publicId)` cursor as
`GET /videos/search`, without applying a text filter or exposing an alternative sort. Feed cards
contain only the public id, title, creation time, opaque thumbnail path, creator identity, view
count, and duration in whole seconds. Both public lists use `Cache-Control: no-store`.

`GET /videos/search` also returns up to ten creators whose verified, non-banned public profiles
match the term on username or display name. A case-insensitive exact username match comes first;
the remaining partial matches are ordered by username and exclude that exact account. Creator
cards expose only public identity and opaque avatar data, follower and publicly discoverable video
counts, and account creation time. The exact and partial creator reads share one short PostgreSQL
`RepeatableRead` snapshot, independent from the video catalog snapshot assembled by the same
request.

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
videos and videos awaiting administrative deletion. `PUT /videos/:publicId/rating` remains
stricter and refuses new or updated votes after rejection or once administrative deletion is
requested.

Readable videos expose public paginated comment threads through
`GET /videos/:publicId/comments` and
`GET /videos/:publicId/comments/:rootCommentId/replies`. Root threads are newest-first, replies
oldest-first, and both use a stable `(createdAt, id)` cursor. Creating a root or reply requires an
authenticated user, enabled comments, and the stricter engagement scope that excludes rejected
videos and videos awaiting administrative deletion. Replies remain one level deep in storage while
`replyingToCommentId` identifies the
specific participant being addressed. Authors can soft-delete their own comments. The current video
owner and moderators or administrators can also soft-delete comments without depending on video
readability or engagement state. A deleted root is returned as a content-free placeholder only while
active replies still preserve its thread.
Authenticated users can idempotently add or remove a like with
`PUT /videos/:publicId/comments/:commentId/like` and
`DELETE /videos/:publicId/comments/:commentId/like`. Every root and reply DTO exposes the aggregate
`likeCount` plus viewer-specific `viewerHasLiked`; anonymous readers receive `false`, and liker
identities are never exposed. All comment responses use `Cache-Control: no-store`.

The public master URL is
`GET /videos/:publicId/hls/master.m3u8`; it resolves the current active generation and needs no
authentication. Rendition playlists and segments use generation-qualified immutable URLs whose
random public generation token is distinct from the internal generation UUID. The API rewrites
playlist URI lines, but segment bodies are never proxied: their route returns a temporary redirect
to a freshly signed object-storage URL. HLS and poster object keys use
`artifacts/<public-generation-token>/`, so those redirects expose no user, video, or generation
UUID.

`GET /videos/:publicId/thumbnail` uses the same public/unlisted, readiness, and moderation policy
and returns a temporary signed redirect to the active generation poster. Thumbnail and segment
redirect responses use `Cache-Control: no-store` because the embedded signature expires.

Because the browser follows that redirect and sends multipart parts to a different origin,
configure CORS on the video bucket in MinIO/S3 as well as on the API. Allow each frontend origin to
issue `GET`, `HEAD`, and `PUT`; allow `Range` and `Content-Type` (or all request headers if required
by the provider); and expose `Accept-Ranges`, `Content-Length`, `Content-Range`, and `ETag`. The
bucket remains private and the signed URL supplies authorization. `CORS_ORIGINS` configures Express
only; it does not cover redirected reads or presigned multipart uploads to MinIO/S3.

## Maintenance and runtime lifecycle

The existing periodic auth cleanup is now the single general maintenance job. It sequentially and
independently cleans expired sessions and tokens, reconciles user media, expires multipart
sessions, schedules abandoned `writing` generations through the durable reconciliation engine,
reconciles video targets, and purges videos whose rejection or administrative-deletion retention
deadline has elapsed. If both deadlines exist, the earlier one wins. A token-safe, renewable Redis
lock excludes concurrent instances; loss of ownership stops the run before its next step.

## Video deletion

`DELETE /videos/:publicId` immediately deletes a video only for its owner, regardless of processing
or moderation state. Moderator and administrator roles do not override ownership on this route.
The transaction schedules every durable source, source-thumbnail, active or retiring HLS, and
thumbnail target for absence before deleting the row; database cascades remove comments, likes,
ratings, views, upload sessions, jobs, and generations. No email is sent.

`POST /moderation/videos/:videoId/deletion` is a separate moderator/administrator action with a
required reason. It keeps rejection data distinct, records a category-only deletion origin, makes
the video unlisted, and sends a dedicated notification once. A ready video remains readable by
direct link during the seven-day retention window but is no longer discoverable or writable for
ratings/comments. Maintenance then invokes the same hard-delete protocol used by owner deletion
and rejected-video purge. Deletion audit fields are returned only by moderation endpoints and are
not exposed by public or owner video DTOs.

Administrative and moderation services receive the actor identifier, not an authoritative role.
Their transactions lock the actor account and recheck its current role and ban state before
returning privileged data or applying a write. Role downgrades and bans update that same row, so a
revocation that commits first prevents an already-authenticated request from completing its
privileged operation. If the privileged transaction acquires the actor lock first, revocation
waits for that transaction to finish; the lock is retained through the business commit.

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
