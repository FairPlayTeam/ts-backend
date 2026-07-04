import { getSharpConcurrency, SHARP_CONCURRENCY_ENV } from '../src/lib/sharpConcurrency.js';

type CheckStep = {
  label: string;
  command: readonly [string, ...string[]];
};

const sharpConcurrency = String(getSharpConcurrency());

const steps: CheckStep[] = [
  { label: 'typecheck', command: ['bun', 'run', 'typecheck'] },
  { label: 'lint', command: ['bun', 'run', 'lint'] },
  { label: 'format check', command: ['bun', 'run', 'format:check'] },
  { label: 'Prisma validate', command: ['bunx', 'prisma', 'validate'] },
  { label: 'unit tests', command: ['bun', 'run', 'test:unit'] },
  { label: 'integration tests', command: ['bun', 'run', 'test:integration'] },
  { label: 'dependency audit', command: ['bun', 'audit'] },
  { label: 'build', command: ['bun', 'run', 'build'] },
];

const env = {
  ...process.env,
  [SHARP_CONCURRENCY_ENV]: sharpConcurrency,
};

console.log(`[check] ${SHARP_CONCURRENCY_ENV}=${sharpConcurrency}`);

for (const step of steps) {
  console.log(`[check] ${step.label}`);

  const child = Bun.spawn([...step.command], {
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await child.exited;

  if (exitCode !== 0) {
    console.error(`[check] ${step.label} failed with exit code ${exitCode}`);
    process.exitCode = exitCode;
    break;
  }
}
