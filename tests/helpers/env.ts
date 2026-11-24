import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_TIMEZONE } from '../../src/config/constants.js';

export function validEnvSource(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: String(DEFAULT_PORT),
    HOST: DEFAULT_HOST,
    LOG_LEVEL: 'info',
    APP_TIMEZONE: DEFAULT_TIMEZONE,
    ...overrides,
  };
}
