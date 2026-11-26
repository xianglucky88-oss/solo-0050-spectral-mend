import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

async function check(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) await check(path)
    else if (entry.name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' })
  }
}

await check('server')
await check('public')
await import('../server/app.mjs')
