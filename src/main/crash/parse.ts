/**
 * Crash report / log tail parsing.
 *
 * The parser is deliberately dumb: it only extracts *verbatim* line groups from the
 * text (headline exception, `Caused by:` chain, the `-- Head --` section, the first
 * frames, the system-details mod list) so the analyser can quote them back to the
 * user without inventing anything. Vanilla writes `-- Head --`, Forge writes
 * `---- Head ----`, both are handled by the same section regex.
 */

/** How many `at ...` frames we keep. More is noise, fewer loses the culprit. */
export const MAX_FRAMES = 12

/** Cap on the text we look at; a 40 MB log tail parses just as well as a 500 KB one. */
export const MAX_ANALYZED_CHARS = 500_000

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g

/** Vanilla's separator before the report body. */
export const WALKTHROUGH_MARKER = 'A detailed walkthrough of the error'

/** `-- Head --` / `---- Uptime --` / `-- System Details --`. */
const SECTION_RE = /^\s*-{2,4}\s*(.+?)\s*-{2,4}\s*$/

/**
 * A real exception line: a dotted class name ending in Exception/Error/Throwable,
 * followed by `:`. The `(?::|$)` guard is what keeps `at Foo.getError(...)` out.
 */
const EXCEPTION_RE =
  /((?:[A-Za-z_$][\w$]*\.){1,}[A-Z$][\w$]*(?:Exception|Error|Throwable))(?::\s|$|:)/g

/** Lines that introduce an exception in the cause chain. */
const CAUSE_PREFIX_RE = /^\s*(?:Caused by(?:\s+\d+)?|Suppressed|Encapsulated)(?::\s|$)/

/**
 * Any `<package>.<Class>: <message>` line, including throwables that do not end in
 * Exception/Error (`com.example.WeirdProblem: nope`). The leaf must start with an
 * uppercase letter so `net.minecraftforge: forge-47.1.0` detail lines stay out.
 */
const THROWN_RE = /^\s*(?:Caused by(?:\s+\d+)?:|Suppressed:)?\s*([\w$]+(?:\.[\w$]+)*\.([A-Z][\w$]*)):\s?\S/

const FRAME_RE = /^\s*at\s+\S/

export interface CrashModel {
  /** Normalized full text (CRLF folded, ANSI stripped). */
  text: string
  /** `text` split into lines; every quoted evidence line comes out of here. */
  lines: string[]
  /** First top-level exception line (not a `Caused by:` line). */
  headline?: string
  /** Value of the `Description:` line, when present. */
  description?: string
  /** The stacked cause chain, in report order, verbatim. */
  causes: string[]
  /** First `MAX_FRAMES` stack frames, verbatim. */
  frames: string[]
  /** Body of the `Head` section (thread + first frames). */
  head: string[]
  /** Section titles in order, e.g. `['Head', 'System Details']`. */
  sections: string[]
  /** Mod list rows harvested from the system-details section. */
  modLines: string[]
  /** True when the vanilla detailed-walkthrough marker was seen. */
  walkthrough: boolean
  /** Last exception-looking line anywhere in the text. */
  lastException?: string
  /** `Thread: ...` value, useful for "渲染线程崩溃". */
  thread?: string
}

/** All exception-ish class names mentioned in a line, in order. */
export function exceptionNamesIn(line: string): string[] {
  const out: string[] = []
  EXCEPTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EXCEPTION_RE.exec(line)) !== null) {
    if (match[1]) out.push(match[1])
  }
  return out
}

export function isExceptionLine(line: string): boolean {
  return exceptionNamesIn(line).length > 0 || THROWN_RE.test(line)
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(ANSI_RE, '')
}

export function buildCrashModel(raw: string): CrashModel {
  const clipped = raw.length > MAX_ANALYZED_CHARS ? raw.slice(0, MAX_ANALYZED_CHARS) : raw
  const text = normalize(clipped)
  const lines = text.split('\n')

  const causes: string[] = []
  const frames: string[] = []
  const sections: string[] = []
  let headline: string | undefined
  let description: string | undefined
  let thread: string | undefined
  let lastException: string | undefined

  for (const line of lines) {
    const names = exceptionNamesIn(line)
    if (names.length > 0) {
      lastException = line
      if (CAUSE_PREFIX_RE.test(line)) causes.push(line.trim())
      else if (!headline) headline = line.trim()
    } else if (THROWN_RE.test(line)) {
      // A throwable we do not recognize by suffix still belongs in the cause chain.
      lastException = line
      if (CAUSE_PREFIX_RE.test(line)) causes.push(line.trim())
    }
    if (frames.length < MAX_FRAMES && FRAME_RE.test(line)) frames.push(line.trim())

    const section = SECTION_RE.exec(line)
    if (section?.[1]) sections.push(section[1])

    if (!description) {
      const desc = /^\s*Description:\s*(.+)$/.exec(line)
      if (desc?.[1]) description = desc[1].trim()
    }
    if (!thread) {
      const t = /^\s*Thread:\s*(.+)$/.exec(line)
      if (t?.[1]) thread = t[1].trim()
    }
  }

  const head = sectionLines(lines, /^head$/i, 8)
  const modLines = collectModLines(lines)

  const model: CrashModel = {
    text,
    lines,
    causes,
    frames,
    head,
    sections,
    modLines,
    walkthrough: lines.some((line) => line.includes(WALKTHROUGH_MARKER)),
    lastException
  }
  if (headline !== undefined) model.headline = headline
  if (description !== undefined) model.description = description
  if (thread !== undefined) model.thread = thread
  return model
}

/** Lines belonging to a `-- <title> --` section, up to `limit`. */
export function sectionLines(lines: string[], title: RegExp, limit = 40): string[] {
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    const section = SECTION_RE.exec(line)
    if (section?.[1]) {
      if (inside) break
      inside = title.test(section[1])
      continue
    }
    if (!inside) continue
    if (line.trim().length === 0) {
      if (out.length > 0) break
      continue
    }
    out.push(line.trimEnd())
    if (out.length >= limit) break
  }
  return out
}

/**
 * Mod list rows: Fabric prints `		modid: Name 1.2.3`, Forge prints
 * `| modid | Name | 1.2.3 | file.jar`, plus the `Mod List:`/`Fabric Mods:` headers.
 * Anything that is not a frame / key-value detail line counts.
 */
function collectModLines(lines: string[]): string[] {
  const out: string[] = []
  let inDetails = false
  for (const line of lines) {
    const section = SECTION_RE.exec(line)
    if (section?.[1]) {
      inDetails = /system details|mod list|fabric mods|mod loaded/i.test(section[1])
      continue
    }
    if (!inDetails) continue
    if (FRAME_RE.test(line)) continue
    if (/^\s*\t*\|/.test(line) || /^\s*\t{2,}[A-Za-z0-9_.$-]+:/.test(line)) out.push(line.trim())
    if (out.length > 400) break
  }
  return out
}

/** The deepest cause line — usually the real reason. */
export function deepestCause(model: CrashModel): string | undefined {
  return model.causes.length > 0 ? model.causes[model.causes.length - 1] : undefined
}
