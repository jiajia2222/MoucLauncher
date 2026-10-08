#!/usr/bin/env node
/**
 * Boots the real Electron app with `--smoke-test` and waits for the main process to
 * report that the window loaded, the preload bridge exists and the services answered.
 * Type checking cannot catch "the app does not start"; this does.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronBinary = require('electron')

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 150_000)
const child = spawn(
  electronBinary,
  ['.', '--smoke-test', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-software-rasterizer'],
  {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', MoucX_SMOKE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

let output = ''
let settled = false

const onData = (chunk) => {
  const text = chunk.toString()
  output += text
  process.stdout.write(text)
  if (!settled && /SMOKE_OK/.test(output)) {
    settled = true
    clearTimeout(timer)
    child.kill()
    console.log('\nsmoke: 应用启动、渲染进程加载、preload 桥接与服务调用全部通过')
    process.exit(0)
  }
  if (!settled && /SMOKE_FAIL/.test(output)) {
    settled = true
    clearTimeout(timer)
    child.kill()
    console.error('\nsmoke: 应用自检失败')
    process.exit(1)
  }
}

child.stdout.on('data', onData)
child.stderr.on('data', onData)

const timer = setTimeout(() => {
  if (settled) return
  settled = true
  child.kill()
  console.error(`\nsmoke: ${TIMEOUT_MS}ms 内没有看到 SMOKE_OK`)
  console.error('--- 输出结尾 ---')
  console.error(output.slice(-4000))
  process.exit(1)
}, TIMEOUT_MS)

child.on('exit', (code) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  console.error(`\nsmoke: Electron 进程提前退出，code=${code}`)
  console.error(output.slice(-4000))
  process.exit(1)
})
