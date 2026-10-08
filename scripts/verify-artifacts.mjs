#!/usr/bin/env node
/**
 * Checks that electron-builder produced every artifact the release expects, then
 * writes SHA256SUMS.txt next to them. Run after `npx electron-builder --win --x64`.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(ROOT, 'release')
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

const EXPECTED = [
  { name: `MoucX-${version}-Setup-x64.exe`, minBytes: 20 * 1024 * 1024, what: '安装包' },
  { name: `MoucX-${version}-portable-x64.exe`, minBytes: 20 * 1024 * 1024, what: '免安装单文件' },
  { name: `MoucX-${version}-windows-x64.zip`, minBytes: 20 * 1024 * 1024, what: '快捷包' }
]

const problems = []
const rows = []

for (const item of EXPECTED) {
  const file = path.join(RELEASE, item.name)
  if (!fs.existsSync(file)) {
    problems.push(`缺少${item.what}: ${item.name}`)
    continue
  }
  const size = fs.statSync(file).size
  if (size < item.minBytes) {
    problems.push(`${item.name} 只有 ${(size / 1024 / 1024).toFixed(1)}MB，疑似打包不完整`)
    continue
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  rows.push({ name: item.name, size, sha256, what: item.what })
}

// Anything else in release/ is unexpected and would silently ship.
const IGNORED = /^(\.|builder-debug\.yml$|latest\.yml$|.*\.blockmap$|win-unpacked$|\.icon-ico$)/
const strays = fs
  .existsSync(RELEASE)
  ? fs
      .readdirSync(RELEASE, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !IGNORED.test(entry.name) && !EXPECTED.some((item) => item.name === entry.name))
      .map((entry) => entry.name)
  : []

if (rows.length > 0) {
  fs.writeFileSync(
    path.join(RELEASE, 'SHA256SUMS.txt'),
    rows.map((row) => `${row.sha256}  ${row.name}`).join('\n') + '\n',
    'utf8'
  )
}

for (const row of rows) {
  console.log(`ok   ${(row.size / 1024 / 1024).toFixed(1).padStart(7)}MB  ${row.name}`)
  console.log(`     sha256 ${row.sha256}`)
}
for (const stray of strays) console.log(`note 未预期的文件: ${stray}`)

if (problems.length > 0) {
  console.error('\n产物校验失败:')
  for (const problem of problems) console.error(' - ' + problem)
  console.error('\nrelease/ 目录内容: ' + (fs.existsSync(RELEASE) ? fs.readdirSync(RELEASE).join(', ') : '(不存在)'))
  process.exit(1)
}
console.log(`\n3 个产物齐备，SHA256SUMS.txt 已写入 release/`)
