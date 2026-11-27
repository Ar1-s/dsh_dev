import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX = resolve(HERE, '..')

const FIXTURES = [
  { dir: 'sandbox-ui', client: true },
  { dir: 'sandbox-host', client: false },
  { dir: 'sandbox-worker', client: false },
]

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

for (const fixture of FIXTURES) {
  const name = `@local/${fixture.dir}`
  const row = fixture.dir
  test(`${name} is a valid DSH bundle fixture`, async () => {
    const dir = join(SANDBOX, 'fixtures', fixture.dir)
    const pkg = await readJson(join(dir, 'package.json'))

    assert.equal(pkg.name, name)
    assert.equal(pkg.type, 'module')
    assert.ok(pkg.version)
    assert.equal(pkg.exports['.'], './index.js')
    assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')

    const patch = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, new RegExp(`id:\\s*${row}\\b`))
    assert.match(patch, new RegExp(`name:\\s*['"]?${name}['"]?`))

    assert.ok(await exists(join(dir, 'index.js')), 'host half must exist')
    const index = await readFile(join(dir, 'index.js'), 'utf8')
    assert.match(index, /export (async )?function apply\b|export const apply\b/)

    assert.equal(await exists(join(dir, 'client.js')), fixture.client)
  })
}

test('the client fixture ships a classic client bundle for its package id', async () => {
  const dir = join(SANDBOX, 'fixtures', 'sandbox-ui')
  const pkg = await readJson(join(dir, 'package.json'))

  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)

  const client = await readFile(join(dir, 'client.js'), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load\(/)
  assert.match(client, /id:\s*['"]@local\/sandbox-ui['"]/)
  assert.match(client, /require\(['"]react['"]\)/)
  assert.match(client, /data-sandbox-ui/)
})

test('the image installs every fixture as its own profile bundle', async () => {
  const dockerfile = await readFile(join(SANDBOX, 'Dockerfile'), 'utf8')
  for (const fixture of FIXTURES) {
    assert.match(
      dockerfile,
      new RegExp(`dsh plugin --profile web add file:/opt/plugins/${fixture.dir}`),
      `Dockerfile must install ${fixture.dir}`,
    )
  }
})

test('compose keeps the sandbox isolated and loopback-only', async () => {
  const compose = await readFile(join(SANDBOX, 'compose.yml'), 'utf8')
  assert.match(compose, /^name: dsh-sandbox$/m)
  assert.match(compose, /name: dsh-sandbox-dsh-home/)
  assert.match(compose, /name: dsh-sandbox-net/)
  assert.match(compose, /127\.0\.0\.1:\$\{SANDBOX_PORT:-38080\}:3080/)
  assert.doesNotMatch(compose, /0\.0\.0\.0:/)
  assert.match(compose, /read_only: true/)
  assert.match(compose, /no-new-privileges:true/)
})
