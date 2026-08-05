import { rm } from 'node:fs/promises';

const distDirectory = new URL('../dist/', import.meta.url);

await rm(distDirectory, { recursive: true, force: true });

const compiler = Bun.spawn(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exitCode = await compiler.exited;
