export const APP_NAME = 'kou-news-engine';
export const APP_VERSION = '0.0.0';
export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_TIMEZONE = 'Asia/Taipei';
export const DEFAULT_DATABASE_PATH = './data/kou-news.db';

/**
 * How long graceful shutdown may spend draining before it gives up.
 *
 * Bounded so a stuck connection cannot hold the process open indefinitely: the
 * container's own stop grace period is expected to be larger than this value.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;
export const MIN_SHUTDOWN_TIMEOUT_MS = 1000;
export const MAX_SHUTDOWN_TIMEOUT_MS = 60000;
