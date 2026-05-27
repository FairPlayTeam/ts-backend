## How to contribute

### Clone the repository

```
git clone https://github.com/FairPlayTeam/ts-backend.git
cd ts-backend

# checkout the active development branch
git checkout refactor/v2

# create your feature branch
git checkout -b feat/my-feature
```

### Setup the environment

Make sure you have Node.js, Bun (1.3.10), and Docker installed.
Then run:

```
# install dependencies
bun install

# create your env file (you can adjust the values if wanted)
cp .env.example .env

# create the necessary PostgreSQL and Redis containers
docker compose up -d

# migrate the Prisma schema to PostgreSQL
bunx prisma migrate dev

# run the backend
bun run dev
```

### Documentation

The full Swagger UI documentation will be available at /docs.

### Environment variables

- `PORT` Specifies the port on which the backend listens (e.g. 3000). The service will be available at http://localhost:3000
- `DATABASE_URL` the URL to your postgres instance, for example `postgresql://myuser:mypass@localhost:5432/mydb?schema=public`, which means your database will be accessible at the user `myuser`, using the `mypass` password, at `localhost:5432`, on the `mydb` database, and on the schema `public`
- `BASE_URL` the URL leading to your backend, for example `http://localhost:3000`
- `BCRYPT_ROUNDS` how many iterations bcrypt will perform to hash passwords, for example `12`
- `JSON_BODY_LIMIT_BYTES` a fixed limit for JSON body size
- `SESSION_CLEANUP_INTERVAL_MINUTES` how often expired and old inactive sessions are deleted, in minutes
- `SESSION_CLEANUP_INACTIVE_RETENTION_DAYS` how long inactive sessions are retained before deletion, in days
- `TRUST_PROXY` indicate if express can trust the proxy, if it's running behind a proxy, for example `false` or `loopback`
- `CORS_ORIGINS` allowed URLs for requests
- `REDIS_URL` Redis connection URL used for distributed rate limiting, for example `redis://localhost:6379`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` are required to send emails. You can customize these values depending on the SMTP provider you're using.
- `FRONTEND_URL` the URL of your frontend, for example `http://localhost:3001`. It's mainly used to generate verification links for email verification.

### Commit template

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

This project follows the conventional commits convention, see https://www.conventionalcommits.org/en/v1.0.0/ for more details.
