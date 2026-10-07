/**
 * Ordered crash-rule table.
 *
 * Each entry is `{ id, severity, tags, test, title, cause, suggestion }` where `test`
 * is either a RegExp (run over the whole report text) or a predicate that may record a
 * sharper `cause` / `suggestion` / `evidence` into `ctx.note`. The analyser picks the
 * highest severity first, then the earliest table position, so specific rules come
 * before generic ones.
 *
 * All user-facing text is Simplified Chinese: terse, one actionable step, no hedging.
 */
import type { CrashAnalysis, InstalledMod } from '@shared/types'
import type { CrashModel } from './parse'
import { exceptionNamesIn } from './parse'

export type CrashSeverity = CrashAnalysis['severity']

/** Set by predicate rules when they can say more than the static text. */
export interface MatchNote {
  cause?: string
  suggestion?: string
  evidence?: string[]
  tags?: string[]
}

export interface CrashMatchContext {
  model: CrashModel
  /** Lower-cased full report text: the haystack `test` regexps run against. */
  haystack: string
  /** Installed mods of the crashed instance; empty when the instance is unknown. */
  mods: InstalledMod[]
  /** Writable slot for predicate refinements. */
  note?: MatchNote
}

export interface CrashRule {
  id: string
  severity: CrashSeverity
  tags: string[]
  title: string
  cause: string
  suggestion: string
  test: RegExp | ((ctx: CrashMatchContext) => boolean)
}

/* ------------------------------------------------------------------ */
/* verified tables                                                     */
/* ------------------------------------------------------------------ */

/**
 * class 文件 major 版本 -> Java 版本。
 *
 * 来源（2026-10-07 逐条核对规范原文，非二手转述）：
 * - Oracle《The Java Virtual Machine Specification, Java SE 21 Edition》§4.1 表 4.1-A，
 *   https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html
 *   给出 45=1.0.2/1.1、46=1.2、47=1.3、48=1.4、49=5.0、50=6、51=7、52=8、53=9、54=10、
 *   55=11、56=12、57=13、58=14、59=15、60=16、61=17、62=18、63=19、64=20、65=21。
 * - 同规范 Java SE 25 版 §4.1
 *   (https://docs.oracle.com/en/java/javase/25/docs/specs/vm/jvms-4.html) 写明
 *   major_version 合法范围是 45..69（69 = SE 25）。66/67/68 按每版 +1 的既有规律推得
 *   （SE 22/23/24），是推断值，故只用于给建议，不作为结论。
 */
export const CLASS_FILE_MAJOR_TO_JAVA: Readonly<Record<number, string>> = Object.freeze({
  45: '1.1',
  46: '1.2',
  47: '1.3',
  48: '1.4',
  49: '5',
  50: '6',
  51: '7',
  52: '8',
  53: '9',
  54: '10',
  55: '11',
  56: '12',
  57: '13',
  58: '14',
  59: '15',
  60: '16',
  61: '17',
  62: '18',
  63: '19',
  64: '20',
  65: '21',
  // 推断值：SE 25 §4.1 声明上限 69，按每大版本 +1 推得。
  66: '22',
  67: '23',
  68: '24',
  69: '25'
})

/** Java label for a class-file major; `undefined` outside the verified table. */
export function javaForClassMajor(major: number): string | undefined {
  return CLASS_FILE_MAJOR_TO_JAVA[major]
}

/**
 * `ClassNotFoundException` / `NoClassDefFoundError` 里只有包名没有模组 ID。
 * 首条命中的前缀只作为“可能的提供方”提示，不当成结论。
 */
export const PACKAGE_PREFIX_TO_MOD: readonly { prefix: string; hint: string }[] = Object.freeze([
  { prefix: 'net/fabricmc/api', hint: 'Fabric API（fabric-api）' },
  { prefix: 'net/fabricmc/loader', hint: 'Fabric Loader 本体' },
  { prefix: 'net/fabricmc/fabric', hint: 'Fabric API（fabric-api）' },
  { prefix: 'net/fabricmc', hint: 'Fabric Loader / Fabric API' },
  { prefix: 'org/quiltmc', hint: 'QSL 或 Fabric API（Quilt 需要前置）' },
  { prefix: 'net/minecraftforge', hint: 'Forge 本体' },
  { prefix: 'net/neoforged', hint: 'NeoForge 本体' },
  { prefix: 'cpw/mods', hint: 'Forge 本体' },
  { prefix: 'org/spongepowered/asm/mixin', hint: 'SpongePowered Mixin（由加载器提供）' },
  { prefix: 'org/joml', hint: 'JOML 数学库前置' },
  { prefix: 'org/lwjgl', hint: 'LWJGL（由 Minecraft 提供）' },
  { prefix: 'com/mojang/blaze3d', hint: 'Minecraft 渲染层（与光影/渲染模组冲突）' },
  { prefix: 'com/mojang', hint: 'Minecraft 本体类' },
  { prefix: 'net/minecraft/class_', hint: 'Minecraft 混淆类（模组与游戏版本不匹配）' },
  { prefix: 'net/minecraft', hint: 'Minecraft 本体类' },
  { prefix: 'io/netty', hint: 'Netty（由 Minecraft 提供）' },
  { prefix: 'org/slf4j', hint: 'SLF4J 日志前置' },
  { prefix: 'org/apache/logging/log4j', hint: 'Log4j（由 Minecraft 提供）' },
  { prefix: 'org/objectweb/asm', hint: 'ASM 前置' },
  { prefix: 'com/google/gson', hint: 'Gson（模组自带打包造成冲突）' },
  { prefix: 'org/optifine', hint: 'OptiFine' },
  { prefix: 'net/irisshaders', hint: 'Iris 光影' },
  { prefix: 'me/jellysquid', hint: 'Sodium / Lithium 系列' },
  { prefix: 'vazkii', hint: 'Botania / Patchouli 系列' },
  { prefix: 'slimeknights', hint: 'Tinkers Construct（slimeknights 系列）' },
  { prefix: 'mekanism', hint: 'Mekanism' },
  { prefix: 'appeng', hint: 'Applied Energistics 2' }
])

/** Packages that belong to the JDK / libraries, never to a mod. */
const SYSTEM_PACKAGE_RE = /^(?:java|javax|jdk|sun|com\.sun|org\.eclipse|scala|kotlin|io\.netty|com\.google)/

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** `sodium-fabric-0.60.0+mc1.21.4.jar` -> `sodium-fabric`. Best effort, grouping only. */
export function fileStem(fileName: string): string {
  const base = fileName.replace(/\.(jar|zip|litemod|disabled)$/i, '').replace(/\.jar$/i, '')
  const out: string[] = []
  for (const part of base.split(/[-_+ ]/)) {
    if (/^\d/.test(part) || /^\./.test(part)) break
    out.push(part)
  }
  return out.length > 0 ? out.join('-').toLowerCase() : base.toLowerCase()
}

function modKeys(mod: InstalledMod): string[] {
  return [...new Set([mod.modId?.toLowerCase(), fileStem(mod.fileName)].filter((v): v is string => Boolean(v)))]
}

function groupByModId(mods: InstalledMod[]): Map<string, InstalledMod[]> {
  const groups = new Map<string, InstalledMod[]>()
  for (const mod of mods) {
    for (const key of modKeys(mod)) {
      const list = groups.get(key)
      if (list) {
        if (!list.includes(mod)) list.push(mod)
      } else groups.set(key, [mod])
    }
  }
  return groups
}

/** Best-effort "which mod probably ships this class". */
export function likelyModForClass(className: string): string | undefined {
  const internal = className.replace(/\./g, '/').replace(/^L/, '')
  if (SYSTEM_PACKAGE_RE.test(internal.replace(/\//g, '.'))) return undefined
  const hit = PACKAGE_PREFIX_TO_MOD.find((p) => internal.startsWith(p.prefix))
  if (hit) return hit.hint
  const first = internal.split('/')[0]
  return first && first.length > 2 && /[a-z]/.test(first) ? `包名 ${first} 对应的模组` : undefined
}

/** Mod ids / class packages the report itself spells out (used for enrichment). */
export function modNamesInReport(model: CrashModel): string[] {
  const out: string[] = []
  for (const line of model.lines) {
    const section = /--\s*MOD\s+(\S+)\s*--/i.exec(line)
    if (section?.[1]) out.push(section[1])
    const quoted = /Mod\s+['"]([\w.-]+)['"]/i.exec(line)
    if (quoted?.[1]) out.push(quoted[1])
    for (const name of exceptionNamesIn(line)) {
      const parts = name.split('.')
      if (parts.length > 2 && !SYSTEM_PACKAGE_RE.test(parts.slice(0, -1).join('.'))) {
        out.push(parts.slice(0, -1).join('.'))
      }
    }
  }
  return [...new Set(out.map((s) => s.toLowerCase()))]
}

/** Files of the mod list that are switched off (`*.disabled` / toggled). */
function disabledMatch(mods: InstalledMod[], key: string): InstalledMod | undefined {
  const wanted = key.toLowerCase()
  return mods.find((m) => m.disabled === true && modKeys(m).includes(wanted))
}

/* ------------------------------------------------------------------ */
/* predicate rules                                                     */
/* ------------------------------------------------------------------ */

/** Class-file version mismatch, resolved through the verified table above. */
function classFileVersion(ctx: CrashMatchContext): boolean {
  const unsupported = /unsupported class file major version\s+(\d+)/i.exec(ctx.haystack)
  const compiled = /class file version\s+(\d+)(?:\.\d+)?[^.\n]*\.?[\s\S]{0,160}?only recognizes[^\d]*(\d+)/i.exec(
    ctx.haystack
  )
  const wrong = /class file has wrong version\s+(\d+)(?:\.(\d+))?/i.exec(ctx.haystack)
  const required = unsupported?.[1] ?? compiled?.[1] ?? wrong?.[1]
  const current = compiled?.[2] ?? wrong?.[2]
  const mentions = /unsupportedclassversionerror|unsupported class file major version|class file has wrong version/i.test(
    ctx.haystack
  )
  if (!mentions) return false

  const need = required ? javaForClassMajor(Number(required)) : undefined
  const have = current ? javaForClassMajor(Number(current)) : undefined
  const line =
    ctx.model.lines.find((l) => /UnsupportedClassVersionError|class file (?:major version|has wrong version|version \d)/i.test(l))?.trim() ??
    ctx.model.headline
  const note: MatchNote = {}
  note.cause =
    need && have
      ? `有个模组是 Java ${need}（class 文件 ${required}）编译的，当前 Java ${have}（只支持到 class 文件 ${current}），加载不了它。`
      : need
        ? `有个模组是 Java ${need}（class 文件 ${required}）编译的，当前 Java 运行环境太旧，读不了它的字节码。`
        : 'Java 运行环境与模组字节码版本不匹配。'
  note.suggestion = need
    ? `到实例设置把 Java 换成 ${need} 或更高（推荐官方 Java 组件）再启动；若是刚更新过某个模组才出现，先回滚它。`
    : '把 Java 换成较新的版本重试；不确定就用「自动」重新选择 Java。'
  if (line) note.evidence = [line]
  note.tags = ['Java', '版本']
  ctx.note = note
  return true
}

/** Duplicate mod files; when the mod list is known it names the real jars. */
function duplicateMod(ctx: CrashMatchContext): boolean {
  const DUP_LINE_RE =
    /InconsistencyException|DuplicateModsFoundException|Duplicate slot name|duplicate\s+(?:mods?|plugins?|jars?|ids?|slot|from)|duplication\s+of|is\s+already\s+loaded|already\s+loaded\s+(?:from|by)|present\s+in\s+(?:multiple|several)/i
  // Fabric spells a *missing dependency* as "Inconsistency found in dependent mods …";
  // that belongs to the dependency rule, so a line saying `requires` never counts here.
  const dupLines = ctx.model.lines
    .filter((line) => DUP_LINE_RE.test(line) && !/requires|dependent mods|ModDependencyException/i.test(line))
    .map((line) => line.trim())
  if (dupLines.length === 0) return false

  const slotRaw = /Duplicate slot name\s*["']([^"']+)["']/i.exec(dupLines.join('\n'))?.[1]
  // Forge writes `Duplicate slot name "sodium (sodium)" in forge`; take the id part.
  const slot = slotRaw?.split(/[\s(]/)[0]
  const quoted = /\bmod\s+(?:id\s+)?["']([\w.$-]+)["']/i.exec(dupLines.join('\n'))?.[1]
  const named = (slot ?? quoted ?? '').toLowerCase()
  const clash = [...groupByModId(ctx.mods).entries()].filter(([, files]) => files.length > 1)
  const hit = (named.length > 0 && clash.find((c) => c[0] === named)) || clash.find((c) => dupLines.join(' ').includes(c[0]))
  const note: MatchNote = {}
  if (hit) {
    const names = hit[1].map((m) => m.fileName).join(' 与 ')
    note.cause = `同一个模组被加载了两次：${hit[0]} 同时来自 ${names}。`
    note.suggestion = `只保留 ${hit[1].map((m) => m.fileName).join(' / ')} 中最新的那个，其余移出 mods/ 再启动。`
    note.tags = ['模组', '重复']
  } else if (named.length > 0) {
    note.cause = `模组 ID「${named}」重复注册，mods/ 里至少有两个文件都带着它。`
    note.suggestion = `在 mods/ 里搜索「${named}」，只留一个文件，其余移出后再启动。`
    note.tags = ['模组', '重复']
  }
  note.evidence = dupLines.slice(0, 3)
  ctx.note = note
  return true
}

/** `requires <modid>` / missing class: names the prerequisite or its likely provider. */
function missingDependency(ctx: CrashMatchContext): boolean {
  const wanted: { mod: string; from: string }[] = []
  // `Mod "Iris" (iris-fabric-1.7.2+1.21.4.jar) requires "sodium"@[0.6.0,1.0.0)`
  const pairRe = /mod\s+["']?([\w.$-]+)["']?[^\n]{0,60}?requires\s+["']?([\w.$-]+)/gi
  let pair: RegExpExecArray | null
  while ((pair = pairRe.exec(ctx.haystack)) !== null) {
    if (pair[1] && pair[2]) wanted.push({ mod: pair[2], from: pair[1] })
  }
  const pinned = /requires\s+["']?([\w][\w.$-]{2,})["']?\s*(?:@|version|或更高|\bor (?:above|higher)\b)/i.exec(ctx.haystack)
  if (pinned?.[1] && !wanted.some((w) => w.mod === pinned[1]!.toLowerCase())) wanted.push({ mod: pinned[1], from: '模组' })
  const plain = /requires\s+["']?([\w][\w.-]{2,})/i.exec(ctx.haystack)
  if (plain?.[1] && wanted.length === 0) wanted.push({ mod: plain[1], from: '模组' })

  // Case preserved: this runs on the report text, not the lower-cased haystack, so the
  // class name can be quoted back exactly as the loader wrote it. The capture demands a
  // package separator, which keeps prose like `Could not initialize class …` out.
  const cnfeRe = /(?:NoClassDefFoundError|ClassNotFoundException)[\s:]+["']?((?:L?[\w$]+[/]){1,}[\w$]+|[\w$]+(?:\.[\w$]+){2,})/i
  const cnfeClass = cnfeRe.exec(ctx.model.text)?.[1]
  if (wanted.length === 0 && !cnfeClass) return false

  const known = new Set(ctx.mods.flatMap(modKeys))
  const absent = wanted.filter((w) => !known.has(w.mod.toLowerCase()))
  // `requires` alone is not proof — loaders also print satisfied dependencies. Only claim
  // a gap when the text itself says the dependency is absent or the version is wrong.
  const missingWord = /not present|is missing|which is not|but it (?:is|was) not|absent|no such mod|未安装|缺少|找不到/i.test(
    ctx.haystack
  )
  const versionWord = /@ ?[\w.+-]+ ?(?:或更高|or (?:above|higher))|requires[^\n]{0,60}version[^\n]{0,40}(?:but|got|found)/i.test(
    ctx.haystack
  )
  if (!missingWord && !versionWord && !cnfeClass) return false
  const pick = missingWord || versionWord ? (absent.length > 0 ? absent[0] : wanted[0]) : undefined
  if (!pick && !cnfeClass) return false

  const note: MatchNote = {}
  if (pick) {
    const off = disabledMatch(ctx.mods, pick.mod)
    const installed = known.has(pick.mod.toLowerCase())
    if (off) {
      note.cause = `「${pick.from}」需要前置「${pick.mod}」，而它在 mods/ 里已被禁用（${off.fileName}）。`
      note.suggestion = `启用「${off.fileName}」再启动即可。`
    } else if (installed) {
      note.cause = `「${pick.from}」需要的前置「${pick.mod}」版本不合适，mods/ 里的构建对不上。`
      note.suggestion = `把「${pick.mod}」更新到与游戏版本匹配的最新构建，再启动。`
    } else {
      note.cause = `「${pick.from}」声明需要前置「${pick.mod}」，但 mods/ 里没有它。`
      note.suggestion = `在模组页搜索「${pick.mod}」，安装与当前游戏版本、加载器匹配的构建放进 mods/ 再启动。`
    }
    note.tags = ['前置', '模组']
  }
  if (cnfeClass) {
    const hint = likelyModForClass(cnfeClass)
    const line = ctx.model.lines.find((l) => /NoClassDefFoundError|ClassNotFoundException/i.test(l))?.trim()
    const dotted = cnfeClass.replace(/\//g, '.').replace(/^L/, '').replace(/;$/, '')
    note.cause = note.cause ?? `运行期找不到类 ${dotted}${hint ? `，它通常由 ${hint} 提供` : ''}。`
    note.suggestion =
      note.suggestion ??
      (hint
        ? `安装或更新 ${hint}，并与依赖它的模组换成同一游戏版本的构建后重启。`
        : `按类名 ${dotted} 找到提供它的模组补上；刚更新过模组的话，把它和它的前置一起回滚或一起更新。`)
    if (line) note.evidence = note.evidence?.concat(line) ?? [line]
    note.tags = note.tags ?? ['前置', '类缺失']
  }
  ctx.note = note
  return true
}

/* ------------------------------------------------------------------ */
/* the ordered table                                                   */
/* ------------------------------------------------------------------ */

const RULES: CrashRule[] = [
  {
    id: 'java-class-version',
    severity: 'critical',
    tags: ['Java', '版本'],
    title: 'Java 版本过低',
    cause: '模组字节码的 class 文件版本比当前 Java 高，JVM 拒绝加载。',
    suggestion: '把实例的 Java 换成模组要求的大版本后重启。',
    test: classFileVersion
  },
  {
    id: 'memory-heap',
    severity: 'critical',
    tags: ['内存', 'JVM'],
    title: '内存不足（Java 堆）',
    cause: 'Java 堆耗尽（OutOfMemoryError: Java heap space / GC 时间占比过高），一般是分配太小或模组太多。',
    suggestion: '实例设置里把最大内存提高 2–4 GB 再启动；模组确实多就分批精简。',
    test: /java\.lang\.OutOfMemoryError(?::?\s*java\s+heap\s+space|:\s*gc overhead|:\s*heap)/i
  },
  {
    id: 'memory-metaspace',
    severity: 'critical',
    tags: ['内存', 'Metaspace'],
    title: '元空间不足',
    cause: 'Metaspace（类元数据）耗尽，模组数量超过默认上限。',
    suggestion: '附加 JVM 参数加 -XX:MaxMetaspaceSize=512m（还不够就升到 1g）后重启。',
    test: /OutOfMemoryError:\s*Metaspace|Metaspace\s*\(|max\s*metaspace/i
  },
  {
    id: 'memory-native',
    severity: 'critical',
    tags: ['内存', '本地内存'],
    title: '堆外内存不足',
    cause: '堆外/本地内存分配失败（Direct buffer、Map full、物理内存不够），调 Java 堆不一定能救。',
    suggestion: '关闭其他吃内存的程序，把 Java 最大内存调低 1 GB 让系统留余量；顺手更新显卡驱动。',
    test: /OutOfMemoryError:\s*(?:Direct buffer memory|Map full|unable to allocate|Physical memory)|native memory allocation|mmap failed|The system cannot allocate/i
  },
  {
    id: 'duplicate-mod',
    severity: 'critical',
    tags: ['模组', '重复'],
    title: '模组重复',
    cause: 'mods/ 里有两份相同模组（同一模组 ID 被两个文件注册），加载器拒绝继续。',
    suggestion: '每个模组只留一个文件，把旧版移出 mods/。',
    test: duplicateMod
  },
  {
    id: 'missing-dependency',
    severity: 'critical',
    tags: ['前置', '模组'],
    title: '缺少前置',
    cause: '某个模组声明了前置依赖或引用了不存在的类，mods/ 里没有提供它的文件。',
    suggestion: '按证据里点名的前置模组，安装与游戏版本、加载器一致的构建。',
    test: missingDependency
  },
  {
    id: 'mixin-failure',
    severity: 'critical',
    tags: ['Mixin', '模组', '版本'],
    title: 'Mixin 注入失败',
    cause: '模组的 Mixin 找不到它要改的游戏方法/字段：模组与本 Minecraft 版本不匹配，或另一个模组改了同一处。',
    suggestion: '更新/回滚证据里点名的那个模组；OptiFine 与 Sodium/Iris 混装时只保留一套渲染优化。',
    test: /Mixin apply failed|InvalidInjectionException|Critical injection failure|MixinTransformerError|Mixin transformation of|@Inject annotation|@Redirect annotation|Mixin for|target method described|incompatible changes were detected|mixin\s+\S+\s+failed/i
  },
  {
    id: 'verify-error',
    severity: 'critical',
    tags: ['字节码', 'Java'],
    title: '字节码校验失败',
    cause: 'VerifyError：某个类的字节码不合法，通常是被过旧的模组或核心补丁（coremod/asm 改写）产生的。',
    suggestion: '按证据里的类名定位模组并更新；装了 coremod/替换类补丁的先移除再验证一次。',
    test: /java\.lang\.VerifyError|\bVerifyError\b/i
  },
  {
    id: 'natives',
    severity: 'critical',
    tags: ['native', 'DLL'],
    title: '本地库缺失',
    cause: 'UnsatisfiedLinkError：native DLL 没解压出来、被占用，或 Java 位数与库不匹配（32 位 Java 载 64 位库）。',
    suggestion: '删除该版本的 natives-windows 目录让它重新解压，并确认实例用的是 64 位 Java。',
    test: /UnsatisfiedLinkError|Can't find library|java\.library\.path|no\s+[\w.-]+\s+in\s+java\.library\.path|failed to load native|Extracting natives?[^\n]*(?:error|fail)/i
  },
  {
    id: 'lwjgl-context',
    severity: 'critical',
    tags: ['显卡', 'LWJGL'],
    title: '图形初始化失败',
    cause: 'LWJGL/GLFW 没能建立 OpenGL 上下文：显卡驱动过旧、游戏跑在远程桌面/虚拟机里，或缺 d3dcompiler_47。',
    suggestion: '更新显卡驱动后重启电脑；笔记本确认可用独立显卡；远程桌面和大部分虚拟机无法运行游戏。',
    test: /could not initialize class org\.lwjgl|GLFWError|WGL(?:Create|Choose|SetSwap)|Failed to (?:setup|create) (?:the )?window|d3dcompiler_47|Couldn'?t create window|no OpenGL|GLFW\.(?:INIT_FAILED|CREATION_ERROR)|org\.lwjgl\.glfw/i
  },
  {
    id: 'gl-runtime-error',
    severity: 'warning',
    tags: ['显卡', '光影'],
    title: '渲染运行期错误',
    cause: '游戏已启动但 OpenGL 调用报错（GL_INVALID_OPERATION 等），多为光影包或某个渲染模组不兼容。',
    suggestion: '先关掉光影（清空 shaders 里的材质包）试一次；仍复现就更新 Iris/OptiFine 与 Sodium 到配套版本。',
    test: /GL_INVALID_\w+|glGetError|OpenGL error|GL error 0x|Error while stealing ?gl|Tried to add window icon/i
  },
  {
    id: 'asset-corrupt',
    severity: 'critical',
    tags: ['文件', '资源'],
    title: '游戏文件缺失或损坏',
    cause: 'assets/ 或 versions/ 下的文件读不到：被删、被占用，或下载不完整导致 jar 损坏。',
    suggestion: '对该版本执行「修复」（校验并重新下载缺失文件）；修复无效就删掉 versions/<版本号> 再重装。',
    test: /FileNotFound(?:Exception)?[^\n]*(?:assets[/\\]|versions[/\\])|(?:assets|versions)[/\\][^\n]*(?:No such file|does not exist|Cannot find|系统找不到)|Invalid or corrupted (?:jar|zip) file|Error opening zip file|ZipException[^\n]*(?:assets[/\\]|versions[/\\])/i
  },
  {
    id: 'mod-jar-unreadable',
    severity: 'critical',
    tags: ['文件', '模组'],
    title: '模组 jar 读不了',
    cause: '某个模组 jar 是坏的（下载被截断、压缩目录缺失），加载器打不开它。',
    suggestion: '按证据里的文件名删掉那个模组并重新下载；还失败就换一个版本或镜像。',
    test: /Missing entry|zip END header not found|error while(?: opening| reading)? ?zip|corrupted zip|invalid literal size|invalid CEN header|Too many files read|Not in GZIP format|JarException|next entry/i
  },
  {
    id: 'optifine-shader',
    severity: 'warning',
    tags: ['OptiFine', '光影'],
    title: '光影 / OptiFine 问题',
    cause: 'OptiFine 或光影包编译 shader 失败：光影与本 OptiFine 版本不配套，或与其他渲染模组冲突。',
    suggestion: '二选一：只用 OptiFine，或只用 Iris + Sodium；仍失败就清空 shaders/ 里的材质包再启动。',
    test: /(?:OptiFine|Iris)[^\n]*(?:shader|\.fsh|\.vsh|Glsl)|(?:shader|\.fsh|\.vsh|GlslImport)[^\n]*(?:error|fail|invalid|couldn'?t|无法)/i
  },
  {
    id: 'world-corrupt',
    severity: 'warning',
    tags: ['存档'],
    title: '存档读取失败',
    cause: '崩溃发生在读取区块/关卡数据时：存档文件损坏，或它依赖的模组已经不在 mods/ 里。',
    suggestion: '先备份再试旧存档；只坏了一个维度就删该维度目录重建，别删已有进度对应的模组。',
    test: /Exception loading chunk|Failed to (?:load|parse) (?:chunk|level|region)|(?:region|level\.dat|sessions\.dat)[^\n]*(?:corrupt|invalid|EOFException|Not a block|Missing)|net\.minecraft\.world[^\n]*(?:Exception|Error)/i
  },
  {
    id: 'java-missing',
    severity: 'critical',
    tags: ['Java', '启动'],
    title: 'Java 无法启动',
    cause: '指定的 javaw.exe 已经不存在或位数不对，进程根本没起来。',
    suggestion: '实例设置里把 Java 改回「自动」，必要时重新下载 Java 组件。',
    test: /CreateProcess error=2|cannot run \w*java|java(?:w)?\.exe[^\n]*(?:not found|不存在|找不到)|Unsupported major\.minor version|bad version/i
  },
  {
    id: 'disk-full',
    severity: 'critical',
    tags: ['磁盘', '文件'],
    title: '磁盘写入失败',
    cause: '磁盘空间不足或目录被写保护/占用，解压与存档写入失败。',
    suggestion: '清理游戏盘（留出约 2 倍实例体积），暂停杀软实时防护后重试。',
    test: /No space left on device|ENOSPC|Quota exceeded|There is not enough space|磁盘空间不足|Access denied[^\n]*(?:\.minecraft|assets|libraries|versions)/i
  }
]

/** The ordered table the analyser walks. */
export const CRASH_RULES: readonly CrashRule[] = Object.freeze(RULES)

/** `info` fallback text when no rule matched — never a claimed root cause. */
export const FALLBACK_ANALYSIS = {
  title: '未识别的崩溃',
  cause: '报告里没有命中任何已知故障特征，只能确定最后抛出的异常。',
  suggestion: '把「复制报告」里的内容发给模组作者，或在实例目录 logs/crash-reports 找同名文件一起提供。'
} as const

export const SEVERITY_RANK: Record<CrashSeverity, number> = { info: 0, warning: 1, critical: 2 }
