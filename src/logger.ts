import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Minimal structured logger (replaces winston). The MCP server's stdout is the JSON-RPC
// channel and must stay clean, so console diagnostics go to STDERR; the durable log is one
// JSON (or "simple") line per record appended to a file. Child loggers share the parent's
// file sink and merge their default metadata. Logging never throws.

export interface LoggerConfig {
  level: string;
  format?: 'json' | 'simple';
  enableConsole?: boolean;
  enableFile?: boolean;
  filePath?: string;
}

type Meta = Record<string, unknown>;
const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export class Logger {
  private readonly threshold: number;
  private readonly sink?: (line: string) => void;

  constructor(
    private readonly config: LoggerConfig,
    private readonly defaultMeta: Meta = {},
    sink?: (line: string) => void
  ) {
    this.threshold = LEVELS[config.level] ?? LEVELS.info;
    if (sink) {
      this.sink = sink; // child: reuse the parent's file stream
    } else if (config.enableFile && config.filePath) {
      try {
        mkdirSync(dirname(config.filePath), { recursive: true });
        const stream = createWriteStream(config.filePath, { flags: 'a' });
        stream.on('error', () => {}); // never let a file error crash the server
        this.sink = line => stream.write(`${line}\n`);
      } catch {
        /* file logging is best-effort */
      }
    }
  }

  info(message: string, meta?: unknown): void {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta);
  }
  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta);
  }
  error(message: string, error?: unknown): void {
    const meta: Meta | undefined =
      error instanceof Error
        ? { error: error.message, stack: error.stack }
        : error !== undefined
          ? { error }
          : undefined;
    this.write('error', message, meta);
  }

  /** A logger that tags every record with `meta` (merged over this logger's), same file sink. */
  child(meta: Meta): Logger {
    return new Logger(this.config, { ...this.defaultMeta, ...meta }, this.sink);
  }

  private write(level: string, message: string, meta?: unknown): void {
    if ((LEVELS[level] ?? 99) > this.threshold) return;
    const extra: Meta =
      meta && typeof meta === 'object' ? (meta as Meta) : meta !== undefined ? { meta } : {};
    const fields = { ...this.defaultMeta, ...extra };
    const timestamp = new Date().toISOString();
    const hasFields = Object.keys(fields).length > 0;
    const line =
      this.config.format === 'json'
        ? JSON.stringify({ timestamp, level, message, ...fields })
        : `${timestamp} [${level}]: ${message}${hasFields ? ` ${JSON.stringify(fields)}` : ''}`;
    if (this.config.enableConsole) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* ignore */
      }
    }
    this.sink?.(line);
  }
}
