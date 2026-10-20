# Backend Architecture

> This document covers the backend runtime shape, deployment model, and authentication flow.

The backend is organized around small composable factories and dependencies are injected explicitly to improve testability.

## Overview

```mermaid
flowchart TD
index["src/index.ts<br/>Bootstrap runtime"] --> role["RUNTIME_ROLE"]
role --> app["API / combined: createApp()"]
role --> worker["transcoder: runner only"]
index --> authInstance["auth.instance.ts"]
app --> cleanup["API/combined maintenance job"]
index --> readiness["Readiness checks"]
worker --> transcodeRunner["Isolated transcode runner"]

authInstance --> authService["createAuthService()"]
authService --> prisma["Prisma"]
authService --> mailer["mailer"]
authService --> objectStorage["Object storage"]
authService --> crypto["Token / Hash"]
authService --> clock["clock"]

app --> routes["Explicit route registry<br/>src/routes/registry.ts"]
routes --> controller["AuthController"]
controller --> authService

app --> middleware["Middleware<br/>CORS, Helmet, Logger, Rate Limit"]
middleware --> redis["Redis optional, required in production"]
cleanup --> redisLock["Redis distributed lock<br/>when Redis is configured"]
index --> videoUploads["Video Uploads module"]
index --> videos["Videos module"]
index --> videoTranscoding["Video Transcoding maintenance"]
videoUploads --> videoStorage["Video object storage bucket"]
videoUploads --> externalTargets["Durable external resource targets"]
videoTranscoding --> externalTargets
cleanup --> externalTargets
```

## Runtime modes

The backend supports three common runtime modes:

- local development: Bun runs on the host, while PostgreSQL, Redis, and Garage provide local
  versions of the external infrastructure through Docker Compose
- local full stack: Docker Compose builds and runs the backend, the one-shot migrator, PostgreSQL,
  Redis, and Garage on the same local Docker network
- production: API and transcoder use separate runtime images/processes; only the API sits behind a
  reverse proxy, while PostgreSQL, Redis, and object storage are shared cloud services

The same application code is used in every mode. The differences are the process manager, network
addresses, and environment variables.

## Runtime configuration

`src/config/env.schema.ts` owns the known runtime variables, their defaults, normalization, and
cross-variable validation. Its `parseEnvironment(environment)` function is pure and ignores unrelated
keys supplied by the process environment. `src/config/env.ts` is the application bootstrap boundary
that reads `process.env` and exports the parsed configuration; tests pass explicit environment
objects to the parser. Shared default values live in `src/config/constants.ts`. Logger settings,
Sharp concurrency, script-only variables, and the package version remain outside this bootstrap
schema because they are read by separate early-startup or tooling paths.

## Deployment architecture

```mermaid
flowchart TD
client["Client / Frontend"] --> proxy["Reverse proxy"]
proxy --> api["API container<br/>runtime target; 0 transcode slots"]
worker["Transcoder container<br/>transcoder target; no HTTP listener"] --> db["Cloud PostgreSQL"]
api --> db
api --> redis["Cloud Redis"]
api --> objectStore["Backblaze B2<br/>S3-compatible object storage"]
worker --> objectStore
migrator["Migrator image<br/>run once per release"] --> db
```

API instances are designed to be horizontally scalable as long as every instance uses the same
PostgreSQL, Redis, and object storage services. Transcoder instances share the PostgreSQL job table
and object storage but must not be exposed to HTTP traffic:

- user data, sessions, verification tokens, and password reset tokens are stored in PostgreSQL
- Redis stores distributed rate limit state, cooldown state, and the renewable maintenance lock
- user-uploaded profile media and immutable video sources are stored in shared S3-compatible
  object storage, using independently configurable buckets
- the API runs the maintenance job; only the instance holding the Redis lock runs its ordered auth,
  media, multipart, generation, and reconciliation steps
- the transcoder does not connect to Redis and does not create an Express app or HTTP listener
- migrations are not run by every backend instance; they are run once through the migrator image
  before the new runtime replicas are started

Sticky sessions are not required for the current backend because authenticated state is stored in
the database and sent by clients through request credentials. Any instance can validate a request as
long as it can reach the shared database.

### Managed data services

PostgreSQL, Redis, and S3-compatible object storage are external data services. Each one may be
self-hosted or provided by a managed service; Garage is the local S3-compatible implementation
used by Compose, the same way the Compose `postgres` and `redis` services are local implementations
of PostgreSQL and Redis:

- managed PostgreSQL is still the source of truth for users, sessions, verification tokens, and
  password reset tokens
- managed Redis is still the shared distributed store for rate limits, email cooldowns, and the
  renewable maintenance lock
- managed S3-compatible storage is still the shared store for profile media, immutable video
  sources, and generated video artifacts
- every backend instance must point to the same PostgreSQL and Redis services
- every backend instance must point to the same `user-media` and `videos` object storage buckets
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
backend["backend<br/>combined target"] --> postgres["postgres:5432"]
backend --> redis["redis:6379"]
backend --> objectStorage["object-storage:3900"]
migrate["migrate<br/>migrator target"] --> postgres

subgraph network["fairplay-backend-network"]
backend
migrate
postgres
redis
objectStorage
end
```

Within this Docker network, services use Docker DNS names:

- `DATABASE_URL=postgresql://user:password@postgres:5432/fairplay?schema=public`
- `REDIS_URL=redis://redis:6379`
- `OBJECT_STORAGE_ENDPOINT=http://object-storage:3900`

Docker Compose is a local development and verification tool for this repository. It is not the
production deployment model. Production receives standard runtime variables (`DATABASE_URL`,
`REDIS_URL`, `OBJECT_STORAGE_*`) from protected environment files and points to shared cloud
infrastructure directly.

The `COMPOSE_OBJECT_STORAGE_*` variables in `docker-compose.yml` are only Compose interpolation
inputs. They keep host development values such as `OBJECT_STORAGE_ENDPOINT=http://localhost:9000`
separate from container-network values such as `http://object-storage:3900`. They should be treated like
local Compose plumbing, not as a production configuration layer.

The Compose object-storage service runs Garage v2.4.1 as a single node, with its image pinned to
the tested manifest digest. `--single-node --default-bucket` initializes the local node and its
default bucket; `docker/garage.toml` persists metadata and object data under
`/var/lib/garage` in the new `object_storage_data` volume. Garage's S3 API is mapped from container
port `3900` to host port `9000`; signed URLs use `http://localhost:9000`, while backend requests
use the private `http://object-storage:3900` address. This single-node setup has no storage
redundancy and is for local development and CI only, not production.

The application uses AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner`) against the S3 endpoint. `forcePathStyle` is enabled for Garage and
Backblaze compatibility. Request checksum calculation is restricted to operations that require it:
the SDK otherwise adds a zero-value CRC32 checksum when presigning an `UploadPart` without a body,
which Garage correctly rejects when the browser later uploads the real bytes.

The CI admission test creates 1,001 incomplete multipart uploads on the same object key and proves
the two-marker pagination boundary against Garage itself. It checks the first 1,000 entries and
both next markers, then verifies that the second page contains the final upload without repeats.
The application adapter also follows both markers and rejects a repeated or missing marker rather
than silently looping.

Garage CORS is exercised through real signed GET and multipart PUT requests. Bucket CORS is stored
with the configured allowed origins, and authenticated GET/PUT responses reflect an allowed origin
but omit CORS permission for an unlisted origin. Garage's unauthenticated `OPTIONS` handler cannot
resolve S3-created key-local bucket aliases, so it deliberately returns wildcard origins, methods,
and headers for preflight in that case. This means a browser may send an unlisted-origin request,
but the actual signed response is not readable there; the signed URL remains a bearer capability
and must be protected. This local Garage behavior is not an authorization boundary.

When Bun runs on the host for local development, those internal names are not available. The `.env`
file should use host-reachable addresses instead:

- `DATABASE_URL=postgresql://user:password@localhost:5432/fairplay?schema=public`
- `REDIS_URL=redis://localhost:6379`
- `OBJECT_STORAGE_ENDPOINT=http://localhost:9000`

### Production image layout

The Dockerfile exposes four deployment targets:

- `runtime`: production API image with compiled `dist`, production dependencies, Prisma client,
  non-root `bun` user, and a `/health/ready` healthcheck; it does not contain FFmpeg/ffprobe
- `transcoder`: the runtime image plus FFmpeg/ffprobe, with the HTTP healthcheck disabled
- `combined`: local-only runtime plus FFmpeg/ffprobe and API healthcheck for Docker Compose
- `migrator`: one-shot image that runs `bun run prisma:migrate:deploy`

The production release order is:

1. Build and publish the `runtime`, `transcoder`, and `migrator` images for the same source revision.
2. Run the migrator image once with production database credentials.
3. Start the API and transcoder processes with their distinct runtime roles.
4. Route traffic only to the API after `/health/ready` passes. The transcoder has no port mapping.

### First production host: DL360 without an orchestrator

`deploy/systemd/fairplay-api.service` and `deploy/systemd/fairplay-transcoder.service` are sample
systemd units for the initial single-host deployment. They run separate Docker containers from the
two production targets. The reverse proxy points only to `127.0.0.1:3000`; the worker publishes no
port and its application role does not bind an HTTP socket. The worker also has no Redis connection.

The initial DL360 budget is deliberately conservative: the API is limited to four CPU-equivalents
and 8 GiB RAM (4 GiB soft reservation); the worker is limited to two CPU-equivalents and 8 GiB RAM
(4 GiB soft reservation), with one job and two FFmpeg threads. These are cgroup limits, not pinned
physical cores. Docker CPU shares give the API four times the relative weight of the worker during
contention; shares are priority, not a guaranteed CPU reservation. API and worker CPU time is
bounded independently. The 64 GiB host RAM leaves substantial headroom above the combined 16 GiB
hard container limits.

Object data stays in Backblaze B2 through its S3-compatible endpoint. Transcoding still downloads a
source and writes generated HLS locally before uploading it, so the worker's `TMPDIR` must be a
separate 32 GiB filesystem mounted at `/srv/fairplay-transcoder-tmp`. The worker unit asserts that
this is a mount point before starting and bind-mounts it into the container; a missing mount cannot
silently consume the host root filesystem. The 32 GiB filesystem is a hard storage ceiling, not a
tmpfs/RAM allocation. Set its directory ownership to the `bun` UID used by the image.

The dedicated filesystem bounds capacity, not I/O bandwidth. The backing block-device/RAID layout
was not provided, so these units do not apply an ungrounded read/write rate limit; local HLS writes
can still contend with API/log I/O on the same physical device. Before public launch, verify API
latency and disk queue/load during one representative encode. If contention is measurable, place
worker scratch on a separate device or add a device-specific cgroup I/O limit based on that
measurement. Graceful shutdown removes job scratch; a sudden host power loss can leave stale
directories. Monitor this mount's free space and remove stale `fairplay-transcode-*` directories
only after stopping the worker and confirming no job is active.

Both production containers run as the non-root `bun` user with all Linux capabilities dropped, no
new privileges, and a 256-process ceiling. `ffprobe`/`ffmpeg` receive only executable lookup and
temporary-directory environment variables, not API secrets. This is resource/process isolation, not
a complete sandbox for native media parsers: the worker still needs PostgreSQL and Backblaze
credentials plus outbound network access. A parser exploit could therefore act with those worker
credentials; the local-only input protocol and MP4 demuxer restriction do not prevent code execution
inside FFmpeg itself.

To prepare the host, build/tag the API and worker targets as `fairplay-backend:production-api` and
`fairplay-backend:production-transcoder`, create `/etc/fairplay/runtime.env` with shared non-API
settings, database and object-storage credentials (mode `0600`), and create `/etc/fairplay/api.env`
with Redis, SMTP, `RATE_LIMIT_KEY_SECRET`, `AUTH_CODE_PEPPER`, and
`FOLLOWING_CURSOR_ENCRYPTION_KEY` (also mode `0600`). The worker receives only the shared file; it
does not receive Redis, SMTP, or API signing/sealing secrets. Install the two unit files, then enable
them with systemd. The image tags must be updated to the same release before rolling both services.
The worker unit enforces `RUNTIME_ROLE=transcoder`, one slot and its dedicated temporary directory;
the API unit enforces `RUNTIME_ROLE=api` and `VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS=0`. The application
rejects an API configured with a non-zero slot, a production combined role, a worker configured
with anything other than one slot, or more than two threads per production job.

Both processes write structured Pino logs to stdout/stderr, which systemd captures in journald for
collection by the host's Grafana/Loki agent. The API retains the HTTP readiness probe. The worker's
process is supervised by systemd; it intentionally has no HTTP readiness endpoint. Operators should
alert on worker restarts, sustained container memory/CPU limits, and the dedicated filesystem's
free space. Cloud PostgreSQL and Redis are outside the host's local storage and CPU budget.

## Health checks

The health routes are:

- `/health/live`: process liveness only
- `/health/ready`: checks database connectivity, Redis connectivity when Redis is configured, and
  every configured object storage bucket
- `/health`: lightweight process status

Production proxies should use `/health/ready` before routing traffic to an API instance. The worker
does not expose an HTTP health route; its startup checks PostgreSQL and object storage before it
starts claiming work, and systemd supervises its process.

When an established Redis connection is interrupted, new commands issued while the connection is
unavailable fail fast instead of entering the offline queue. A command already sent but not yet
acknowledged can still be resent by ioredis after reconnection, so its outcome remains ambiguous.
The client retries the connection indefinitely with exponential full-jitter delays capped at five
seconds, so a long outage cannot leave the process permanently disconnected. Redis readiness stays
red during the outage and recovers on the same client after Redis becomes ready again. Explicit
shutdown through `quit` or `disconnect` does not reconnect.

Reconnection restores new Redis operations but does not assume that an in-flight lease survived the
server outage. Lease holders still rely on token-checked renewal and treat a failed renewal or token
mismatch as loss of ownership.

## App startup

The entry point is [`src/index.ts`](src/index.ts), it:

- reads the config
- creates external clients like Redis and object storage when configured
- prepares readiness checks
- API/combined roles assemble and start the Express app; the API-only production role has zero
  transcode slots
- the API starts its periodic maintenance job after listening; the production transcoder checks
  PostgreSQL and object storage, then starts its runner without creating an app or listener
- on shutdown, stops maintenance, drains and requeues owned transcodes, closes the HTTP server,
  then disconnects Prisma and Redis

In production, the API requires Redis and object storage; the transcoder requires object storage but
does not connect to Redis. In development, Redis can be unavailable; the backend then falls back to
in-memory rate limiting and skips distributed maintenance locks. Object storage-dependent routes
return a service-level error when object storage is not configured or not ready.

## Maintenance lifecycle

A single non-overlapping maintenance job extends the existing auth cleanup. It runs these isolated
steps in order: expired sessions, expired auth tokens, user-media targets, expired multipart
sessions, abandoned artifact generations, video targets, and videos whose delayed purge deadline
has elapsed. A failed step is reported in the aggregate summary without preventing later steps from
running.

The maintenance job receives separate Uploads, Transcoding, and Video Lifecycle ports. Its one
`ExternalResourceReconciler` call composes the Uploads `source`/`source_thumbnail` handlers with the
Transcoding `hls_artifacts`/`thumbnail_prefix` handlers. Uploads also uses that same reconciler for
immediate source and thumbnail finalization; there is no Uploads-owned reconciliation engine.

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

`POST /videos` deliberately exposes no visibility input. Both the application write and the
database default create video metadata as `unlisted`; the route returns that persisted state but
does not let the uploader choose it. Visibility remains an internal moderation state: approval
makes a video `public` unless administrative deletion is pending, while rejection and
administrative deletion make it `unlisted`. Processing and moderation may complete in either order,
and transcoding never changes visibility. Discoverability still requires `public` + `approved` +
`ready`, whereas a `ready` unlisted video remains readable through its direct public id.

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

An optional source thumbnail follows the existing profile-media write protocol. The authenticated
multipart route validates the real JPEG/PNG/WebP signature, then Sharp applies EXIF rotation,
center-crops to 16:9, and writes a 1280x720 WebP. PostgreSQL reserves a dedicated
`source_thumbnail` exact target before the PUT; HEAD verification and creation of the
`VideoSourceThumbnail` row are finalized together. Replacing it schedules the previous target for
delayed cleanup instead of deleting it inline.

`complete` freezes only a confirmed `VideoSourceThumbnail` scoped to the same user, video, and
upload session. A thumbnail target still `writing` at that point is deliberately ignored so a
thumbnail failure cannot block the video: the session changes to `completing`, the late thumbnail
reconciliation redirects that target to `absent`, and transcoding uses the FFmpeg fallback.
Uploads attempted after the session closes return a conflict and cannot create an untracked
object.

The `src/modules/videoUploads` module owns the six multipart HTTP operations, their schemas,
responses, OpenAPI definitions, upload errors, service, source reconciliation handlers, and
expiration maintenance port. It remains mounted at `/videos` to preserve the existing paths and
middleware order. The Video module retains metadata, catalog, playback, rating, and lifecycle
operations; Transcoding retains artifact generation and abandoned-generation scheduling. Session
responses use an explicit field whitelist and omit the storage bucket, object key, and multipart
upload handle. Part-signing responses still return short-lived S3 signed URLs because direct-to-S3
multipart upload requires them; those URLs are bearer capabilities and contain the signed request
parameters until they expire.

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

Three residual risks are accepted without adding more distributed coordination. An external write
that continues for more than the one-hour quiescence window could finish after cleanup. Transcode
ownership assumes independently generated UUID `executionId` values do not collide; this is
cryptographically negligible, while a monotonic claim version would add coordination complexity
without a proportionate benefit here. Finally, playback resumed after a pause longer than one hour
while its generation is being replaced can receive a 404 for an old segment: the quiescence window
may expire and reconciliation may confirm the old generation absent during that pause. Cleanup
removes the whole generation prefix, not one isolated segment, so every retry and rendition can
fail together and hls.js may surface a fatal playback error instead of skipping one missing
segment. This is the accepted consequence of the same cleanup window and is not extended by
readers; coordinating reconciliation with reader leases would add disproportionate complexity.

Video rejection emails have two accepted best-effort limitations. A rejection immediately followed
by approval can still send its rejection email when SMTP was already in progress; PostgreSQL keeps
the final `approved` state canonical, while the email describes a real transition rather than
mirroring the current state. A server crash exactly after the moderation transaction commits but
before the SMTP call permanently loses that email, with no automatic retry; a later re-rejection
does not send another message because it is not a new rejection episode. A transactional outbox
would close these windows, but its coordination and operational cost are disproportionate for this
secondary notification effect.

Administrative video-deletion emails have the same post-commit delivery boundary. In the concrete
race where moderation commits a deletion request and begins SMTP delivery, then the owner
immediately hard-deletes the video, the owner still receives the one legitimate administrative
notice even though the row no longer exists when the message arrives. The inverse lock order is
stronger: if owner deletion commits first, moderation returns 404 and sends no email. The first
window is expected to be rare because it requires the owner request to overlap the short
post-commit SMTP interval, and its impact is a stale but truthful notice about an action that did
occur. Making that email cancellable would require a transactional outbox plus cancellation and
delivery fencing; that coordination is disproportionate for this secondary effect and is therefore
not implemented.

## Video deletion lifecycle

`DELETE /videos/:publicId` is owner-only even when the authenticated caller has a moderation role.
It first avoids locking foreign identifiers, then rechecks ownership under the common hard-delete
transaction. That transaction locks transcode jobs before the video, selects every durable video
resource target directly by `videoId`, moves each non-absent target toward `absent`, and deletes the
video. PostgreSQL cascades comments, comment likes, ratings, views, upload sessions, transcode jobs,
and artifact generations. Selecting targets by their retained scalar `videoId` is essential: an
initializing or uploading source is not yet attached through `Video.sourceUploadSession`.

`POST /moderation/videos/:videoId/deletion` is restricted to validated moderator and administrator
sessions. Its first locked request records `deletionRequestedAt`, `deletionReason`, and the
category-only `deletionOrigin`, changes visibility to `unlisted`, and sends one dedicated
post-commit notice. Repetitions preserve the first request and send no second email. Rejection
fields remain independent, and neither deletion reason nor origin is present in a public or owner
video DTO. `deletionOrigin` is retained only while the video row awaits purge; it is operational
metadata for that retention window, not a permanent audit log. A later approval cannot restore
public visibility while deletion is pending.

Routes and services use the role allowlists declared in `src/modules/admin/authorization.ts`; they
remain two distinct authorization checkpoints. The role set and `AuthRole` type remain in
`auth.roles.ts`. Session validation supplies only a request-time role preflight. Every
account-administration and video-moderation service call receives the actor identifier and locks the
corresponding `users` row before its authorization becomes final. Account administration locks the
actor before inspecting or mutating its target. Video mutations preserve the established lifecycle
order by locking the video first and the actor second. Privileged list reads lock the actor for the
duration of a `ReadCommitted` transaction: if that lock waits behind a revocation, its statement sees
the newly committed role instead of retaining an older snapshot. The locked row must still exist, be
unbanned, and carry the role required by the route. Bans and role changes write that same user row,
so PostgreSQL orders them with in-flight privileged work: a revocation that commits before the actor
lock is acquired is observed and the operation returns `403`, without a business write or
post-commit email. A deletion request records `deletionOrigin` from this locked role rather than from
the earlier session snapshot. Conversely, if the privileged transaction acquires the actor lock
first, revocation waits until that transaction commits or rolls back. The actor lock must not be
moved into a separate authorization transaction. The account-role integration tests cover both
orders with real PostgreSQL lock waiters and read the committed target state from the revoking
connection for the action-first case.

A ready video pending administrative deletion remains readable by direct link during retention,
matching rejected-video behavior, but disappears from feeds, search, and public profile catalogs.
The shared engagement predicate additionally requires `deletionRequestedAt IS NULL`, so new or
updated ratings, comments, replies, and comment likes are closed immediately and `commentsOpen` is
false.

The single maintenance purge selects both expired rejection episodes and expired administrative
deletion requests. Eligibility is rechecked while the video row is locked and uses an OR between
the two deadlines, so when both exist the older deadline wins and a later administrative request
cannot postpone rejection cleanup. Every eligible row then passes through the same hard-delete
protocol described above; there is no parallel cleanup implementation.

Profile-media uploads reserve a writing target before PUT. Persisting the asset and confirming its
target happen in one serializable transaction; replacement schedules the previous exact target in
that same transaction. Account deletion locks the user’s transcode jobs, schedules every retained
target, deletes only the user row, and relies on PostgreSQL cascades for sessions, tokens, videos,
and media rows. Temporary S3 failures therefore report deferred cleanup without rolling back the
business deletion.

Profile JSON exposes opaque same-origin avatar and banner paths only when the corresponding asset
row exists; building list responses never performs a storage HEAD. The public media routes use the
dedicated profile-media storage client to read bounded bytes and proxy them through the API, so
neither a signed destination nor a bucket/object key appears in `Location`. The media lookup uses
the same verified, non-banned visibility scope as the public profile. A banned, unverified,
missing, or medialess profile and a missing stored object all return the same 404 on the media
route. This client remains separate from video/HLS storage even though both consumers share the
neutral asset-link primitives.

Public-profile, follow-mutation, and followed-profile responses are serialized through explicit
field whitelists and never include the PostgreSQL user UUID. The profile service may return that
UUID separately to the profile-video controller for its internal owner filter, but response mappers
cannot serialize it. `GET /profiles/me/following` keeps the database keyset
`(UserFollow.createdAt, UserFollow.followingId)` while exposing it only as a versioned,
AES-256-GCM-authenticated opaque cursor. Every replica must use the same 32-byte
`FOLLOWING_CURSOR_ENCRYPTION_KEY`; rotating the key deliberately invalidates cursors already issued.
Empty, malformed, altered, obsolete, and raw-UUID cursor inputs all converge on the same generic
400 response.

## Video transcoding and admission

The worker implementation lives in `src/modules/videoTranscoding/`. `runner.ts` owns polling,
slots, job execution, and graceful shutdown; `jobs.ts` owns claiming, heartbeats, ownership checks,
retries, and shutdown requeueing; `artifacts.ts` owns generation reservation/publication and durable
artifact reconciliation; and `media.ts` owns ffprobe validation and FFmpeg output. The injected
Prisma, object-storage, clock, configuration, binary, and logger surface is defined in
`dependencies.ts`. The module barrel exports only the worker factory and maintenance entry points.
Shared `objectKeys.ts` and `hls.ts` helpers live in `src/modules/videos/shared/` because uploads,
transcoding, and playback use the same artifact rules. Readability scopes and the common not-found
error also live there so Comments, Uploads, and Admin use the same definitions as Videos.

Production separates the HTTP API from the transcode runner with `RUNTIME_ROLE=api` and
`RUNTIME_ROLE=transcoder`. The API must use `VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS=0`; the initial
DL360 worker uses exactly one slot. A slot is held for the entire source download, probe, FFmpeg
execution, artifact upload, verification, and publication cycle. `RUNTIME_ROLE=transcoder` does not
create Express, bind a socket, start the maintenance loop, or connect to Redis. The development-only
`combined` role keeps local Compose convenient and is rejected in production.

Before S3 multipart initialization, one serializable transaction counts queued/processing jobs and
upload sessions that reserve a future job. Initializing, initiated, and uploading sessions count
until durable abandonment commits, including past their deadline; a `completing` session counts
regardless of its expiry. Admission first runs the existing expiry transition globally, in a
bounded batch of 100, within that transaction. Maintenance handles larger backlogs; when still
full after this bounded sweep, admission rolls back and returns 429.
Admission is refused when the configured global limit (10 by default) or per-user limit (2 by
default) is already full, returning one generic 429. The transaction creates the upload reservation
only after this check, so a rejected request does not create a target/session or contact object
storage. On successful upload completion, the same transaction changes the session to `completed`
and inserts the queued job, transferring rather than releasing the capacity reservation. This
bounds the number of admitted sources as well as queued work. The existing due-time/id claim order
remains; the per-user ceiling prevents one account from occupying more than two of ten admitted
slots, but it is not a weighted round-robin scheduler.

### Idle upload reservations

`expiresAt` is the effective idle deadline, initially 15 minutes; `hardExpiresAt` is the immutable
absolute deadline, initially 24 hours. Both durations are configurable; idle must be at least
60 seconds and cannot exceed hard. A 20-second idle TTL fails configuration validation.
The migration preserves existing absolute deadlines and gives expirable sessions at most 15 minutes
of grace; completing sessions are unchanged. Deploy client renewal support with the migration.
The new hard deadline is required and has no database default. Stop old API writers before applying
the migration and reopen uploads with the updated API; old binaries cannot initialize new sessions
against the migrated schema. This migration does not support mixed old/new API writers.

The existing parts/sign endpoint reserves its persisted progress-check interval under the session
lock, then observes ListParts outside the SQL transaction. The interval is half the time remaining,
rounded down to milliseconds and clamped between 5 and 30 seconds. It stays at 30 seconds while at
least one minute remains; a check at T−10 schedules the next at T−5 rather than T+20. Every admitted
check reserves at least 5 seconds, including on storage failure, and suppressed requests never
shorten that reservation. Existing cooldowns survive rollout, so one already reserved by the old
version can still last 30 seconds. Actual observations remain outside the SQL transaction.
Listing validates numeric part
metadata, strict ordering and increasing page markers, and is bounded by the expected part count
(at most 10,000), storage timeout and pagination bound. Overflow or malformed listing fails closed.
Only distinct in-range parts of the expected full or final size contribute bytes. A serializable
transaction locks and rechecks ownership, ban, live status, present target intent and a fresh idle
deadline before comparing the snapshot against `verifiedUploadedBytes`. Only a strict increase of
that persistent maximum renews expiry, capped by hard expiry. Rewrites, ETags, dates, GET, signing
alone and thumbnails cannot manufacture progress. An older snapshot cannot consume the same gain
twice. Provider errors never grant time. A valid part still in flight is not progress; the initial
64 MiB part requires roughly 0.60 Mbit/s within 15 minutes, excluding network overhead.

The signing response whitelists the current `expiresAt` beside the existing session ID and part
URLs. Clients must call it between completed transfers, even with presigned batches, and budget
at least 5 seconds for a suppressed check to become eligible again plus network, S3 and SQL
processing time before expiry. A 200 with unchanged `expiresAt` is not a renewal acknowledgment;
retry with that margin still available. A part arriving in the last 5 seconds, unavailable storage
or a delayed transaction has no guaranteed renewal. ListParts and the fresh locked application
must finish before expiry; no grace or unverified extension is granted. A larger operational margin
is necessary for slow connections, unavailable providers or the old cooldown during rollout.
Each URL is clamped to the earlier of its configured lifetime and the reservation deadline when
signed, after bucket preparation. SigV4's timestamp and TTL use the same instant, so delayed signing
cannot push the URL's actual deadline past the reservation. A renewal does not extend already issued URLs. Final ownership,
status and deadline checks prevent returning capabilities after a delayed sign operation loses its
live session. The existing session ID/status contract is retained; no storage key, upload handle,
hard deadline or progress counter is newly exposed outside bearer URLs.

Completion locks the session and reads a fresh application-clock deadline after the lock wait before
entering `completing`. Expiry uses the same row lock before the existing durable absence intent and
lease invalidation. Thumbnail reservation and finalization also recheck under that lock. A late S3
initialization cannot revive an expired session; its returned multipart handle is persisted on the
durable target even if the session/video was removed, for ordinary cleanup. Already completing
requests keep their existing lost-response recovery semantics regardless of age. If a new handle
arrives after confirmed absence, it reopens the same absence intent and quiescence, charging the
target again until cleanup confirms absence. Ordinary absence requests keep a confirmed absence terminal.

The rolling-hour budget is two admitted source reservations per account by default. The serializable
admission transaction counts existing `ExternalResourceTarget` source rows created in that hour
before inserting the next reservation. These targets already survive session/video/account cascades
and confirmed cleanup. Abort, deletion, provider initialization failure and IP changes do not refund
an admission. No parallel counter, Redis dependency or fact table is added. The existing user/role
index is reused; very large source histories may make this count expensive and need an indexed
time range once measured. Any future target-history purge must preserve at least this hour of facts.

The five-account zero-transfer attack now occupies capacity for at most the idle period at each
hour's budget renewal, rather than continuously. This is not protection against unbounded verified
accounts or transfers that make real useful progress. Two starts per hour also restrict legitimate
bursts and retries after storage outages; tune the budget and idle window together.

Admission capacity and storage quota remain distinct: durable abandonment frees the former, while
only confirmed absence frees reserved source bytes. Old UploadPart URLs cannot complete or publish
an abandoned reservation, though a provider may accept a late PUT before URL expiry/abort. Existing
quiescence, durable handles, repeated abort/deletion and HEAD confirmation remain authoritative.
Previously issued URLs are not retroactively shortened. The separate oversized-body/repeated-storage
amplification issue is not fixed by this policy.

Garage tests observe actual uploaded parts, a 1,001-part paginated listing, old-capability replay and
cleanup. PostgreSQL regressions observe real `Lock` wait events for completion/expiry, competing
progress snapshots, thumbnail finalization and budget contenders. Counter-tests temporarily remove
the respective deadline/high-water/budget checks and require a failing assertion before restoring
them; the implementation validation record states the observed results.

Backblaze B2 is the production provider; Garage is a local test provider. The opt-in
`scripts/verify-b2-upload-contract.ts` uses an existing isolated B2 bucket and only a random test
prefix. It checks real part sizes and retries, bounded listing, signed-deadline parameters and
rejection after actual URL expiry,
completion retry/HEAD recovery, and old URL rejection after complete/abort, then removes its own
versions and handles. It does not observe physical reclamation, browser
behavior, or a PUT already in flight during abort. No isolated B2 credentials were available, so
these provider guarantees remain unqualified. Run this script and explicitly exercise in-flight
PUT/abort before claiming production qualification; SDK arguments or Garage results cannot supply
that evidence. The byte-limit fix is a separate task.

A `completing` session retains its capacity reservation while the durable source target is being
reconciled: multipart completion may have succeeded even when its response was lost. Its age or
upload expiry never releases this reservation. A conforming object can still be recovered and
published after expiry, transferring the reservation to its queued job.

ETags are opaque strings, not MD5 values. Completion crosses a JSON-to-XML boundary: JSON decoding
produces a JavaScript string, HTTP retains its existing trimming, and the S3 SDK serializes and
escapes that string into UTF-8 XML. The HTTP schema and business validation share the same
[XML 1.0 character check](https://www.w3.org/TR/xml/#charsets), applied to the original string before
trimming or UTF-8 replacement can conceal invalid input, and before parts are frozen or the session
changes to `completing`. Forbidden controls, isolated UTF-16 surrogates, U+FFFE and U+FFFF are
rejected; valid Unicode and XML punctuation remain opaque and are escaped by the SDK. HTTP rejects
incompatible input with 400 without storing parts or calling S3. The service also rejects direct
calls before persistence. Such a rejected request leaves its existing initiated upload governed by
the ordinary upload expiry; it never creates an indefinitely retained completing reservation.

Multipart completion preserves a typed rejection for `InvalidPart`, `InvalidPartOrder`,
`EntityTooSmall`, `NoSuchUpload`, and `MalformedXML`. Garage's specific `InvalidRequest` response with the message
`Bad request: No data was uploaded` is also recognized; other `InvalidRequest` responses remain
retryable. These codes describe the completion operation, not a general storage error policy. After
any completion error, HEAD still checks the actual object: a present object must pass the normal
size verification, and a failed HEAD leaves the result ambiguous. Only a recognized rejection with
a successfully observed absent object takes the terminal abandonment path.

That path extends the existing size-mismatch redirection. One serializable, lease-checked
transaction changes the session to `aborting`, redirects its source target to `absent/quiescing`,
invalidates the reconciliation lease, schedules its confirmed source thumbnail for absence, and
resets a video without an existing source or another active upload to `draft`. Admission capacity is released
only when this transaction commits. Storage quota continues to include these targets until cleanup
confirms their absence. The canonical one-hour quiescence, multipart abort, object deletion, and
absence verification remain unchanged; successful cleanup then changes the session to `aborted`.
HTTP completion returns the existing generic 409 session-state conflict for the rejected
completion and subsequent retries. Storage implementation details are not serialized.

Both immediate HTTP completion and maintenance use this transition, so existing invalid
`completing` sessions recover at their next due reconciliation without client cooperation. The
existing backoff is retained, including its 24-hour cap. Unrecognized, configuration, network,
timeout, and server failures remain retryable and can still reserve capacity indefinitely during
sustained storage failure; monitor these targets and use the existing abandonment/cleanup protocol
for operational cancellation. Never release capacity by editing session or target rows directly.

`tests/integration/uploads.terminal-completion.integration.ts` observes the actual Garage codes for
empty uploads, incorrect uploaded ETags, missing multipart uploads, and malformed completion XML.
It checks HTTP responses and
the serialized session whitelist, real objects and persisted multipart handles, capacity reuse,
storage quota, maintenance recovery, and successful publication with exactly one job.

The two transaction orderings wait for actual PostgreSQL `wait_event_type = 'Lock'` on the target
renewal or session update. Their test-of-test removes the renewal step or the abort transaction's
serializable isolation and observes failures. Additional temporary removals verify classification,
atomic domain abandonment, HEAD recovery, and the final lease-expiry checks. The late-takeover
counterexample removes the lease/session publication checks and simulates rewriting the goal and
quiescence from the old snapshot; it then observes a published source after slot reuse. Removing
only application checks while preserving the current absence intent also hits PostgreSQL's
independent goal/state and lease constraints. These mutations are restored before the normal
verification suite; no database constraint is changed.

The six ownership filters share the private `ownedTargetWhere(target, checkedAt)` helper. Every
query still supplies its own check time, including fresh clock reads after domain publication or
abandonment work. Real PostgreSQL regressions observe those domain writes inside the transaction,
then expire the lease and verify their rollback. Replacing either final check time with its
pre-handler timestamp fails the corresponding regression; the proper final timestamps are restored
before the normal verification suite.

The JSON-to-XML regressions first reproduced ten failed maintenance claims and a sixth account's
429 with historical `completing` rows containing U+0001, U+001F or U+FFFF and no uploaded parts.
With the fix, all ten claims redirect to absence and the sixth account receives 201. HTTP attacks
are separately rejected before parts are persisted; their ordinary initiated reservations remain
expirable. Both direct service calls and raw HTTP strings containing forbidden controls (including
ones that trimming would otherwise remove), U+FFFE/U+FFFF, NUL and isolated surrogates are tested.
Real Garage tests retain opaque Unicode and escaped XML punctuation, and verify HEAD for historical
MalformedXML: an absent object is abandoned, an unavailable HEAD is retried, and a conforming
present object publishes once. A stale MalformedXML claim cannot publish after abandonment and
slot reuse, even when real bytes subsequently arrive. Temporary removal of the HTTP check, business
check, pre-trim ordering, MalformedXML classification or HEAD requirement fails its respective
regression. The existing PostgreSQL lock barriers and publication fences also remain covered.

#### Completion and abandonment invariants

| Untrusted input and source of truth                                         | Transformation                                                                              | Enforcement point                                                                                                                                                                    | Bypass or boundary case                                                                                      | Observable counterexample test                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client JSON ETag; XML 1.0 Char and actual Garage parsing/HEAD               | JSON decoding → raw-string validation → existing trim → SDK XML escaping and UTF-8 encoding | Shared HTTP/business check before freezing parts; MalformedXML + successful absent HEAD uses the existing atomic abandonment                                                         | Controls hidden by trim, NUL, isolated surrogates, U+FFFE/U+FFFF; old persisted rows bypass new input checks | Hostile HTTP/direct calls persist no parts; real Garage returns MalformedXML for legacy inputs; ten old slots recover by maintenance and HEAD still preserves real objects |
| Client parts/ETags; frozen PostgreSQL parts and real S3 response/HEAD       | Completion rejection becomes absence intent                                                 | Lease-checked serializable redirection commits session and target together                                                                                                           | No PUT, wrong ETag, missing multipart upload, existing expired session                                       | Five accounts' ten fictitious HTTP completions terminate and a sixth account is admitted                                                                                   |
| Completion response; real object metadata                                   | Lost response recovers an object with the reserved size                                     | HEAD and ordinary publication transaction                                                                                                                                            | Completed upload returns NoSuchUpload; unavailable HEAD must remain ambiguous                                | Actual Garage object is published once after a lost response, while unavailable HEAD retains completing                                                                    |
| Obsolete target snapshot; current PostgreSQL goal, state, lease and session | Delayed external completion attempts publication after abandonment                          | Renewals and finalization require the current goal and live lease; domain publication requires completing; guarded final target update shares the transaction with source/job writes | Lease takeover, abandonment after real completion, late bytes arriving after slot reuse                      | Actual PostgreSQL lock waits in both orders; resumed old reconciliation creates no source or job and late objects are cleaned                                              |
| Session age; durable source intent                                          | Expiry does not prove definitive invalidity                                                 | Completing stays in admission accounting until publication or abandonment commits                                                                                                    | Transient failure at +48 h; valid late completion                                                            | Old ambiguous session keeps its reservation; old conforming source still queues one job                                                                                    |
| Source reservation; target's confirmed absence                              | Capacity release precedes storage quota release                                             | Existing admission and quota queries plus confirmed cleanup                                                                                                                          | Late object or thumbnail survives logical abandonment                                                        | Admission can resume while quota stays charged; real cleanup removes objects/handles and terminates aborted                                                                |

```mermaid
sequenceDiagram
participant Runner
participant DB as PostgreSQL
participant S3 as Object storage
participant FF as ffprobe / ffmpeg

Runner ->> DB: claim queued or stale job (SKIP LOCKED)
DB -->> Runner: processing + new executionId
Runner ->> S3: download persisted current source
Runner ->> S3: download confirmed source thumbnail, when present
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

FFprobe metadata is validated before encoding. Sources below 240p fail permanently; sources from
240p through 479p emit only 240p, while sources at 480p and above emit the fitting 480p, 720p, and
1080p ladder entries. A single direct FFmpeg process creates those H.264/CRF 24 HLS VOD renditions
without upscaling, with even dimensions, six-second segments, AAC 128k audio when the source has
audio, and a WebP fallback thumbnail. Each master-playlist `BANDWIDTH` value is the matching video
VBV bitrate plus optional audio, with a 10% allowance for MPEG-TS/HLS overhead; it is therefore not
reused as the encoder's video-only `maxrate`. When the
completed source session has a confirmed custom thumbnail, the runner replaces that local
fallback before artifact enumeration and uploads the bytes to the generation's own immutable
`thumbnail/poster.webp` key. Different generations never reference the shared source object.
Publication schedules the consumed source thumbnail for reconciliation cleanup in the same
transaction that activates the generation. Encoder and filter threads are bounded by
`VIDEO_TRANSCODE_THREADS_PER_JOB`; child output retained in memory is also bounded. Abort sends
`SIGTERM`, followed by `SIGKILL` after five seconds if necessary.

The launch media policy accepts at most 30 minutes, 3840 pixels on either raster or square-pixel
display dimension, 8,294,400 raster or display pixels, a 4:1 raster or display aspect ratio in
either orientation, and 30 average FPS. An FFmpeg `max_pixels` decoder option repeats the metadata
pixel ceiling. Display dimensions include the sample aspect ratio and quarter-turn container
rotation; FFmpeg autorotation plus rendition and fallback-thumbnail filters normalize the result to
square pixels. Other rotation angles are rejected. FFprobe has a 30-second deadline and FFmpeg a
two-hour deadline; either deadline terminates the child with the same `SIGTERM` then `SIGKILL`
sequence. Inputs are restricted to the local `file` protocol and the MP4-family `mov` demuxer, so a
probed upload cannot select a playlist demuxer or make FFmpeg fetch remote network resources.
FFmpeg repeats the 30-minute and 30 FPS ceilings on rendition outputs and combines CRF with
per-rendition VBV `maxrate`/`bufsize` limits. After generation, the runner sums every playlist,
segment, and thumbnail and refuses to upload anything when the total exceeds 4 GiB. Invalid or
out-of-policy media, ordinary ffprobe rejections, child timeouts, and oversized artifact sets fail
permanently. An unexpected signal termination, a non-zero FFmpeg exit, or process spawn failure
remains retryable because it can represent a transient infrastructure error. All values are
startup-validated `VIDEO_TRANSCODE_*` settings documented in `.env.example`.

Artifact upload is not fully streaming yet: the runner buffers one generated file at a time before
calling object storage. With the current six-second, VBV-limited HLS segments this normally bounds
the buffer to one segment rather than the full generation, and the worker memory cgroup contains
an unexpectedly large file to the worker. The upload implementation remains a memory-scaling limit
if segmenting or bitrate policy changes; do not relax the worker memory limit based only on the
cumulative artifact-size ceiling.

The cumulative artifact check runs after local generation and before upload; it is not an operating
system filesystem quota. At the launch defaults, the expected upper bound per slot includes the
3 GiB source and 4 GiB generated artifacts (about 7 GiB, plus a small thumbnail). The worker's
separate 32 GiB mounted filesystem is the actual hard ceiling and keeps an unexpected temporary
spike off the API/root filesystem. The artifact-size check remains post-generation; the filesystem
ceiling is therefore the final protection if customized media settings or FFmpeg behavior exceed
the expected bound. Do not increase concurrent worker slots without resizing/restricting temporary
storage for their combined peak.

Each execution writes to a unique generation namespace. Its database generation and prefix cleanup
targets are reserved before any potentially ambiguous artifact upload. The runner verifies the
master playlist, thumbnail, every rendition playlist, and at least one real segment per rendition
before attempting publication. Publication locks and checks the job, current source,
`executionId`, and `writing` generation in one serializable transaction. The same transaction
activates the new generation and renditions, completes the job, and moves the prior active
generation to `retiring` with one-hour-delayed prefix cleanup. A late execution cannot publish
after takeover; ambiguous upload failures leave a durable generation that can only be cleaned, not
mistaken for active output.

## Public HLS reads

Public HLS routes use the unguessable `publicId` as the shareable link and require no session. A
video is readable while it still exists, its processing status is `ready`, and its visibility is
`public` or `unlisted`, regardless of moderation status (`rejected` included). Its generation must
be `active` or `retiring`. All unavailable, cross-video, cross-generation, and cross-rendition
cases return the same 404. The master resolves only the current active generation;
generation-qualified rendition and segment URLs remain usable while that generation is retiring.
Those public URLs contain a random 256-bit lowercase-hex generation token with a unique database
constraint, never `VideoArtifactGeneration.id`. The lookup binds the token to the requested video,
readability scope, generation lifecycle, and rendition. Generated HLS and poster objects live under
`artifacts/<publicToken>/`; signed redirect URLs therefore contain only that public token and never
the user, video, or generation UUID. Those UUIDs remain internal relational/lifecycle identifiers.

`GET /videos` and `GET /videos/search` share one concrete public-catalog query path: the
`public` + `approved` + `ready` scope, `(createdAt, publicId)` cursor, bounded page size,
`RepeatableRead` page/count transaction, and next-cursor calculation cannot drift between them. The
feed always sorts newest first and omits the search-only text filter. Their output mappers remain
distinct whitelists because feed cards intentionally exclude descriptions, tags, ratings, avatars,
and playback data. Both routes return `Cache-Control: no-store`.

The search response composes that video page with a separate, fixed-size creator section. Creator
eligibility reuses the public-profile scope (`is_verified = true` and `is_banned = false`) and never
serializes either status. At most ten creators are returned: a case-insensitive exact username match
comes first, then username/display-name partial matches ordered by username. The partial query
explicitly excludes the exact username, and a final username-based guard keeps the public list
duplicate-free. Both creator reads run in one short `RepeatableRead` transaction, so their profile
visibility and aggregates come from one snapshot; this creator snapshot remains intentionally
independent from the video catalog snapshot assembled concurrently for the same response.

Account status and video-content moderation are deliberately independent policy axes. Banning an
account does not withdraw that account's already approved videos from the public feed, video search,
direct detail, thumbnail, or HLS playback. Those surfaces continue to apply their established video
discoverability or readability predicates without adding `owner.is_banned` or
`owner.is_verified`. The same banned account is excluded from creator-search results and public
profile lookup by the public-profile visibility scope. This asymmetry is intentional, not an omitted
owner filter: banning controls account access and public-profile visibility, while every video
surface remains governed solely by its established video moderation and lifecycle predicates.

Video title/description search and partial creator username/display-name search currently use
escaped literal `ILIKE` contains predicates without trigram indexes. Page and creator limits bound
the response size but not the rows PostgreSQL may inspect: video search can scan a significant part
of `videos`, and creator search can scan a significant part of `users` before applying its limit of
ten. The project deliberately does not enable `pg_trgm` without production-volume evidence that
justifies the extension and write/index cost. Re-evaluate both query plans and workload-specific
trigram indexes when real cardinality or latency makes that cost concrete. A dedicated
`/videos/search` rate limiter is a separate defense-in-depth option to evaluate at that point; it is
not a substitute for an appropriate query plan and is not part of the current design.

The catalog deliberately relies on the publication invariant that a `ready` video has an active,
usable artifact generation instead of duplicating the playback-generation predicate in the
discoverability scope. A database drift that removed an active generation without updating the
video status could therefore expose a feed card whose detail later returns 404. This residual risk
is accepted because the normal publication and cleanup paths update those states coherently. The
shared catalog query currently selects the union of search-summary and feed-card columns; the feed
discards search-only metadata in its whitelist mapper. That bounded over-fetch is accepted as minor
debt to keep the shared scope and pagination path simple.

FFprobe duration is rounded up to a positive whole second and persisted on `videos` in the same
publication transaction that marks a video `ready`. PostgreSQL rejects any `ready` video with a
null duration. Public feed cards and playback details therefore expose the same non-null `duration`
value without probing media or object storage during a read.

`GET /videos/:publicId` assembles the public playback-page detail in one short PostgreSQL
`RepeatableRead` transaction. The video, owner, database presence of the owner's avatar, rating
aggregate, view and comment aggregates, and optional current-user rating therefore come from one
snapshot.
Missing, malformed, expired, or revoked authentication degrades to an anonymous read, and the
response is always `Cache-Control: no-store`. The response exposes only opaque same-origin avatar,
thumbnail, and active-master paths; it performs no object-storage read while assembling the JSON.

After that read transaction commits, an authenticated non-owner detail load schedules a detached,
best-effort view write. Anonymous loads and owner loads never count. `video_views` stores one fact
per `(user, video, UTC day)`, while `videos.view_count` keeps the public aggregate cheap to read.
One atomic `INSERT ... SELECT ... ON CONFLICT DO NOTHING` both rechecks that the viewer is not the
current owner and increments the aggregate only when a new daily fact was inserted. Repeated or
concurrent loads on the same UTC day therefore count once. The response does not wait for this
write, so its snapshot may precede its own increment; writer failures are logged without failing
playback. Account deletion subtracts all of the user's per-video view facts before cascade deletion,
inside the same serializable transaction used to repair rating aggregates. A user's own view days
are included only in the authenticated `/auth/me/export`; public contracts expose the aggregate,
never viewer identities or dates.

`POST /auth/me/export` includes the account ban reason, both directions of follow relations, and
metadata for videos owned by the account, alongside ratings, view facts, attributed comments
(including soft-deleted tombstones), personal comment likes, and sessions. Collection data is read
with bounded keyset cursors and streamed to the HTTP response. Follow relations expose usernames
and display names, not internal user IDs. Video metadata uses the public video ID and excludes
media bytes, storage keys, and other media assets by design.
It never builds an unbounded fact array or pretty-prints the complete document in memory; HTTP
backpressure limits production to the client's consumption rate. Only bounded account fields and
latest-token metadata are serialized before streaming starts. Each exported fact table has a
composite index matching its user filter and stable cursor order. Cursor queries repeat the temporal
lower bound outside their tie-break `OR`, allowing PostgreSQL to seek to that boundary instead of
rescanning and sorting all earlier facts; only rows sharing the exact boundary value need the final
tie-break filter. The reverse follow index supports the same bounded ordering for followers as the
existing index does for following. One per-user local mutex covers both export and account deletion
in a process;
when Redis is configured, the same lease is shared
across instances and renewed until the controller's operation promise settles. A client disconnect
after the operation starts does not release either lock while export generation or account deletion
is still running. A disconnect during Redis acquisition prevents the operation from starting and
immediately releases any lease acquired after that disconnect. An export and an account deletion
therefore cannot overlap for the same user in either order while the local mutex and shared lease
remain owned: the second attempt receives 409 rather than starting another scan or deleting rows
underneath an active stream.

Comment likes are the exception to temporal cursor ordering: they page by stable `comment_id` under
the `(user_id, comment_id)` primary key. An unlike/re-like therefore cannot move the same logical
fact beyond an already-emitted cursor and duplicate it in the stream.
If a database error occurs after headers have been sent, the server logs it structurally and closes
the chunked response without the final JSON delimiter; clients must treat the interrupted transport
or invalid JSON as an incomplete export and retry.

Multipart upload sessions and their parts remain outside the export contract; they are not added by
this change. Media assets and video bytes are also intentionally excluded, as requested.

`GET /videos/:publicId/thumbnail` applies the same readiness and visibility rule, without a stricter
moderation rule, and requires an active generation. It rebuilds the opaque-token thumbnail key from
`buildVideoArtifactManifest`, checks the object with HEAD, and returns a non-cacheable temporary
redirect to a freshly signed object-storage URL; Express never proxies the image bytes.

Readability is deliberately distinct from discoverability and rating write eligibility. Public
search continues to require `public` + `approved` + `ready`. Rating reads use the same readability
scope as playback, so existing aggregates and the current user's previous rating remain visible on
`rejected` videos. Rating writes retain the stricter scope and reject new or updated votes once a
video is `rejected`.

Comments are implemented as a domain module in `src/modules/comments/`. Its `CommentsPort` owns the
seven comment operations, and its HTTP router is mounted at `/videos`, preserving the existing
`/videos/:publicId/comments...` URLs and OpenAPI contract. The video service port contains no comment
methods. The account-deletion path imports the same comment lifecycle helper so anonymization and
soft deletion continue to use one protocol.

Video comments follow the same read/write distinction. Both public list routes use the centralized
readability scope, so existing threads remain readable for a `ready` public or unlisted video even
after rejection or after comments are disabled. Creating a root or reply uses the stricter shared
engagement scope and additionally requires `allow_comments = true`. Root pages sort newest-first;
reply pages sort oldest-first. Both use a bounded `(created_at, id)` cursor inside a short
`RepeatableRead` transaction. Root `replyCount` values come from one grouped query for the whole
page, never one query per root. Cursor public references are resolved through the same scope as
the current page: visible roots in the requested video, or active replies in the requested thread.
Absent references, foreign references, and boundaries no longer visible all return the same
`404 Comment not found`; a deleted root with surviving replies remains a valid root boundary.
An absent or unreadable video uses that same public 404 body, with or without a cursor.
`listComments` converts `VideoNotFoundError` to `CommentNotFoundError`, following the existing
`listReplies` pattern. The shared HTTP mapper retains its behavior for other comment operations;
the conversion is local to the list service. Validation failures remain 400, and a readable
video without comments still returns an empty 200 page.

| Guarantee                         | Untrusted input / source of truth                                                | Transformations                                                                              | Enforcement                                                                              | Observable regression                                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uniform list 404                  | Video public reference and optional cursor / current PostgreSQL rows             | Scoped video lookup, scoped cursor lookup, domain error, HTTP mapping and JSON serialization | List-service conversion of missing/unreadable video errors to the existing comment error | Real HTTP/PostgreSQL comparisons cover absent or failed videos without a cursor, with an absent cursor or with a known cursor, plus foreign, wrong-kind and deleted boundaries; removing the conversion breaks the root-list test |
| Valid reads remain valid          | Video state and thread membership / existing readability and visible-root scopes | Transactional reads and public DTO serialization                                             | Existing scope predicates and cursor resolution                                          | Empty readable root page, ready unlisted video, valid cursor and deleted root with surviving replies retain 200                                                                                                                   |
| Invalid syntax remains validation | Path and query strings / Zod schemas                                             | Parameter parsing before service invocation                                                  | Existing list route validation                                                           | Malformed video or cursor reference, incomplete cursor pair and invalid timestamp retain 400                                                                                                                                      |

The HTTP comparisons assert status, the complete parsed JSON body, serialized text,
`Content-Type`, `Content-Length`, and `Cache-Control: no-store`. Transport-dependent headers
such as `Date` and `Connection` are outside this equality contract. This regression establishes
response-contract uniformity; it does not establish disclosure of an unreadable video's existence.

Both cursor directions repeat the temporal boundary outside the
tie-break `OR`. Reply pages use a partial
`(video_id, root_id, created_at, id) WHERE root_id IS NOT NULL AND deleted_at IS NULL` index, while
root pages use a partial `(video_id, created_at DESC, id DESC) WHERE root_id IS NULL` index. These
exact paths avoid a bitmap scan/sort for active replies and avoid relying on the nullable `root_id`
prefix of the general thread index for ordered root pagination.

The public video-detail contract exposes `commentsOpen`, an effective write capability, rather than
the owner's raw `allow_comments` preference. It is true only when that preference is enabled and the
video currently satisfies the stricter engagement scope. A rejected video can therefore remain
readable with its existing threads while correctly reporting `commentsOpen: false`.
The preference is accepted as the optional `allowComments` boolean on `POST /videos`, defaults to
`true` at both the HTTP and database boundaries, and is immutable through this API version: no
post-upload comment-settings route exists. This is the deliberately reduced initial contract, not
an accidental omission. A later mutation would need its own owner-authorized endpoint plus explicit
semantics for writes already in flight while the setting changes, so it is deferred until that
contract can be designed independently.

The database stores only one physical reply level: roots have neither `root_id` nor a reply target,
while replies must have both identifiers and may not self-reference. PostgreSQL enforces that null
pairing and the no-self-reference shape with a CHECK. Whether the referenced root and target belong
to the same video and thread is a cross-row invariant that a CHECK cannot express; comment creation
validates it while holding the relevant rows, and public root visibility, grouped reply counts, and
reply pages repeat `video_id` predicates defensively. This same-video/same-thread guarantee therefore
remains applicative rather than structural. A composite self-FK would cover only the same-video half,
not same-thread membership, while complicating Prisma's shared self-relation fields and the target's
partial `SET NULL` semantics; that disproportionate partial constraint is deliberately not added.
Replies are intentionally flattened onto that single root level instead of forming a recursive
tree. Reads can page one ordered relation, `replyCount` remains a direct grouped count, and deletion
can tombstone exactly one row without recursively traversing or rewriting descendants. The separate
`replying_to_comment_id` retains the addressed-participant context without making pagination,
counting, or lifecycle semantics recursive.
Another CHECK makes active comments require content, no
deletion timestamp, and an author; soft-deleted comments require null content and a deletion
timestamp. API DTOs expose deleted roots as author-free/content-free placeholders only while they
still have active replies. Deleted leaves and deleted roots without active replies remain persisted
but are absent from public lists.

The HTTP comment schemas apply the 800-character bound with JavaScript string length, which counts
UTF-16 code units, while PostgreSQL `VARCHAR(800)` counts Unicode code points. The API is therefore
deliberately conservative for astral characters such as emoji; this is a contract precision, not a
storage or security invariant. Presence validation ignores Unicode whitespace and all
`Default_Ignorable_Code_Point` and `Control` characters, including zero-width joiners, variation
selectors, combining grapheme joiners, and C0/C1 controls, only while deciding whether some visible
content exists. It does not strip those characters from otherwise valid stored text, so legitimate
joined emoji sequences and mixed visible/control content remain intact. The `CommentsPort` assumes
its public comment references and normalized content have already crossed the HTTP validation
boundary. Comment references use a persisted opaque `c_` plus 128-bit UUID encoded as hex. The
service resolves them to internal UUIDs before database operations; DTOs, route parameters, reply
references, and cursors use only the public value. A future job or administration script calling
that port directly must reuse the same validation rules rather than treating the service as a
runtime parser for arbitrary input.

Root creation, replies, deletion, and both idempotent comment-like mutations share one authenticated
per-user mutation rate limit of 30 actions per ten minutes. Their deliberately different
anti-amplification and locking protocols form one consistent ownership model:

| Operation    | Indexed preflight before transaction                                          | Row lock order                                 | Aggregate protected                           | Justification                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create root  | None beyond validated/authenticated input                                     | Video                                          | `videos.comment_count`                        | The video owns the aggregate and the locked query atomically checks engagement scope plus `allow_comments`.                                                                                         |
| Create reply | Active root/target membership and video engagement scope                      | Video, then root/target comments in UUID order | `videos.comment_count`                        | Random comment UUIDs cannot contend on a popular video; the locked rows remain the final same-video/thread validation boundary.                                                                     |
| Soft-delete  | Exact comment/video membership and preliminary permission                     | Video, comment, then actor for staff deletion  | `videos.comment_count`, received-like cleanup | Unauthorized or unknown public references never reach locks; locked rows repeat author and exact current video owner, then lock and recheck the actor only when permission depends on a staff role. |
| PUT like     | Exact active comment/video membership, engagement scope, and `allow_comments` | Comment only                                   | `comments.like_count`                         | The aggregate belongs to one comment; a video lock would serialize unrelated likes across a popular video. The transaction freshly rechecks video eligibility in its serializable snapshot.         |
| DELETE like  | Exact comment/video membership, without engagement or lifecycle filters       | Comment only                                   | `comments.like_count`                         | Unlike remains idempotent outside engagement scope and after soft deletion, without exposing whether a fact existed.                                                                                |

Root and reply creation intentionally do not add a separate `allowComments` preflight, unlike PUT
like. Reaching either path already requires authentication and a valid video public identifier (and
for a reply, valid comment identifiers), and the shared mutation limiter bounds repeated attempts.
The authoritative locked video query still checks `allow_comments` before any write; one additional
read on every legitimate creation is not judged worthwhile for that narrower amplification window.

Deletion never applies readability or engagement scope: the current video owner and
moderator/administrator roles may remove a comment from rejected or non-ready videos. The
denormalized `videos.comment_count` counts active comments only and changes in the same serializable
transaction as the lifecycle transition. The delete update itself requires `deleted_at IS NULL`, so
retries and concurrent duplicate DELETE requests cannot decrement twice. Every deletion permission
reuses this exact soft-delete and aggregate protocol. A direct Prisma `comment.delete()` on a root
would let the self-FK cascade erase its reply subtree while bypassing every corresponding
`videos.comment_count` decrement, permanently drifting the denormalized aggregate. Serializable
contention for comment mutations uses up to ten attempts with the shared capped exponential
full-jitter backoff and becomes HTTP 503 if that budget is exhausted.

Author and current-video-owner deletions do not depend on a staff role and therefore do not lock the
actor account. When the preliminary permission depends on `moderator` or `admin`, the transaction
locks that actor after its video and comment locks, then recomputes the deletion origin from the
current role and ban state. This retains the common video/comment lock order used by account
deletion while ensuring that a role downgrade or ban committed first produces the same `404` as any
other unauthorized comment deletion and leaves both the tombstone and aggregate unchanged.

Each new tombstone stores a private `deletion_origin`: author, current video owner, moderator,
administrator, or account deletion. It records the permission category that won the lifecycle
transition, not an actor identifier, and remains absent from public comment DTOs and personal data
exports. Tombstones predating the metadata are backfilled as `legacy_unknown` because author
deletion and account anonymization cannot be distinguished retrospectively. A bidirectional database
CHECK requires active comments to have no origin and every deleted comment to have an origin.
`comment_likes` stores one mutable fact per `(user_id, comment_id)`, with an index for received-like
counting and cleanup. Its composite primary key also provides the stable user/comment order used by
personal-export pagination.
`comments.like_count` is a nonnegative denormalized aggregate. Public root and reply DTOs expose
that aggregate and a bounded current-viewer membership projection only; anonymous viewers always
receive `viewerHasLiked: false`, and no liker identity or liker list crosses the response whitelist.

`PUT /videos/:publicId/comments/:commentId/like` creates the fact and increments `like_count` only
when the fact was absent. Video moderation and comment deletion remain safe under the table's lock
protocol: a like never requests the video lock after acquiring the comment lock.

`DELETE /videos/:publicId/comments/:commentId/like` removes the current user's fact and decrements
only when that fact exists; absent, wrong-video, already-deleted, or already-unliked targets all
converge on idempotent success without exposing resource state. Soft-deleting a comment uses one
shared lifecycle helper that deletes every received like and resets `like_count` to zero in the same
transaction before the tombstone becomes visible. PostgreSQL additionally requires every tombstone
to have `like_count = 0`, so this invariant survives direct or future write paths.

Account deletion first locks every affected video in UUID order, then every authored or liked
comment in UUID order. It subtracts emitted likes from each target comment before deleting those
facts, subtracts the exact number of the user's still-active comments per video, and reuses the same
soft-delete helper to remove received likes and clear authored comment content before deleting the
user.
The `author_id ON DELETE SET NULL` action can then anonymize those preserved rows without violating
the lifecycle CHECK or destroying replies written by other accounts. This depends on the official
account-deletion path soft-deleting active authored comments before deleting the user. A direct hard
delete of an author would make `author_id SET NULL` conflict with the active lifecycle CHECK; likewise,
a direct hard delete of a still-referenced reply target would make `replying_to_comment_id SET NULL`
conflict with the thread-shape CHECK. Future code that touches either FK must preserve the same
soft-delete/anonymization ordering rather than relying on the FK action alone.

Account deletion uses the same serializable full-jitter policy family as ratings and comments, with
a five-attempt budget rather than the ten attempts used by short comment mutations. The lower but
still robust budget limits how long this potentially heavy transaction can retain work across
retries; an exhausted serialization-conflict budget is translated to HTTP 503 so clients can retry
instead of receiving a generic 500.

### Comment domain decision and risk register

This is the single register for accepted comment-domain tradeoffs; the protocol descriptions above
define normal behavior without silently claiming stronger guarantees.

| Decision or residual risk          | Accepted boundary and revisit trigger                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact `total` counts               | Root and reply pages count the full matching set, so cost grows beyond page size. Active replies do have a partial index containing `deleted_at IS NULL`; the root pagination index does not, and the visible-root predicate can still include tombstones with active replies. Revisit at material thread volume, potentially replacing `total` with `hasMore` or adding a workload-specific index. |
| Permanent tombstones               | Soft-deleted rows are not physically purged and continue occupying table/index space. Define an explicit retention or asynchronous purge policy before material volume.                                                                                                                                                                                                                             |
| Synchronous cascades               | Video deletion cascades comments and likes in the current transaction, so maintenance or owner account deletion can become long-running for a very large thread. Move large purges to bounded asynchronous work before material volume.                                                                                                                                                             |
| Transactional staff authorization  | Privileged comment deletion locks and rechecks the actor only after its video and comment rows. This deliberately adds contention with a concurrent role change, ban, or actor-account deletion, while author and video-owner deletion keep the narrower resource-only protocol because their authority does not depend on a staff role.                                                            |
| Redis account-operation lease loss | If renewal fails and a slow export/deletion outlives the five-minute lease, another instance can start an overlapping operation. Lease loss is logged and closes the response but cannot cancel an in-flight Prisma transaction; fencing or true cancellation is deferred at current scale.                                                                                                         |
| Multi-section export snapshots     | Export avoids one long database snapshot: every keyset page observes state when queried, so concurrent changes may appear in later sections/pages but not earlier ones. This weak temporal consistency is accepted for bounded transaction duration and availability.                                                                                                                               |
| Like overlapping video rejection   | Serializable ordering is authoritative, not wall-clock commit order. A like whose transaction read the eligible video before a concurrent rejection may commit after the rejection's commit is observed; serialization may still order the like first. Preventing that visible ordering surprise would require a video lock that serializes unrelated comment likes.                                |
| Shared mutation quota              | Root creation, replies, deletion, like, and unlike share 30 actions per user per ten minutes. This intentionally includes moderation deletions by moderators and administrators; operational moderation tooling may eventually require a consciously separate quota.                                                                                                                                |
| Public comment references          | A persisted `c_` plus 128-bit UUID encoded as hex is used for comment IDs and references. Internal comment UUIDs remain database-only; route operations still revalidate exact video and thread context, so possession of a public reference grants no authority.                                                                                                                                   |

The shared API IP limiter (1,200 requests per 15 minutes) runs after CORS and before `express.json`,
so requests consume their coarse admission quota before JSON bodies are read and parsed. It covers
all application routes, including route modules registered directly on the app; route-specific,
authenticated, and identifier-based limiters remain later in the middleware chain where they can
inspect parsed bodies or authenticated users. Its IP key follows Express `trust proxy` configuration,
which must match the actual private proxy topology. The API limiter intentionally passes requests
through if Redis errors; during a Redis outage, only the per-body size limit and upstream proxy
controls bound this parsing workload, rather than distributed request admission.

Playlist reads are capped at 512 KiB. URI lines are rewritten to API routes while all FFmpeg HLS
tags remain untouched. Every artifact object key is rebuilt from `buildVideoArtifactManifest` using
the persisted public generation token; rendition existence and generation ownership are checked in
PostgreSQL first. Segment names must match the generated `segment-NNNNN.ts` shape, the reconstructed
object is checked with HEAD, and the API then returns a temporary redirect to a fresh signed GET
instead of proxying bytes. Master and rendition playlists are `no-cache`; segment redirects are
`no-store` because their signed destination is short-lived even though generation object keys are
immutable.

Segment bytes come from the S3 origin after the redirect, so the bucket itself must allow
cross-origin browser reads from every deployed player origin. Configure bucket CORS with `GET` and
`HEAD`, allow the `Range` request header (or the provider's equivalent wildcard), and expose at
least `Accept-Ranges`, `Content-Length`, `Content-Range`, and `ETag`. Keep the bucket private:
authorization still comes from the signed URL. Express `CORS_ORIGINS` applies only to API
responses and cannot authorize the browser's subsequent request to the object-storage origin.

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

The [createAuthService()](../src/modules/auth/index.ts) factory enables testing without a real database, SMTP server, or runtime dependencies.

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

### Password byte policy and existing accounts

The hasher remains bcryptjs. Registration, password reset, login and sensitive-action
reauthentication share an explicit maximum of **72 UTF-8 bytes**, measured with
`Buffer.byteLength(password, 'utf8')`, and forbid **NUL (U+0000)** anywhere in the decoded
password string. The HTTP schemas enforce both predicates before invoking the credential
service. The four service entries enforce the same rules before their own account lookup,
hashing, comparison or mutation. Inputs over the limit or containing NUL are rejected;
NUL is never removed and passwords are never truncated. Password strings are used verbatim, without trimming,
Unicode normalization or prehashing. Creation retains the existing minimum length of eight
JavaScript string code units and uppercase, digit and special-character requirements;
login and reauthentication require a nonempty, NUL-free password within the byte limit.

The installed bcrypt adds a NUL terminator and cyclically consumes the encoded key during
key expansion. Embedded NUL can therefore introduce a shorter periodic alias: the 11-byte
`A1!\u0000A1!\u0000A1!` hashes equivalently to `A1!`, bypassing the creation minimum even
on a database initially containing no accounts. This is not truncation at the first NUL:
`A1!\u0000different` does not verify as `A1!`. Rejecting NUL closes that input class without
changing bcrypt or imposing new creation requirements on authentication. The restriction
applies after JSON decoding; literal backslash-u0000 text is accepted when no actual NUL
is present. Other whitespace and Unicode sequences are preserved.

HTTP length and NUL failures use the normal 400 validation response, independently of whether the
identifier exists. A service called directly throws `PasswordTooLongError` or
`PasswordContainsNulError`, mapped to 400
`BadRequest` by the auth controllers. Wrong credentials within the limit retain the generic
401 response. A rejected reset does not consume its code or change a hash or session;
middleware authentication on sensitive routes may still update a session's `lastUsedAt`.

| Guarantee                                                 | Untrusted input / source of truth                   | Transformation                                                       | Enforcement                                                                    | Bypass and observable regression                                                                                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The byte cap prevents bcrypt truncation                   | JSON password / UTF-8 byte length                   | JSON decoding, UTF-8 encoding, bcrypt's 72-byte truncation           | Shared HTTP predicate and registration/reset service guard                     | 71/72/73 bytes, accents, emoji, characters crossing byte 72 and complexity only in the ignored suffix; oversize inputs rejected before persistence, exact 72-byte secrets verified with real bcrypt                        |
| All credential paths use the same maximum                 | Password or currentPassword / shared byte predicate | HTTP parsing or direct service call                                  | Login and common sensitive-action reauthentication guard, plus creation guards | Direct calls to all seven operations reject before account lookup or password-dependent work; HTTP tests assert exact serialized 400 bodies                                                                                |
| Rejected resets preserve credentials and recovery         | New password and reset code / PostgreSQL rows       | Validation before code lookup or transaction                         | Reset entry guard                                                              | Valid code plus oversized password leaves hash, code and session eligibility unchanged; the same code subsequently completes a valid reset                                                                                 |
| The length error does not reveal account existence        | Identifier and oversized password / request alone   | Validation before identifier lookup                                  | Public schemas before service invocation                                       | Known and unknown identifiers produce identical status and body; in-range wrong passwords retain identical generic 401 responses                                                                                           |
| New passwords cannot introduce NUL-based periodic aliases | Decoded JSON password / NUL-free predicate          | JSON escape decoding, bcrypt NUL terminator and cyclic key expansion | Common schema and all credential service guards                                | Leading, trailing, interior, byte-72 and periodic NUL are rejected without stripping; real bcrypt positive and negative controls; real PostgreSQL registration/reset rejection leaves persistent rows and emails unchanged |

The NUL regression suite observes the actual bcrypt equivalence and a nonperiodic control,
then checks HTTP and direct-service rejection for leading, trailing, interior, periodic and
byte-72 NUL. Real PostgreSQL tests verify that rejected registration leaves no account, token,
session or email, and that rejected reset preserves the complete user, reset token, sessions
and delivered emails. The same reset code remains usable for a compliant replacement.
After compliant registration and reset, the short `A1!` alias receives the same generic 401
on login, export, account deletion and both bulk-logout routes. Legacy fixtures alone bypass
the new policy to verify recovery from a previously stored periodic-NUL hash.

**Deployment limitation:** hashes created before this policy contain neither the original
input length nor the ignored suffix. They cannot identify affected accounts, reconstruct
the full password, or distinguish the original input from another input with the same first
72 bytes. The new maximum rejects the original long input; users must recover through
`/auth/forgot-password` and `/auth/reset-password` with a new compliant password. There is
no legacy fallback that accepts oversized inputs. A valid string containing exactly the
old first 72 bytes can still authenticate until that password is reset; if the cutoff splits
a UTF-8 character, a standalone valid prefix may not exist. Login does not impose creation
complexity rules on that old prefix.

Similarly, an existing hash does not identify whether its original input contained NUL.
The NUL-containing input is now rejected on login and reauthentication, so an affected user
must use email recovery with a new compliant password. A NUL-free shorter periodic alias
may still authenticate until recovery; banning NUL cannot repair an already stored hash.
The legacy-NUL integration test documents that alias succeeding before recovery, failing
afterward, and the existing sessions being revoked by the successful reset.

Before deploying to existing real accounts, inventory whether any passwords predate this
policy. Eliminating the historical truncation and NUL-alias risks for all such accounts requires renewal
of **all** pre-policy passwords, because affected hashes cannot be selected reliably, and
revocation of their existing sessions. An authorized operational rollout must arrange that
renewal and session revocation; this code change performs no bulk credential invalidation
and adds no migration or automatic forced-reset state. Without that rollout, historical
hashes remain a documented residual risk. A successful individual reset uses the existing
transaction to replace the hash and revoke active sessions. The HTTP/PostgreSQL regression
test explicitly records the old-prefix behavior before recovery and its rejection afterward.

### Login transaction invariants

Password comparison (bcrypt, including the missing-user comparison) stays outside the transaction.
Session creation receives the exact hash that was authenticated, acquires the shared user
authorization row lock, and rereads the user before inserting a session or updating `lastLogin`.
An absent user or changed hash produces the same invalid-credentials error as a wrong password.
Current ban and email-verification state are checked again; the returned profile and role come from
this locked reread. No password hash is included in the service result or HTTP DTO.

| Invariant                                                    | Untrusted input / source of truth                         | Transformations                                               | Enforcement                                                                 | Counterexample                                             | Observable proof                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Authenticated password is still current                      | Client password / current `users.password_hash`           | Pre-read, bcrypt, lock wait, transactional reread             | Hash equality before session insertion                                      | Reset commits during login                                 | Real PostgreSQL lock wait, then generic 401, unchanged session count and `lastLogin` |
| Reset revokes a login that acquires the lock first           | Concurrent login/reset / committed session rows           | Login insert and commit, reset password update and revocation | User lock held through session creation and reset update through revocation | Reset runs before the login insertion commits              | Reset visibly waits on the user row lock; both sessions are subsequently inactive    |
| Account remains eligible                                     | Pre-read account / locked current user                    | Ban, verification change, or account deletion before creation | Missing-user, ban and verification checks before writes                     | Valid bcrypt result with an account that changed meanwhile | HTTP errors and no inserted session after the concurrent change                      |
| Public response uses current profile without internal fields | Pre-read profile / locked current user and HTTP whitelist | Transactional projection, HTTP serialization                  | Explicit user projection and `toAuthSessionResponse`                        | Role changes during bcrypt; hash accidentally returned     | Exact serialized HTTP body                                                           |

Login takes only the user lock before touching sessions. Reset and administrative ban already
update the user before revoking sessions, so they serialize on the same row. Account deletion
locks its resource rows before deleting the user; login does not acquire those resource locks.
If login wins, reset/ban can revoke its session after commit, and deletion can cascade it away.
Consequently, a successful login response can contain a session already revoked by a concurrent
operation; it never guarantees that the session remains usable after the transaction commits.

### Sensitive-action transaction invariants

Sensitive-action reauthentication returns the exact hash authenticated by bcrypt outside the
transaction. Login, account deletion, both bulk session revocations, and each export read share
the locked hash/ban check. Account deletion keeps its job/video/comment locks before acquiring
the user lock and checking credentials, before any aggregate repair or deletion. Password reset
locks the user before consuming its reset token, then rereads its credentials; this avoids a
user/token lock cycle with the account-deletion cascade and preserves reset-error precedence.
Every serializable deletion retry repeats the final check
against the originally authenticated hash, without repeating bcrypt.

| Invariant                                                  | Untrusted input / source of truth                           | Transformations                                              | Enforcement                                           | Counterexample                                                         | Observable proof                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A reset invalidates pending sensitive actions              | Client password and middleware snapshot / current user hash | Bcrypt, pause, reset commit, final transaction               | Shared locked hash/ban check before reads or writes   | Reset finishes after bcrypt but before deletion, export or bulk logout | Four HTTP routes reject with the same 401, account retained and new session active |
| An authorized operation completes before reset             | Concurrent operation/reset / user row lock                  | Resource locks, user lock, operation effects, commit, reset  | Common user lock held until final transaction commits | Reset tries to update before protected effects                         | PostgreSQL lock wait; reset reads committed effects or finds deleted user          |
| An export never starts another page with stale credentials | Export iterator / current user hash and ban state           | Initial metadata read, bounded page reads, HTTP backpressure | Short transaction around each check and page query    | Reset/ban between pages or collections                                 | Next page is rejected; started HTTP stream closes without valid final JSON         |
| No token/user lock cycle with deletion                     | Concurrent deletion/reset / PostgreSQL locks                | Reset token consumption and account cascade                  | Reset acquires user lock before reset-token mutation  | Deletion owns user while reset owns token                              | Deletion-first/reset-second completes without a deadlock                           |

Exports remain bounded, paginated reads rather than one consistent snapshot. No transaction or
user lock is held while sending bytes or waiting for HTTP backpressure. A page authorized and
read before reset/ban may still be emitted after it commits; already delivered bytes cannot be
recalled. The next page (including a different collection) repeats authorization and rejects the
stale hash. Before HTTP headers this is the ordinary invalid-credentials response; after headers
the existing streaming error path closes the response without its final JSON delimiter. Clients
must discard incomplete exports. Password checks bind the operation to current credentials;
this change does not turn every session revocation into cancellation of already running requests.

The login concurrency regressions live in
`tests/integration/auth.login-concurrency.integration.ts`. On 2026-10-13 both transaction orders
were observed through `pg_stat_activity.wait_event_type = 'Lock'`. Removing only hash equality
made the reset-first test return HTTP 200 instead of 401. Removing `FOR UPDATE` made the
login-first test fail because reset completed before the required lock wait. Both protections
were restored after these mutation checks. The other cases exercise real administrative ban,
account deletion, email-verification loss, and an exact HTTP profile/session projection after a
role change during password comparison.

Sensitive-action regressions live in `tests/integration/auth.sensitive-concurrency.integration.ts`.
The 2026-10-13 PostgreSQL/HTTP verification includes pending bcrypt requests, real lock waits in
both orders, account ban/deletion, export metadata and page boundaries, and interrupted chunked
HTTP delivery. The reset-first deletion case observes two serializable transaction attempts and
one bcrypt comparison: the first snapshot conflicts, the retry rejects the original stale hash.
Concurrent duplicate account deletions now produce one success and one invalid-credentials
failure once the user is gone. The cleanup regression observes one real waiter on the target and
one on the user, and verifies that the original cleanup target is retained without duplication.
Mutation checks were executed and all source files restored afterwards:

- Removing final hash equality made all four pending sensitive HTTP actions return 200 instead
  of 401.
- Skipping only the sensitive-operation user lock made the three inverse write scenarios and
  both inverse export reads fail because reset completed before the required PostgreSQL wait.
- Keeping initial export authorization while skipping subsequent page checks made all eight
  collection checks, the next-page check, and the HTTP interruption check fail.
- Moving reset's user lock after token consumption produced PostgreSQL `40P01`, `deadlock detected`,
  in the deletion-first regression. With the correct order, deletion succeeds and reset reports
  its ordinary invalid-reset-token error after the user disappears.

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
Service ->> DB: lock user, reread hash and eligibility, create hashed session and update lastLogin
Service -->> Controller: user + sessionKey
Controller -->> Client: JSON response
```

## Feature Structure

New domains are grouped vertically under `src/modules/<domain>/`. Each module owns its domain
types and service, along with its HTTP layer under `http/` (handlers, schemas, responses, routes,
and OpenAPI definitions as applicable). The module boundary exposes what the rest of the
application needs through its entry point.

Components that are genuinely shared across domains remain in cross-cutting areas such as `lib`,
`middleware`, and `shared`.

`src/modules/admin/` owns account administration and video moderation, including their services,
types, shared transactional authorization, role hierarchy, errors, and two HTTP modules. Its
`index.ts` exposes `adminAccountsHttpModule` on `/admin` and `videoModerationHttpModule` on
`/moderation`; the explicit registry lists both directly. Each router accepts only its own
`AdminAccountsPort` or `VideoModerationPort`, while `createAdminService` composes both for runtime
wiring. Admin response serializers build every public field explicitly, matching their response
schemas even if a service result contains additional runtime properties.

## Auth domain

Auth is the last application domain extracted under `src/modules`. Its public entry point,
`src/modules/auth/index.ts`, composes the existing credential, session, account, media, and
maintenance capabilities through `createAuthService`. It exports the complete `AuthService`, the
HTTP-facing `AuthHttpPort`, and the narrower `AuthSessionValidationPort` and `AuthMaintenancePort`
contracts. The runtime composition root remains `src/auth.instance.ts`; shared middleware receives
the session-validation contract, the `/auth` HTTP module receives the HTTP contract, and the
maintenance job receives only the maintenance contract.

Business code is grouped under `credentials/`, `sessions/`, `account/`, `media/`, and
`maintenance/`. Auth handlers, schemas, OpenAPI descriptions, response serializers, error mapping,
and its router live under `http/`. `authHttpModule` is mounted directly at `/auth` by
`src/routes/registry.ts`. The existing route and middleware order is part of the HTTP contract:
session authentication runs before multipart parsing, and the account-operation guard encloses the
entire streamed export response.

Shared authentication middleware stays in `src/middleware/`. Other domains import the public Auth
authorization primitives from their owning leaf modules: `roles.ts`, `errors.ts`, and
`authorization.ts`. This keeps their runtime imports independent of Auth's HTTP composition.
Generic Prisma error predicates live in `src/lib/prismaErrors.ts` and are shared by Auth, Comments,
and Videos. Shared media processing, object storage, and external-resource reconciliation remain
outside Auth; Auth media services adapt to those engines.

Auth HTTP responses and streamed data exports use explicit field projections in
`src/modules/auth/http/responses.ts`. A service result cannot add fields to the public DTO without
an intentional serializer change. The generated `openapi.json` remains the snapshot of registered
route descriptions; changes to paths, operation IDs, schemas, or documented statuses are API
changes.

Auth responses do not expose user or session database UUIDs. Session `id` values in login, session
listing, cursors, revocation requests, and personal exports are stable public references stored as
`sessions.public_id`; revocation still scopes the update to the authenticated owner. After this
change, clients must refresh their session list before using a previously stored session ID. The
personal export identifies videos by `publicId`, comments by their persisted public references, and
omits user and verification/reset token IDs.

Profile media upload processes the file, reserves an external-resource target, stores the object,
then confirms the target and updates the user media record in a serializable transaction. Failed
object writes and user-deletion races schedule the reserved target for absence and attempt immediate
reconciliation; cleanup failures are logged while the primary operation error is preserved. The
maintenance job retries due targets through the shared reconciliation engine.

`userAccountOperationGuard` coordinates export and deletion per user until the response finishes
or closes, including while an export stream is back-pressured. It uses an in-process guard and, when
configured, a renewable Redis lease. If Redis is unavailable outside production, the in-process
guard coordinates only this application process; cross-process exclusion is not provided in that
fallback mode.

## Videos domain

`src/modules/videos/` owns the 13 remaining video HTTP operations and the service capabilities for
management, public catalog and search, ratings, playback, and deferred lifecycle cleanup. The
module's HTTP router and OpenAPI definitions are registered through `videosHttpModule` in the
explicit route registry. `createVideosService` composes the five capability factories directly.
`index.ts` exposes the service contracts and the specific HTTP schemas and serializer shared with
Comments and Profiles; storage, HLS, readability, license, public-ID, and search helpers stay under
`shared/` and are imported from their owning files.

Creation and owner-list responses are serialized by field whitelist and omit internal video and
owner UUIDs. The owner-list cursor uses `(createdAt, publicId)`, matching public catalog pagination;
its request parameter is `cursorPublicId`.
VideoUploads keeps its module and route paths; the route's `videoId` segment accepts the public ID
and is resolved to an owner-scoped database ID inside VideoUploads. Upload-session responses return
the public ID and do not repeat the internal video UUID.

Uploads, comments, and transcoding remain in their own modules. Shared video rules and helpers live
once under `src/modules/videos/shared/`: object keys and artifact manifests, HLS parsing and
playlist rewriting, readability scopes, licenses, public IDs, search normalization, and
`VideoNotFoundError`. Uploads, transcoding, comments, and administration import those shared exports
directly. Profiles receives only `PublicProfileVideosPort`, while maintenance receives only
`VideoLifecycleMaintenancePort`.
