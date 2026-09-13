// dsh-panel client bundle 包装：tsdown 的 CJS 产物 → window.__ModuleLoader__.load 格式。
//
// WHY（协议而非风格）：DSH Web 客户端模块系统按 `package.json` 的 `./client` 导出**读取文件字节**
// 算 revision，浏览器侧再执行该文件——它必须自行调用 `window.__ModuleLoader__.load({ id, factory })`
// 完成注册。id 必须是**包名**（宿主按插件包名查表），因此这里从 package.json 读，不硬写。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const cjs = readFileSync(join(root, 'lib', 'client.cjs'), 'utf8')
const wrapper =
  'window.__ModuleLoader__.load({\n' +
  `\tid: ${JSON.stringify(pkg.name)},\n` +
  '\tfactory: (require) => {\n' +
  '\t\tvar module = { exports: {} };\n' +
  '\t\tvar exports = module.exports;\n' +
  cjs +
  '\n' +
  '\t\treturn module.exports;\n' +
  '\t}\n' +
  '});\n'
writeFileSync(join(root, 'lib', 'client.js'), wrapper, 'utf8')
console.log('client.js wrapped:', wrapper.length, 'chars, id=' + pkg.name)
