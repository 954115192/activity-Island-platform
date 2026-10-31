import { build } from 'esbuild'
import ts from 'typescript'
import { readdir, mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = path.join(root, 'electron')
const output = path.join(root, 'dist-electron')
async function entries(directory) {
  const files = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(files.map(file => file.isDirectory()
    ? entries(path.join(directory, file.name))
    : file.name.endsWith('.ts') ? [path.join(directory, file.name)] : []))).flat()
}

// Type checking runs before this script. Preserve tsc's CommonJS module shape,
// preload paths, __dirname and test hooks. Bundle only the ESM workspace boundary.
const sharedEntry = path.join(source, 'shared', 'platform.ts')
await build({
  entryPoints: [sharedEntry],
  outfile: path.join(output, 'shared', 'platform.js'),
  platform: 'node', target: 'node20', format: 'cjs', bundle: true,
  sourcemap: true,
})
await Promise.all((await entries(source)).filter(file => file !== sharedEntry).map(async file => {
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
