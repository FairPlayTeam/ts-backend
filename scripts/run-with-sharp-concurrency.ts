import { getSharpConcurrency, SHARP_CONCURRENCY_ENV } from '../src/lib/sharpConcurrency.js';

const [command, ...args] = Bun.argv.slice(2);

if (!command) {
  console.error('Usage: bun scripts/run-with-sharp-concurrency.ts <command> [...args]');
  process.exitCode = 1;
} else {
  const sharpConcurrency = String(getSharpConcurrency());

  console.log(`[sharp] ${SHARP_CONCURRENCY_ENV}=${sharpConcurrency}`);

  const processEnv = {
    ...process.env,
    [SHARP_CONCURRENCY_ENV]: sharpConcurrency,
  };

  const child = Bun.spawn([command, ...args], {
    env: processEnv,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  process.exitCode = await child.exited;
}
