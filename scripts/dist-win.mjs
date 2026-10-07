#!/usr/bin/env node
/**
 * One-command Windows build: bundles with electron-vite, packages with
 * electron-builder (NSIS installer + portable exe + zip), then verifies the three
 * artifacts and writes SHA256SUMS.txt.
 *
 *   node scripts/dist-win.mjs [--skip-build] [--arch=x64]
 *
 * electron-builder downloads winCodeSign/nsis from GitHub; in mainland China that is
 * usually unreachable, so a mirror is defaulted here (override with the env var).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arch = (argv.find((a) => a.startsWith('--arch=')) ?? '--arch=x64').split('=')[1]
const skipBuild = argv.includes('--skip-build')

const env = {
  ...process.env,
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

function run(command, args, label) {
  // Only .cmd shims need a shell; running node.exe through cmd.exe breaks on the
  // spaces in "C:\Program Files\nodejs\node.exe".
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  console.log(`\n> ${label}: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit', shell: needsShell })
  if (result.error) {
    console.error(`${label} 无法启动: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`${label} 失败，退出码 ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

run(process.execPath, [path.join(ROOT, 'scripts', 'gen-icons.mjs')], 'icons')
if (!skipBuild) {
  run(npx, ['electron-vite', 'build'], 'bundle')
}

fs.rmSync(path.join(ROOT, 'release'), { recursive: true, force: true })
run(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--win', `--${arch}`, '--publish', 'never'], 'package')
run(process.execPath, [path.join(ROOT, 'scripts', 'verify-artifacts.mjs')], 'verify')

console.log('\n产物目录: release/')
