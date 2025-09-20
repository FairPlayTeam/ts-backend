# fairplay ts api

ik the devs are really wanting rust but i was bored and made this api

this is like 90% done it uses session-based auth minio postgres express.js ffmpeg typescript and prisma with bun

its actually pretty fast docs are on /docs but also here

just use this api ffs 🥺

to set this up download bun from https://bun.sh

run `bun i` to install make .env from example then `bunx prisma generate` to gen the prisma `bunx prisma db push` to push schema to db then `bun run dev` to dev for prod `bun run build` then `bun run start`
