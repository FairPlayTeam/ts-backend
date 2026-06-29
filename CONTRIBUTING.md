## How to contribute

### Clone the repository

```
git clone https://github.com/FairPlayTeam/ts-backend.git
cd ts-backend

# checkout the active development branch
git checkout refactor/v2

# create a feature branch
git checkout -b feat/my-feature
```

### Setup the environment

Node.js, Bun (1.3.10), and Docker are required.

The recommended development setup runs the API with Bun on the host and runs the local dependency
services with Docker Compose: PostgreSQL, Redis, and MinIO for S3-compatible object storage.

```
# install dependencies
bun install

# create the local env file
cp .env.example .env

# start only the local dependencies
docker compose up -d postgres redis minio

# migrate the Prisma schema to PostgreSQL
bunx prisma migrate dev

# run the backend with watch mode and pretty logs
bun run dev
```

The backend will listen on http://localhost:3000. In this mode, `.env` should use host-reachable
URLs such as `postgresql://user:password@localhost:5432/fairplay?schema=public` and
`redis://localhost:6379`. MinIO is reachable at `http://localhost:9000`, with the console at
`http://localhost:9001`.

### Full Docker Compose stack

The complete stack can also run with Docker Compose:

```
docker compose up --build
```

This starts five services on the `fairplay-backend-network` Docker network:

- `postgres`, backed by the `postgres_data` volume
- `redis`, backed by the `redis_data` volume and append-only persistence
- `minio`, backed by the `minio_data` volume
- `migrate`, a one-shot Prisma migration service
- `backend`, the API runtime image

Inside the Compose network, the backend connects to PostgreSQL through `postgres:5432`, Redis
through `redis:6379`, and, by default, MinIO through `minio:9000`. The database, Redis, and MinIO
ports are bound to `127.0.0.1` by default so local tools can still access them without exposing
them on the machine network.

Useful commands:

```
docker compose ps
docker compose logs -f backend
docker compose stop backend
docker compose stop postgres redis minio
docker compose down
```

`docker compose down -v` also deletes the PostgreSQL, Redis, and MinIO volumes. Use it only when
local data should be removed.

Docker Compose is only a local development and verification setup. Production does not use this
Compose file; production containers receive `DATABASE_URL`, `REDIS_URL`, and `OBJECT_STORAGE_*`
directly from the deployment environment or secret manager.

The `COMPOSE_OBJECT_STORAGE_*` variables are only interpolation inputs for the local Compose file.
They keep host values such as `OBJECT_STORAGE_ENDPOINT=http://localhost:9000` separate from
container-network values such as `http://minio:9000`. The backend process itself always reads the
standard runtime variables named `OBJECT_STORAGE_*`.

### Production deployment

Production should run container images built from the Dockerfile targets:

```
docker build --target runtime -t fairplay-backend:<tag> .
docker build --target migrator -t fairplay-backend-migrator:<tag> .
```

Deploy PostgreSQL, Redis, and S3-compatible object storage as shared infrastructure first, then run
the migrator image once for the release:

```
docker run --rm --env-file .env.production fairplay-backend-migrator:<tag>
```

After migrations have completed, run one or more replicas of the runtime image:

```
docker run --rm --env-file .env.production -p 3000:3000 fairplay-backend:<tag>
```

In production:

- set `NODE_ENV=production`
- set `DATABASE_URL` to the shared PostgreSQL instance
- set `REDIS_URL` to the shared Redis instance
- set `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY`, and `OBJECT_STORAGE_SECRET_KEY` to
  the shared S3-compatible object storage instance
- configure SMTP with `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_MODE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`
- configure `BASE_URL`, `CORS_ORIGINS`, and `TRUST_PROXY` for the public reverse proxy or load
  balancer
- set a strong, unique `RATE_LIMIT_KEY_SECRET` with at least 32 characters
- set a separate strong, unique `AUTH_CODE_PEPPER` with at least 32 characters
- run migrations as a singleton step, not in every backend replica

Docker env files should not wrap values in quotes. Use `BASE_URL=https://api.example.com`, not
`BASE_URL="https://api.example.com"`.

### Managed PostgreSQL, Redis, and Object Storage

Managed providers can be used for the shared production database, Redis store, and object storage.
For example, Neon can be used as PostgreSQL, Upstash can be used as Redis, and any S3-compatible
provider can be used for profile media.

Operational requirements:

- every backend instance must use the same `DATABASE_URL`
- every backend instance must use the same `REDIS_URL`
- every backend instance must use the same object storage bucket and credentials
- every backend instance must use the same `RATE_LIMIT_KEY_SECRET`
- every backend instance must use the same `AUTH_CODE_PEPPER`
- credentials must stay in `.env.production`, deployment secrets, or a secret manager
- credentials must not be committed to Git

For Neon PostgreSQL:

- use the direct, non-pooled connection URL for Prisma migrations when Neon provides separate
  direct and pooled URLs
- prefer `sslmode=verify-full` in `DATABASE_URL`
- if the provider URL contains `sslmode=require`, it can work today, but `pg` currently warns that
  this mode will change semantics in a future major version

For Upstash Redis:

- use the Redis-compatible URL, not the REST URL
- use `rediss://...` when TLS is required by the provider
- keep Redis shared across all backend instances so rate limits, email cooldowns, and maintenance
  locks remain distributed

For Infomaniak Object Storage:

- use the S3 endpoint for the selected region, for example `https://s3.pub1.infomaniak.cloud`
- use `us-east-1` as the compatibility region unless the provider documentation says otherwise
- set `OBJECT_STORAGE_PUBLIC_URL` to the same origin when signed URLs should be consumed directly
  by clients
- keep buckets private; the backend uses signed URLs and does not require S3 bucket policies

### Cloudflare Tunnel deployment

When the backend is exposed through Cloudflare Tunnel, the backend should trust only the proxy that
connects directly to it.

Recommended single-host layout:

```text
Cloudflare -> cloudflared -> http://127.0.0.1:3000
```

Use:

```env
TRUST_PROXY=loopback
```

This allows Express to trust forwarded headers only from loopback traffic, which matches a local
`cloudflared` process forwarding to the backend on `127.0.0.1`.

If `cloudflared` runs in a separate container or private network and connects directly to the
backend container, use a one-hop proxy setting:

```env
TRUST_PROXY=1
```

In that layout, the backend port must not be reachable directly from the public Internet. Direct
public access would allow clients to spoof forwarded headers.

For multiple backend servers behind Cloudflare Load Balancer, run one backend runtime per server,
point every instance at the same shared PostgreSQL, Redis, and object storage services, run the
migrator once per release, and use `/health/ready` as the origin health check.

### Documentation

The full Swagger UI documentation will be available at /docs.

### Environment variables

- `NODE_ENV` runtime mode. Use `development` locally and `production` in production.
- `PORT` port on which the backend listens, for example `3000`.
- `LOG_LEVEL` Pino log level, for example `debug` locally or `info` in production.
- `DATABASE_URL` PostgreSQL URL, for example
  `postgresql://myuser:mypass@localhost:5432/mydb?schema=public`.
  Managed PostgreSQL URLs should include TLS settings when required by the provider.
- `BASE_URL` public URL of the backend, for example `http://localhost:3000`.
- `BCRYPT_ROUNDS` bcrypt cost factor, for example `12`.
- `JSON_BODY_LIMIT_BYTES` maximum accepted JSON body size in bytes.
- `SESSION_CLEANUP_INTERVAL_MINUTES` how often expired auth data is cleaned up.
- `SESSION_CLEANUP_INACTIVE_RETENTION_DAYS` how long inactive sessions are retained before deletion.
- `TRUST_PROXY` Express proxy trust setting. Use `false`, `loopback`, a hop count such as `1`, or
  an explicit proxy list. Do not use `true`. For Cloudflare Tunnel forwarding to
  `127.0.0.1:3000`, use `loopback`.
- `CORS_ORIGINS` comma-separated list of allowed request origins. Use `*` by itself to allow any
  browser origin for public Bearer-token API deployments.
- `REDIS_URL` Redis URL used for distributed rate limiting, cooldowns, and maintenance locks.
  Managed Redis providers may require `rediss://` for TLS.
- `RATE_LIMIT_KEY_SECRET` secret used to anonymize identifier-based rate limit keys. It must be at
  least 32 characters and must not be a placeholder in production.
- `AUTH_CODE_PEPPER` secret used as the HMAC key for email verification and password reset codes.
  It must be at least 32 characters and must not be a placeholder in production.
- `OBJECT_STORAGE_ENDPOINT` internal HTTP(S) origin for S3-compatible object storage, for example
  `http://localhost:9000` locally, `http://minio:9000` in the local Compose network, or a managed
  S3-compatible origin such as `https://s3.pub1.infomaniak.cloud`.
- `OBJECT_STORAGE_PUBLIC_URL` optional public HTTP(S) origin used when generating signed media URLs.
  If omitted, `OBJECT_STORAGE_ENDPOINT` is used.
- `OBJECT_STORAGE_REGION` S3 region. Defaults to `us-east-1`.
- `OBJECT_STORAGE_BUCKET` bucket for profile media. Defaults to `fairplay-user-media`.
- `OBJECT_STORAGE_ACCESS_KEY` and `OBJECT_STORAGE_SECRET_KEY` object storage credentials.
- `OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS` lifetime of signed media URLs. Defaults to `900`.
- `PROFILE_MEDIA_MAX_UPLOAD_BYTES` maximum accepted raw profile media upload size in bytes,
  currently for avatar and banner uploads. Defaults to `3145728`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_MODE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` configure
  email delivery. Use `SMTP_TLS_MODE=implicit` for implicit TLS, `starttls` for mandatory STARTTLS,
  or `none` only for trusted local SMTP servers without TLS. `none` is rejected in production.
  Email verification and password reset use six-digit codes and do not depend on a frontend URL.

### Notes

Redis, object storage, SMTP, `RATE_LIMIT_KEY_SECRET`, and `AUTH_CODE_PEPPER` are mandatory in
production. Redis is optional in development; if unavailable, the backend falls back to in-memory
rate limiting. `TRUST_PROXY` should be configured explicitly when the backend runs behind a reverse
proxy or load balancer.

### Commit template

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

This project follows the conventional commits convention, see https://www.conventionalcommits.org/en/v1.0.0/ for more details.
