# Contributing

## Setup

1. Install Bun and the project dependencies:

```bash
bun install
```

2. Create your local environment file:

```bash
cp .env.example .env
```

3. Generate the Prisma client and apply migrations:

```bash
bun run prisma:generate
bun run prisma:migrate:deploy
```

## Checks Before Opening a PR

Run the full local verification pass:

```bash
bun run check
bun run build
```

## Project Notes

- Keep the codebase in TypeScript ESM style.
- Prefer small, focused changes over broad rewrites.
- Keep route docs in sync with the actual request validation and responses.
- Avoid committing secrets or real `.env` values.
