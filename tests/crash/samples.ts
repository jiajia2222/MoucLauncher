/**
 * Hand-built but realistic crash reports, one per rule.
 * Shapes follow actual vanilla / Fabric / Forge outputs: the `---- Minecraft Crash
 * Report ----` header, `Time:`/`Description:`, the exception + `Caused by:` chain,
 * `at ...` frames and the `A detailed walkthrough …` separator before `-- Head --`.
 */

export interface Sample {
  ruleId: string
  report: string
}

const HEAD = '---- Minecraft Crash Report ----\n// Don\'t be sad, have a hug! <3\n\n'

function report(description: string, body: string, details = ''): string {
  return `${HEAD}Time: 2026-10-07 19:22:31\nDescription: ${description}\n\n${body}\n\nA detailed walkthrough of the error, its code path and all known details is as follows.\n---------------------------------------------------------------------------------------\n\n---- Head ----\nThread: Render thread\nStacktrace:\n	at knot//net.minecraft.client.Minecraft.method_3134(Minecraft.java:624)\n${details}`
}

export const CLASS_FILE_TOO_NEW = report('Failed to start game', `java.lang.UnsupportedClassVersionError: me/jellysquid/mods/sodium/client/gui/SodiumOptionsGUI has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0
	at java.base/java.lang.ClassLoader.defineClass1(Native Method)
	at java.base/java.lang.ClassLoader.defineClass(ClassLoader.java:1016)
	at net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.loadTargetClass(KnotClassDelegate.java:221)
Caused by: java.lang.RuntimeException: Mixin transformation of net.minecraft.class_666 failed
	at net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.getPostProcessorClassloader(KnotClassDelegate.java:157)
	... 14 more`)

export const CLASS_FILE_WRONG_VERSION = report('Mod loading error', `java.lang.IllegalArgumentException: class file has wrong version 65.0, should be 61.0
	at org.objectweb.asm.ClassReader.<init>(ClassReader.java:199)
	at cpw.mods.modlauncher.api.IncompatibleEnvironmentException.<init>(IncompatibleEnvironmentException.java:1)`)

export const HEAP_OOM = report('Exception in server tick loop', `java.lang.OutOfMemoryError: Java heap space
	at java.base/java.util.Arrays.copyOf(Arrays.java:3512)
	at net.minecraft.world.level.chunk.LevelChunkSection.<init>(LevelChunkSection.java:58)
Caused by: java.lang.OutOfMemoryError: GC overhead limit exceeded
	at java.base/java.lang.Throwable.fillInStackTrace(Native Method)`)

export const METASPACE_OOM = report('Initializing game', `java.lang.OutOfMemoryError: Metaspace
	at java.base/java.lang.ClassLoader.defineClass1(Native Method)
	at net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.loadTargetClass(KnotClassDelegate.java:250)`)

export const DIRECT_BUFFER_OOM = report('Rendering overlay', `java.lang.OutOfMemoryError: Direct buffer memory
	at java.base/java.nio.Bits.reserveMemory(Bits.java:175)
	at java.base/java.nio.DirectByteBuffer.<init>(DirectByteBuffer.java:118)`)

export const DUPLICATE_MOD_FILES = report('Mod loading error has occurred', `java.lang.Exception: Mod Loading has failed
	at net.minecraftforge.logging.CrashReportExtender.dumpModLoadingCrashReport(CrashReportExtender.java:58)
Caused by: net.minecraftforge.fml.DuplicateModsFoundException: mod id 'sodium' present in multiple locations:
	sodium-fabric-0.58.0.jar
	sodium-0.60.0+mc1.21.4.jar
	at net.minecraftforge.fml.serviceloader.LoadingErrorExceptions.duplicateException(LoadingErrorExceptions.java:21)`)

export const DUPLICATE_SLOT_NAME = report('Mod loading error has occurred', `java.lang.Exception: Mod Loading has failed
Caused by: net.minecraftforge.fml.DuplicateModsFoundException: Duplicate slot name "xaerominimap (xaerominimap)" in forge
	at net.minecraftforge.fml.relauncher.LauncherHacks.init(LauncherHacks.java:77)`)

export const MISSING_PREREQUISITE = report('Mod loading error', `net.fabricmc.loader.impl.FormattedException: Mod loading error: fabric-loader
	at net.fabricmc.loader.impl.game.minecraft.MinecraftGameProvider.launch(MinecraftGameProvider.java:455)
Caused by: net.fabricmc.loader.impl.discovery.ModResolutionException: Mod "Iris" (iris-fabric-1.7.2+1.21.4.jar) requires "sodium"@[0.6.0,1.0.0) which is not present
	at net.fabricmc.loader.impl.discovery.ModResolutionException.withText(ModResolutionException.java:30)`)

export const MISSING_CLASS_JOML = report('Rendering screen', `java.lang.NoClassDefFoundError: org/joml/Matrix4f
	at net.irisshaders.iris.pipeline.WorldRenderingPipeline.<init>(WorldRenderingPipeline.java:71)
Caused by: java.lang.ClassNotFoundException: org.joml.Matrix4f
	at java.base/java.net.URLClassLoader.findClass(URLClassLoader.java:445)`)

export const MIXIN_INJECT_FAILURE = report('Initializing 4 mods, 3 mixins, 7 listeners', `java.lang.RuntimeException: Mixin transformation of net.minecraft.client.MinecraftClient failed
	at net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.loadTargetClass(KnotClassDelegate.java:221)
Caused by: org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered
	at org.spongepowered.asm.mixin.transformer.MixinProcessor.applyMixins(MixinProcessor.java:392)
Caused by: org.spongepowered.asm.mixin.gen.throwables.InvalidInjectionException: Critical injection failure: @Inject annotation on handler$zzd000$fixFov could not find any targets matching (Lcom/gtnewhorizons/angelica;)V in net/minecraft/client/MinecraftClient. No known targets found.
	at org.spongepowered.asm.mixin.gen.InvokerAnnotationHelper.checkTarget(InvokerAnnotationHelper.java:42)`)

export const VERIFY_ERROR = report('Unexpected error', `java.lang.VerifyError: Bad type on operand stack
Exception Details:
  Location: com/example/mod/Foo.render(Lnet/minecraft/client/renderer/MultiBufferSource;)V @ 12: invokestatic
  Reason: Type 'java/lang/Object' (constant pool 12) is not assignable to 'com/mojang/blaze3d/vertex/VertexConsumer'
	at com.example.mod.Foo.<clinit>(Foo.java:18)`)

export const NATIVES_MISSING = report('Rendering screen', `java.lang.UnsatisfiedLinkError: Can't find library lwjgl (no lwjgl in java.library.path: C:\\game\\versions\\1.20.4\\natives-windows)
	at org.lwjgl.system.Library.loadNative(Library.java:167)
	at org.lwjgl.system.windows.WindowsLibrary.<init>(WindowsLibrary.java:59)`)

export const LWJGL_CONTEXT = report('Failed to initialize window', `java.lang.RuntimeException: Failed to create window
	at com.mojang.blaze3d.platform.Window.<init>(Window.java:93)
Caused by: java.lang.NoClassDefFoundError: Could not initialize class org.lwjgl.glfw.GLFW
Caused by: org.lwjgl.glfw.GLFWError: 65543: WGL: The driver does not appear to support OpenGL
	at org.lwjgl.glfw.GLFW.wglCreateContext(Native Method)
	Suppressed: java.lang.RuntimeException: d3dcompiler_47.dll is missing, install the DirectX End-User Runtime`)

export const GL_RUNTIME = report('Rendering screen', `java.lang.IllegalStateException: Framebuffer error while rendering inventory
	at com.mojang.blaze3d.pipeline.RenderTarget.method_22670(RenderTarget.java:126)
Caused by: org.lwjgl.opengl.GL11$1: GL_INVALID_OPERATION error generated. The required state is not met.`)

export const ASSET_MISSING = report('Initializing game', `java.io.FileNotFoundException: assets\\objects\\7c\\7cbc21cf9b1b6d4a1c1c2f5e (系统找不到指定的路径。)
	at java.base/java.io.FileInputStream.open0(Native Method)
Caused by: java.util.zip.ZipException: Invalid or corrupted jar file: versions\\1.20.4\\1.20.4.jar
	at java.base/java.util.zip.ZipFile$Source.findEND(ZipFile.java:1637)`)

export const MOD_JAR_UNREADABLE = report('Mod discovery', `java.util.zip.ZipException: zip END header not found
	at java.base/java.util.zip.ZipFile$Source.findEND(ZipFile.java:1637)
	at java.base/java.util.zip.ZipFile.initReader(ZipFile.java:146)
	Suppressed: java.io.IOException: Missing entry META-INF/mods.toml
	at cpw.mods.jarhandling.SecureJar.from(SecureJar.java:66)`)

export const SHADER_FAILURE = report('Updating screen events', `net.optifine.shaders.ShaderException: Failed to compile shader program: shaders/models/gel/water.fsh
	at net.optifine.shaders.Shaders.compileShader(Shaders.java:3381)
	at net.optifine.shaders.Shaders.loadShader(Shaders.java:3120)`)

export const WORLD_CORRUPT = report('Exception ticking world', `java.lang.RuntimeException: Failed to load chunk at -128, 0, 256
	at net.minecraft.server.level.ServerChunkCache.m_140872(ServerChunkCache.java:317)
Caused by: java.io.EOFException: Unexpected end of file
	at java.base/java.io.DataInputStream.readFully(DataInputStream.java:188)`)

export const JAVA_MISSING = report('Failed to start game', `java.io.IOException: Cannot run program "C:\\Program Files\\Java\\old\\bin\\javaw.exe": CreateProcess error=2, 系统找不到指定的文件。
	at java.base/java.lang.ProcessBuilder.start(ProcessBuilder.java:1143)
	at net.minecraft.client.main.Main.main(Main.java:100)`)

export const DISK_FULL = report('Saving game', `java.io.UncheckedIOException: java.io.IOException: No space left on device
	at net.minecraft.world.level.storage.LevelStorageSource$LevelStorageAccess.m_140877_(LevelStorageSource.java:391)
Caused by: java.io.IOException: No space left on device
	at java.base/java.io.FileOutputStream.writeBytes(Native Method)`)

export const UNKNOWN_CRASH = report('Unexpected error', `java.lang.IllegalStateException: Something the analyser has never seen before
	at com.example.Mystery.doThing(Mystery.java:1)
Caused by: com.example.WeirdProblem: nope
	at com.example.Mystery.other(Mystery.java:9)
	... 9 more`)

/** One sample per rule id, in table order; `UNKNOWN_CRASH` is the fallback case. */
export const SAMPLES: Sample[] = [
  { ruleId: 'java-class-version', report: CLASS_FILE_TOO_NEW },
  { ruleId: 'java-class-version', report: CLASS_FILE_WRONG_VERSION },
  { ruleId: 'memory-heap', report: HEAP_OOM },
  { ruleId: 'memory-metaspace', report: METASPACE_OOM },
  { ruleId: 'memory-native', report: DIRECT_BUFFER_OOM },
  { ruleId: 'duplicate-mod', report: DUPLICATE_MOD_FILES },
  { ruleId: 'duplicate-mod', report: DUPLICATE_SLOT_NAME },
  { ruleId: 'missing-dependency', report: MISSING_PREREQUISITE },
  { ruleId: 'missing-dependency', report: MISSING_CLASS_JOML },
  { ruleId: 'mixin-failure', report: MIXIN_INJECT_FAILURE },
  { ruleId: 'verify-error', report: VERIFY_ERROR },
  { ruleId: 'natives', report: NATIVES_MISSING },
  { ruleId: 'lwjgl-context', report: LWJGL_CONTEXT },
  { ruleId: 'gl-runtime-error', report: GL_RUNTIME },
  { ruleId: 'asset-corrupt', report: ASSET_MISSING },
  { ruleId: 'mod-jar-unreadable', report: MOD_JAR_UNREADABLE },
  { ruleId: 'optifine-shader', report: SHADER_FAILURE },
  { ruleId: 'world-corrupt', report: WORLD_CORRUPT },
  { ruleId: 'java-missing', report: JAVA_MISSING },
  { ruleId: 'disk-full', report: DISK_FULL },
  { ruleId: '__fallback__', report: UNKNOWN_CRASH }
]

/** A `logs/latest.log` tail: prefix-tagged lines, the report buried in the middle. */
export function latestLogTailWithCrash(): string {
  const lines: string[] = []
  lines.push('[192231] [main/INFO] [Minecraft/]: Setting user: Player42')
  lines.push('[192232] [Render thread/ERROR] [Minecraft/]: Crash reported')
  lines.push('---- Minecraft Crash Report ----')
  lines.push('// There are blocks still left to mine...')
  lines.push('')
  lines.push('Time: 2026-10-07 19:22:31')
  lines.push('Description: Rendering screen')
  lines.push('')
  lines.push('java.lang.OutOfMemoryError: Java heap space')
  lines.push('\tat java.base/java.util.Arrays.copyOf(Arrays.java:3512)')
  lines.push('\tCaused by: net.minecraft.client.renderer.RenderStateShard$1: GL_INVALID_OPERATION')
  lines.push('\tat com.mojang.blaze3d.pipeline.RenderTarget.method_22670(RenderTarget.java:126)')
  return lines.join('\n')
}

export const LATEST_LOG_WITHOUT_CRASH = [
  '[192231] [main/INFO] [Minecraft/]: Setting user: Player42',
  '[192232] [Worker-Main-3/INFO] [Realms/]: Realms available',
  '[192235] [Destroy thread/INFO] [Minecraft/]: Stopping!'
].join('\n')
