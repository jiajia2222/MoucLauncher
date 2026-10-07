import fs from 'node:fs'
import path from 'node:path'

export type LogSeverity = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: number
  scope: string
  level: LogSeverity
  text: string
}

const MAX_MEMORY = 800

type Sink = (record: LogRecord) => void

/**
 * File + ring-buffer logger. `memory` is what the renderer reads through
 * `game:logs`-style handlers, so it must survive without a console.
 */
export class Logger {
  readonly scope: string
  private readonly file: string
  private readonly memory: LogRecord[] = []
  private sinks = new Set<Sink>()
  private stream: fs.WriteStream | undefined
  private fileDisabled = false

  constructor(scope: string, logDir: string) {
    this.scope = scope
    const day = new Date().toISOString().slice(0, 10)
    this.file = path.join(logDir, `launcher-${day}.log`)
    try {
      fs.mkdirSync(logDir, { recursive: true })
    } catch {
      // A read-only or missing data dir must not stop the launcher from booting.
      this.fileDisabled = true
    }
  }

  on(sink: Sink): () => void {
    this.sinks.add(sink)
    return () => this.sinks.delete(sink)
  }

  private write(level: LogSeverity, text: string, error?: unknown): void {
    const record: LogRecord = { ts: Date.now(), scope: this.scope, level, text }
    this.memory.push(record)
    if (this.memory.length > MAX_MEMORY) this.memory.splice(0, this.memory.length - MAX_MEMORY)
    const stream = this.fileStream()
    if (stream) {
      const when = new Date(record.ts).toISOString()
      try {
        stream.write(`${when} [${level.toUpperCase()}] ${this.scope}: ${text}\n`)
        if (error) stream.write(`${String(error)}\n`)
      } catch {
        this.disableFile()
      }
    }
    for (const sink of this.sinks) {
      try {
        sink(record)
      } catch {
        /* ignore sink failures */
      }
    }
  }

  /** Opens the append stream lazily; any stream error permanently disables file output. */
  private fileStream(): fs.WriteStream | undefined {
    if (this.fileDisabled) return undefined
    if (!this.stream) {
      const stream = fs.createWriteStream(this.file, { flags: 'a' })
      stream.on('error', () => this.disableFile())
      this.stream = stream
    }
    return this.stream
  }

  private disableFile(): void {
    this.fileDisabled = true
    const stream = this.stream
    this.stream = undefined
    stream?.destroy()
  }

  debug(text: string): void {
    this.write('debug', text)
  }

  info(text: string): void {
    this.write('info', text)
  }

  warn(text: string): void {
    this.write('warn', text)
  }

  error(text: string, error?: unknown): void {
    this.write('error', text, error)
  }

  child(scope: string): Logger {
    const nested = new Logger(`${this.scope}/${scope}`, path.dirname(this.file))
    nested.sinks = this.sinks
    return nested
  }

  tail(count = 200): LogRecord[] {
    return this.memory.slice(-count)
  }

  filePath(): string {
    return this.file
  }

  close(): void {
    this.stream?.end()
    this.stream = undefined
  }
}
