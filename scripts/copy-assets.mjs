// copy-assets.mjs — 构建后把 src/assets 拷贝到 lib/assets（HTML 等非 ts 资源）
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // scripts/
const root = join(here, '..')
const srcAssets = join(root, 'src', 'assets')
const libAssets = join(root, 'lib', 'assets')

if (existsSync(srcAssets)) {
  mkdirSync(libAssets, { recursive: true })
  cpSync(srcAssets, libAssets, { recursive: true })
  console.log('[copy-assets] src/assets → lib/assets ✓')
} else {
  console.log('[copy-assets] src/assets 不存在，跳过')
}
