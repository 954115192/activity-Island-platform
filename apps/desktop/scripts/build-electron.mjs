import { build } from 'esbuild'
import ts from 'typescript'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = path.join(root, 'electron')
const output = path.join(root, 'dist-electron')
const configFile = path.join(root, 'tsconfig.electron.json')
const config = ts.readConfigFile(configFile, ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
  getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
}))
const entries = parsed.fileNames.map(file => path.resolve(file)).filter(file => file.startsWith(source + path.sep) && !file.endsWith('.d.ts'))

// Type checking runs before this script. Preserve tsc's CommonJS module shape,
// preload paths, __dirname and test hooks. Bundle only the ESM workspace boundary.
const sharedEntry = path.join(source, 'shared', 'platform.ts')
await build({
  entryPoints: [sharedEntry],
  outfile: path.join(output, 'shared', 'platform.js'),
  platform: 'node', target: 'node20', format: 'cjs', bundle: true,
  sourcemap: true,
})
await Promise.all(entries.filter(file => file !== sharedEntry).map(async file => {
  const relative = path.relative(source, file)
  const target = path.join(output, relative.replace(/\.ts$/, '.js'))
  const result = ts.transpileModule(await readFile(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, sourceMap: true,
    },
  })
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, result.outputText)
  await writeFile(target + '.map', result.sourceMapText)
}))
