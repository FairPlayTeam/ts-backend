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

The recommended development setup runs the API with Bun on the host and runs PostgreSQL and Redis
with Docker Compose:

```
# install dependencies
bun install

# create the local env file
cp .env.example .env

# start only the local dependencies
docker compose up -d postgres redis

# migrate the Prisma schema to PostgreSQL
bunx prisma migrate dev

# run the backend with watch mode and pretty logs
bun run dev
```

The backend will listen on http://localhost:3000. In this mode, `.env` should use host-reachable
URLs such as `postgresql://user:password@localhost:5432/fairplay?schema=public` and
`redis://localhost:6379`.

### Full Docker Compose stack

The complete stack can also run with Docker Compose:

```
docker compose up --build
```

This starts four services on the `fairplay-backend-network` Docker network:

- `postgres`, backed by the `postgres_data` volume
- `redis`, backed by the `redis_data` volume and append-only persistence
- `migrate`, a one-shot Prisma migration service
- `backend`, the API runtime image

Inside the Compose network, the backend connects to PostgreSQL through `postgres:5432` and Redis
through `redis:6379`. The database and Redis ports are bound to `127.0.0.1` by default so local
tools can still access them without exposing them on the machine network.

Useful commands:

```
docker compose ps
docker compose logs -f backend
docker compose stop backend
docker compose stop postgres redis
docker compose down
```

`docker compose down -v` also deletes the PostgreSQL and Redis volumes. Use it only when local data
should be removed.

### Production deployment

Production should run container images built from the Dockerfile targets:

```
docker build --target runtime -t fairplay-backend:<tag> .
docker build --target migrator -t fairplay-backend-migrator:<tag> .
```

Deploy PostgreSQL and Redis as shared infrastructure first, then run the migrator image once for
the release:

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
- configure SMTP with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and
  `FRONTEND_URL`
- configure `BASE_URL`, `CORS_ORIGINS`, and `TRUST_PROXY` for the public reverse proxy or load
  balancer
- set a strong, unique `RATE_LIMIT_KEY_SECRET` with at least 32 characters
- run migrations as a singleton step, not in every backend replica

Docker env files should not wrap values in quotes. Use `BASE_URL=https://api.example.com`, not
`BASE_URL="https://api.example.com"`.

### Managed PostgreSQL and Redis

Managed providers can be used for the shared production database and Redis store. For example, Neon
can be used as PostgreSQL and Upstash can be used as Redis.

Operational requirements:

- every backend instance must use the same `DATABASE_URL`
- every backend instance must use the same `REDIS_URL`
- every backend instance must use the same `RATE_LIMIT_KEY_SECRET`
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
point every instance at the same shared PostgreSQL and Redis services, run the migrator once per
release, and use `/health/ready` as the origin health check.

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
- `CORS_ORIGINS` comma-separated list of allowed request origins.
- `REDIS_URL` Redis URL used for distributed rate limiting, cooldowns, and maintenance locks.
  Managed Redis providers may require `rediss://` for TLS.
- `RATE_LIMIT_KEY_SECRET` secret used to anonymize identifier-based rate limit keys. It must be at
  least 32 characters and must not be a placeholder in production.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` configure email delivery.
- `FRONTEND_URL` frontend URL used to generate verification and password reset links.

### Notes

Redis, SMTP, and `RATE_LIMIT_KEY_SECRET` are mandatory in production. Redis is optional in
development; if unavailable, the backend falls back to in-memory rate limiting. `TRUST_PROXY`
should be configured explicitly when the backend runs behind a reverse proxy or load balancer.

### Commit template

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

This project follows the conventional commits convention, see https://www.conventionalcommits.org/en/v1.0.0/ for more details.
