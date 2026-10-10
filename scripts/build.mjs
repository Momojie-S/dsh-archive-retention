/**
 * Atomic build orchestrator: the host half (tsc) lands in a staging directory
 * first, and only a fully successful build swaps `lib/` in one rename pair.
 * The client half was removed with the 0.2.0 settings migration: volatile
 * Config fields render on the Plugins page form, so this plugin is host-only.
 */
import { execSync } from 'node:child_process'
import { readFile, writeFile, rm, rename, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const id = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name
const stage = join(root, 'lib-tmp')
const live = join(root, 'lib')
const retired = join(root, 'lib-old')

// ---- 1. host half into staging ----
await rm(stage, { recursive: true, force: true })
// Invoke tsc via its JS bin entry with the running node: PATH-independent
// (a bare `tsc` only resolves when npm put node_modules/.bin on PATH).
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(tscBin)} -p tsconfig.build.json --outDir lib-tmp`, { cwd: root, stdio: 'inherit' })

// ---- 2. client bundle into staging (concatenation, no bundler) ----
const body = await readFile(join(root, 'src/client/index.js'), 'utf8')
if (/^\s*import\s/m.test(body)) {
  throw new Error('client bundle: src/client/index.js must not use import (externals go through require)')
}
const bundle = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  body.trimEnd(),
  'return module.exports; } });',
  '',
].join('\n')
await writeFile(join(stage, 'client.js'), bundle, 'utf8')

// ---- 3a. client-bundle gate: consume it exactly like the browser loader ----
{
  const react = { createElement: () => null, useState: () => [undefined, () => {}], useSyncExternalStore: () => {} }
  const loadCalls = []
  const fakeWindow = { __ModuleLoader__: { load: (desc) => { loadCalls.push(desc) } } }
  const fn = new Function('window', 'return (function () { ' + bundle + '\n})')
  try {
    fn(fakeWindow).call(fakeWindow)
    const desc = loadCalls[0]
    if (desc === undefined) throw new Error('no __ModuleLoader__.load call')
    const factoryRequire = (spec) => {
      if (spec === 'react') return react
      throw new Error(`client gate: unexpected require "${spec}" (module-table externals only)`)
    }
    const factoryModule = { exports: {} }
    const returned = desc.factory.call(factoryModule.exports, factoryRequire)
    const pluginExports = returned ?? factoryModule.exports
    if (typeof pluginExports.apply !== 'function') {
      throw new Error('client gate: bundle exports have no apply — the browser entry would fail with "invalid plugin"')
    }
    if (!Array.isArray(pluginExports.inject)) {
      throw new Error('client gate: bundle exports declare no inject list')
    }
  } catch (error) {
    throw new Error(`build gate (client bundle): ${error.message}`)
  }
}

// ---- 3b. sanity gate: the staged host entry must import cleanly ----
const staged = await import(`${pathToFileURL(join(stage, 'index.js')).href}?gate=${Date.now()}`)
if (typeof staged.apply !== 'function') {
  throw new Error('build gate: staged lib/index.js has no apply export — refusing to swap')
}

// ---- 3. atomic-ish swap ----
const liveExists = await readdir(live).then(() => true, () => false)
if (liveExists) {
  await rm(retired, { recursive: true, force: true })
  await rename(live, retired)
}
try {
  await rename(stage, live)
} catch (error) {
  if (liveExists) await rename(retired, live)
  throw error
}
await rm(retired, { recursive: true, force: true })

console.log(`build: lib/ swapped atomically (host + client ${bundle.length} bytes, id=${id})`)
