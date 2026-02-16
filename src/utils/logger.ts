export enum LogLevel {
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG'
}

export class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    const colors = {
      [LogLevel.INFO]: '\x1b[90m',      // gray
      [LogLevel.SUCCESS]: '\x1b[32m',   // green
      [LogLevel.WARNING]: '\x1b[33m',   // yellow
      [LogLevel.ERROR]: '\x1b[31m',     // red
      [LogLevel.DEBUG]: '\x1b[36m'      // cyan
    };
    const reset = '\x1b[0m';

    const color = colors[level];
    const coloredLevel = `${color}[${level}]${reset}`;

    return `${timestamp} ${coloredLevel} [${this.prefix}] ${message}`;
  }

  info(message: string): void {
    console.log(this.formatMessage(LogLevel.INFO, message));
  }

  success(message: string): void {
    console.log(this.formatMessage(LogLevel.SUCCESS, message));
  }

  warning(message: string): void {
    console.log(this.formatMessage(LogLevel.WARNING, message));
  }

  error(message: string): void {
    console.error(this.formatMessage(LogLevel.ERROR, message));
  }

  debug(message: string): void {
    console.log(this.formatMessage(LogLevel.DEBUG, message));
  }
}

export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}
