import { parseEnvironment } from './env.schema.js';

const config = parseEnvironment(process.env);

export type Config = typeof config;
export default config;
