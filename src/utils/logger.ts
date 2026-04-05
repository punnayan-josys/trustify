/**
 * logger.ts
 *
 * Structured JSON logger built on Winston.
 * Each log line is a JSON object — easy to ingest into
 * Datadog / CloudWatch / Loki without format changes.
 *
 * Usage:
 *   import { logger } from '../utils/logger';
 *   logger.info('Cache hit', { headlineHash: 'abc123' });
 */

import winston from "winston";

const logLevel = process.env.LOG_LEVEL ?? "info";

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const prettyFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    const metaString =
      Object.keys(metadata).length > 0
        ? ` ${JSON.stringify(metadata)}`
        : "";
    return `${timestamp} [${level}] ${message}${metaString}`;
  })
);

export const logger = winston.createLogger({
  level: logLevel,
  format:
    process.env.NODE_ENV === "production" ? jsonFormat : prettyFormat,
  transports: [new winston.transports.Console()],
});
