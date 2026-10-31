const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const expected = require('./fixtures/ipc-channels.json')

test('production IPC preserves every original channel, kind and registration count', () => {
  const root = path.resolve(__dirname, '../..')
  const configPath = path.join(root, 'tsconfig.electron.json')
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root)
  const actual = []
  for (const file of config.fileNames) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === 'ipcMain'
        && ['handle', 'on'].includes(node.expression.name.text) && ts.isStringLiteral(node.arguments[0])) {
        actual.push(node.expression.name.text + ':' + node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.equal(new Set(actual).size, actual.length, 'duplicate registrations')
  assert.deepEqual(actual.sort(), expected)
})
