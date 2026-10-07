/**
 * Java adapter for the ported runtime manager: upstream kept this surface in one flat
 * `api.ts` (`listJava` / `refreshJava` / `addCustomJava`); here it is the `window.mouc.java`
 * + `instance` + `settings` surface unwrapped through `core.call()`.
 *
 * Not ported: upstream's `hideJava` (a display-only blocklist this build has no backend
 * for) and its cancellable full-disk scan progress channel — `mouc.java.scan()` is a single
 * request with no progress events.
 *
 * Upstream: KAMUCL src/renderer/src/api.ts + views/SettingsView.vue (MIT, (c) 2026
 * kamubaba-i) — see /THIRD_PARTY_NOTICES.md and /licenses/KAMUCL-MIT.txt.
 */
import type {
  Instance,
  InstanceJavaConfig,
  InstanceSummary,
  JavaProvisionResult,
  JavaRuntime,
  JavaSource,
  Settings
} from '@shared/types'
import { api, call, plain } from './core'

/** Majors Mojang's manifests ask for across supported game lines. */
export const JAVA_MAJORS = [8, 11, 17, 21, 25]

export const JAVA_SOURCE_LABELS: Record<JavaSource, string> = {
  'system-path': 'PATH',
  scan: '本机扫描',
  adoptium: 'Temurin',
  zulu: 'Azul Zulu',
  mojang: '官方组件',
  manual: '手动添加'
}

export const ARCH_LABELS: Record<JavaRuntime['arch'], string> = {
  x64: '64 位',
  x86: '32 位',
  arm64: 'ARM64',
  unknown: '未知架构'
}

export const listRuntimes = (): Promise<JavaRuntime[]> => call(api().java.list())

export const scanRuntimes = (): Promise<JavaRuntime[]> => call(api().java.scan())

export const provisionRuntime = (
  major: number,
  imageType: 'jre' | 'jdk'
): Promise<JavaProvisionResult> =>
  call(api().java.provision(plain({ major, imageType })))

export const removeRuntime = (id: string): Promise<boolean> => call(api().java.remove(id))

/** Which runtime an instance gets; `runtime: null` means it still needs a download. */
export const resolveRuntime = (
  instanceId: string
): Promise<{ runtime: JavaRuntime | null; major: number }> => call(api().java.resolve(instanceId))

export const listInstances = (): Promise<InstanceSummary[]> => call(api().instance.list())

/** Instance pinning writes through `instance.update`; the rest of the record is untouched. */
export const setInstanceJava = (
  instance: Instance,
  java: InstanceJavaConfig
): Promise<Instance> => call(api().instance.update(plain({ id: instance.id, java })))

export const readJavaSettings = (): Promise<Settings> => call(api().settings.get())

export const saveJavaSettings = (patch: Partial<Settings>): Promise<Settings> =>
  call(api().settings.set(plain(patch)))

export const pickJavaExecutable = (): Promise<string | undefined> =>
  call(
    api().app.pickFile('选择 javaw.exe 或 java.exe', [
      { name: 'Java 可执行文件', extensions: ['exe', 'bin'] }
    ])
  )

export const pickScanDir = (): Promise<string | undefined> =>
  call(api().app.pickFolder('选择 Java 扫描目录'))
