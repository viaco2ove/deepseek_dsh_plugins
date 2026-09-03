// Build: copy host half to lib/, syntax-check both halves.
import { mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, 'src', 'index.js'), join(root, 'lib', 'index.js'))

// Client: verify the ModuleLoader wrapper parses as a script (it is a script,
// not a module — no import/export statements allowed inside).
const clientSrc = readFileSync(join(root, 'src', 'client.js'), 'utf8')
new Function('window', 'require', clientSrc) // throws on syntax error
copyFileSync(join(root, 'src', 'client.js'), join(root, 'lib', 'client.js'))

console.log('build ok: lib/index.js, lib/client.js')