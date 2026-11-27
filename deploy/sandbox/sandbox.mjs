#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSE_FILE = resolve(HERE, 'compose.yml')
const PORT = process.env.SANDBOX_PORT ?? '38080'

function fail(message) {
  console.error(`sandbox: ${message}`)
  process.exit(1)
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: HERE,
    encoding: 'utf8',
    env: process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail('the docker CLI was not found; install Docker Desktop or Docker Engine with Compose v2')
    }
    fail(result.error.message)
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? '')
      process.stderr.write(result.stderr ?? '')
    }
    process.exit(result.status ?? 1)
  }
  return (result.stdout ?? '').trim()
}

function compose(args, options) {
  return docker(['compose', '-f', COMPOSE_FILE, ...args], options)
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function loginUrlFromLogs(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let logs = ''
  while (Date.now() < deadline) {
    logs = stripAnsi(compose(['logs', '--no-color', 'dsh'], { capture: true }))
    const matches = [...logs.matchAll(/dsh web:\s+(http:\/\/\S+?\?token=\S+)/g)]
    if (matches.length > 0) {
      const containerUrl = matches.at(-1)[1]
      return containerUrl.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${PORT}`)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  fail(`no DSH login URL in docker compose logs within ${timeoutMs}ms; run "node deploy/sandbox/sandbox.mjs logs"`)
}

function printUrl(url) {
  console.log('')
  console.log(`DSH sandbox is ready: ${url}`)
  console.log('')
}

function up() {
  compose(['up', '-d', '--build', '--wait'])
  printUrl(loginUrlFromLogs())
}

function smoke() {
  compose(['up', '-d', '--build', '--wait'])
  compose(['build', 'smoke'])
  compose(['run', '--rm', '--no-deps', 'smoke'])
}

function down() {
  compose(['down', '-v', '--remove-orphans'])
}

function logs(follow = false) {
  const args = ['logs', '--no-color', '--tail', '200']
  if (follow) args.push('--follow')
  args.push('dsh')
  compose(args)
}

function status() {
  compose(['ps'])
}

function collect() {
  const output = compose(['logs', '--no-color'], { capture: true })
  const path = resolve(HERE, 'sandbox.log')
  writeFileSync(path, `${output}\n`)
  console.log(`wrote ${path}`)
}

function usage() {
  console.log(`Usage: node deploy/sandbox/sandbox.mjs <command>

Commands:
  up        Build the image, start the isolated sandbox, wait for health, and print the login URL
  smoke     Start the sandbox and run the Chromium smoke test
  verify    Destroy, start from clean state, run smoke, collect logs, destroy
  down      Remove the sandbox containers, network, and test volume
  logs      Print the last 200 DSH log lines (--follow to stream)
  status    Show the sandbox compose status
  url       Print the host login URL from the current logs
  collect   Write all compose logs to deploy/sandbox/sandbox.log

Environment:
  SANDBOX_PORT  Loopback host port (default 38080)
  NODE_IMAGE    Base image override for restricted networks
`)
}

const [command = 'help', ...rest] = process.argv.slice(2)

switch (command) {
  case 'up':
    up()
    break
  case 'smoke':
    smoke()
    break
  case 'verify':
    down()
    up()
    smoke()
    collect()
    down()
    console.log('sandbox verify passed; logs collected and all sandbox resources were removed')
    break
  case 'down':
    down()
    break
  case 'logs':
    logs(rest.includes('--follow') || rest.includes('-f'))
    break
  case 'status':
    status()
    break
  case 'url':
    printUrl(loginUrlFromLogs(5000))
    break
  case 'collect':
    collect()
    break
  case 'help':
  case '--help':
  case '-h':
    usage()
    break
  default:
    usage()
    fail(`unknown command: ${command}`)
}
