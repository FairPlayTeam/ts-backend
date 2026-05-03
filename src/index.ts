import config from './config/env.js';
import { createApp } from './app.js';

const app = await createApp(config);

const server = app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});

server.on('error', (error) => {
  console.error("An error occurred, server can't start.", error);
  process.exitCode = 1;
});
