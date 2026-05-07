import config from './config/env.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';

const app = await createApp(config);

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server started');
});

server.on('error', (error) => {
  logger.fatal({ err: error }, 'Server failed to start');
  process.exitCode = 1;
});
