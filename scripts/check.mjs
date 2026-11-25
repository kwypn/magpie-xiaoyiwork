#!/usr/bin/env node
/**
 * 发布前自检：不装 magpie、不需要凭据、不需要网络。
 *
 *   node scripts/check.mjs
 *
 * 检查项：
 *   1. 所有 .mjs 语法通过
 *   2. package.json 形状（name/version/main/files/magpie.icon）
 *   3. 图标是合法 data URI 且能解出 PNG
 *   4. 入口只导出一个插件函数（magpie 会把每个函数导出都当插件调用）
 *   5. provider id 与上游端点一致（不要写死错 host）
 *   6. files 清单覆盖全部被 import 的模块
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failed += 1
}

/* 1. 语法 */
const mjsFiles = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.mjs')) mjsFiles.push(full)
  }
}
walk(root)
for (const file of mjsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    ok(true, `语法 ${path.relative(root, file)}`)
  } catch (err) {
    ok(false, `语法 ${path.relative(root, file)}`, String(err.stderr || err).slice(0, 200))
  }
}

/* 2. package.json */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
ok(pkg.name === 'magpie-xiaoyiwork', '包名', pkg.name)
ok(/^\d+\.\d+\.\d+$/.test(pkg.version), '版本号 semver', pkg.version)
ok(pkg.type === 'module', 'type=module')
ok(pkg.main === './index.mjs', 'main 指向 index.mjs', pkg.main)
ok(Array.isArray(pkg.files) && pkg.files.includes('index.mjs'), 'files 含 index.mjs')
ok(Array.isArray(pkg.files) && pkg.files.includes('src'), 'files 含 src')

/* 3. 图标 */
const icon = pkg.magpie?.icon ?? ''
ok(icon.startsWith('data:image/png;base64,'), 'magpie.icon 是 PNG data URI', icon.slice(0, 30))
try {
  const buf = Buffer.from(icon.replace(/^data:image\/png;base64,/, ''), 'base64')
  ok(buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', '图标是合法 PNG', `${buf.length} 字节`)
} catch (err) {
  ok(false, '图标解码', String(err))
}

/* 4. 入口导出形状 */
const mod = await import(path.join(root, 'index.mjs'))
const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function')
ok(fns.length === 1, '入口只导出一个函数', fns.map(([k]) => k).join(','))
ok(fns[0]?.[0] === 'XiaoyiWorkAuthPlugin', '插件工厂名', fns[0]?.[0])

/* 5. provider id / 端点一致性 */
const ctx = await import(path.join(root, 'src/context.mjs'))
ok(ctx.PROVIDER === 'xiaoyiwork', 'provider id', ctx.PROVIDER)
ok(ctx.SSE_BASE === 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api', '上游网关', ctx.SSE_BASE)
ok(ctx.ENDPOINTS.gallery.includes('user-ability-gallery'), '模型目录端点')
ok(ctx.ENDPOINTS.billing.includes('ability-billing'), '额度端点')
ok(ctx.PRD_PKG_NAME === 'com.huawei.hmos.vassistant', 'x-prd-pkg-name')

/* 6. files 覆盖被 import 的模块 */
const imported = new Set()
for (const file of mjsFiles) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[1])
    if (!fs.existsSync(target)) {
      ok(false, `import 目标存在`, `${path.relative(root, file)} → ${m[1]}`)
      continue
    }
    imported.add(path.relative(root, target).split(path.sep).join('/'))
  }
}
for (const rel of imported) {
  const covered = pkg.files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, '') + '/'))
  ok(covered, `files 覆盖 ${rel}`)
}

console.log(failed ? `\n${failed} 项不通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
