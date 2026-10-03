import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const domainRoot = resolve(root, 'packages/development-guardian')
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? files(resolve(dir, entry.name)) : entry.name.endsWith('.ts') ? [resolve(dir, entry.name)] : [])
let checked = 0
for (const file of files(domainRoot)) {
  const local = relative(domainRoot, file).split(sep).join('/')
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    const literal = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier :
      ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : undefined
    if (literal && ts.isStringLiteral(literal)) {
      const name = literal.text
      if (local.startsWith('governance/') && !name.startsWith('./')) {
        throw new Error(`Pure governance policy cannot import a runtime capability: ${relative(root, file)} -> ${name}`)
      }
      for (const domain of ['governance', 'escalation']) {
        if (!local.startsWith(domain + '/') && new RegExp('(?:^|/)' + domain + '/(?!index\\.js$)').test(name)) {
          throw new Error(`Domain caller must use its public index: ${relative(root, file)} -> ${name}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast); checked++
}
console.log(JSON.stringify({ status: 'ok', checked, policy: 'governance is pure; governance/escalation use public APIs' }))
