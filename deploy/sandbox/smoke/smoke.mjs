import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const LOG_PATH = process.env.DSH_LOG ?? '/dsh-home/dsh.log'
const LOGIN_TIMEOUT_MS = Number(process.env.DSH_LOGIN_TIMEOUT_MS ?? 90000)
const ARTIFACTS_DIR = process.env.DSH_SMOKE_ARTIFACTS ?? '/artifacts'
const PACKAGES = ['@local/sandbox-ui', '@local/sandbox-host', '@local/sandbox-worker']
const rowFor = (name) => name.split('/').at(-1)

function log(...args) {
  console.log('[smoke]', ...args)
}

async function readLog() {
  try {
    return (await readFile(LOG_PATH, 'utf8')).replace(/\x1b\[[0-9;]*m/g, '')
  } catch {
    return ''
  }
}

async function waitForLoginUrl() {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  let lastLog = ''
  while (Date.now() < deadline) {
    lastLog = await readLog()
    const matches = [...lastLog.matchAll(/dsh web:\s+(https?:\/\/\S+?\?token=\S+)/g)]
    if (matches.length > 0) return matches.at(-1)[1]
    await sleep(250)
  }
  throw new Error(
    `no DSH login URL in ${LOG_PATH} within ${LOGIN_TIMEOUT_MS}ms. Last log tail:\n${lastLog.slice(-2000)}`,
  )
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

async function waitForLogOccurrences(needle, minimum, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    text = await readLog()
    if (countOccurrences(text, needle) >= minimum) return
    await sleep(100)
  }
  throw new Error(
    `expected "${needle}" at least ${minimum} times in ${LOG_PATH}; log tail:\n${text.slice(-2000)}`,
  )
}

function clickFirst(page, labels) {
  return page.evaluate((labels) => {
    const elements = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
    for (const element of elements) {
      const aria = (element.getAttribute('aria-label') || '').trim()
      const text = (element.innerText || '').trim()
      if (labels.includes(aria) || labels.includes(text)) {
        element.click()
        return { clicked: true, aria, text }
      }
    }
    return { clicked: false }
  }, labels)
}

async function closeOnboarding(page) {
  return page.evaluate(() => {
    const labels = ['关闭', 'Close']
    const dialogs = [...document.querySelectorAll('[aria-modal="true"], [role="dialog"]')]
    for (const dialog of dialogs) {
      const button = [...dialog.querySelectorAll('button')].find((candidate) => {
        const aria = (candidate.getAttribute('aria-label') || '').trim()
        const text = (candidate.innerText || '').trim()
        return labels.includes(aria) || labels.includes(text)
      })
      if (button) {
        button.click()
        return true
      }
    }
    return false
  })
}

async function waitForOnboarding(page) {
  await page
    .waitForFunction(() => {
      const dialog = document.querySelector('[aria-modal="true"], [role="dialog"]')
      const hasContinue = [...document.querySelectorAll('button')].some((button) =>
        ['继续', 'Continue'].includes((button.innerText || '').trim()),
      )
      return Boolean(dialog || hasContinue)
    }, { timeout: 5000 })
    .catch(() => {})
}

async function dismissIntro(page) {
  await waitForOnboarding(page)
  for (let index = 0; index < 4; index += 1) {
    const clicked = await clickFirst(page, ['继续', 'Continue'])
    if (!clicked.clicked) break
    await sleep(800)
  }
  for (let index = 0; index < 4; index += 1) {
    if (!(await closeOnboarding(page))) break
    await sleep(400)
  }
}

async function openPlugins(page) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await closeOnboarding(page)
    const clicked = await clickFirst(page, ['插件', 'Plugins'])
    if (clicked.clicked) {
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('[data-plugin-package]').length > 0,
          { timeout: 3000 },
        )
        return
      } catch {
        // The click may have hit a closed menu or the page is still rendering.
      }
    }
    await sleep(500)
  }
  throw new Error('could not open the native plugin page')
}

async function waitForCards(page) {
  await page.waitForFunction(
    (names) => {
      const cards = [...document.querySelectorAll('[data-plugin-package]')]
      return names.every((name) =>
        cards.some((card) => card.getAttribute('data-plugin-package') === name),
      )
    },
    { timeout: 30000 },
    PACKAGES,
  )
}

function cardStatuses(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-plugin-package]')].map((card) => [
        card.getAttribute('data-plugin-package'),
        card.getAttribute('data-plugin-status'),
      ]),
    ),
  )
}

async function ensureRunning(page, name) {
  const status = await cardStatuses(page).then((statuses) => statuses[name] ?? null)
  if (status === 'running') return

  const clicked = await page.evaluate((name) => {
    const card = [...document.querySelectorAll('[data-plugin-package]')].find(
      (candidate) => candidate.getAttribute('data-plugin-package') === name,
    )
    const toggle = card?.querySelector('button[role="switch"]')
    if (!toggle) return false
    if (toggle.getAttribute('aria-checked') !== 'true') toggle.click()
    return true
  }, name)

  if (clicked) {
    await page.waitForFunction(
      (name) => {
        const card = [...document.querySelectorAll('[data-plugin-package]')].find(
          (candidate) => candidate.getAttribute('data-plugin-package') === name,
        )
        return card?.getAttribute('data-plugin-status') === 'running'
      },
      { timeout: 30000 },
      name,
    )
    return
  }

  assert.fail(`${name} is ${status} and has no package switch`)
}

async function openPackage(page, name) {
  await waitForCards(page)
  const opened = await page.evaluate((name) => {
    const card = [...document.querySelectorAll('[data-plugin-package]')].find(
      (candidate) => candidate.getAttribute('data-plugin-package') === name,
    )
    const openButton = card?.querySelector('button')
    if (!openButton) return false
    openButton.click()
    return true
  }, name)
  assert.ok(opened, `could not open the detail page for ${name}`)
  await page.waitForFunction(() => document.querySelector('[data-plugin-rows]'), {
    timeout: 15000,
  })
  await sleep(300)
}

function readRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-plugin-rows] [data-plugin-row]')].map((row) => {
      const toggle = row.querySelector('button[role="switch"]')
      return {
        id: row.getAttribute('data-plugin-row'),
        state: row.getAttribute('data-state'),
        checked: toggle?.getAttribute('aria-checked') ?? null,
        text: (row.innerText || '').trim(),
      }
    }),
  )
}

async function backToList(page) {
  const clicked = await page.evaluate(() => {
    const prefixes = ['返回插件', 'Back to plugins', 'Back to Plugins', 'Back to plugin']
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      prefixes.some((prefix) =>
        (candidate.getAttribute('aria-label') || '').startsWith(prefix),
      ),
    )
    if (!button) return false
    button.click()
    return true
  })
  assert.ok(clicked, 'plugin list breadcrumb not found')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-plugin-package]').length > 0,
    { timeout: 15000 },
  )
  await sleep(300)
}

async function assertOneEnabledRow(page, name, rowId) {
  const rows = await readRows(page)
  assert.equal(
    rows.length,
    1,
    `${name} should expose exactly one leaf row, got ${JSON.stringify(rows)}`,
  )
  const [row] = rows
  assert.ok(
    row.id === rowId || row.id?.endsWith(`:${rowId}`),
    `row id ${row.id} should refer to ${rowId}`,
  )
  assert.notEqual(row.state, 'off', `${name} row should be enabled`)
  assert.equal(row.checked, 'true', `${name} row switch should be checked`)
  assert.ok(row.text.includes(name), `${name} row should name its package`)
  return row
}

async function clickRowSwitch(page) {
  const clicked = await page.evaluate(() => {
    const toggle = document.querySelector(
      '[data-plugin-rows] [data-plugin-row] button[role="switch"]',
    )
    if (!toggle) return false
    toggle.click()
    return true
  })
  assert.ok(clicked, 'row switch not found')
}

async function waitForRowState(page, rowId, state) {
  await page.waitForFunction(
    ({ rowId, state }) => {
      const row = [...document.querySelectorAll('[data-plugin-row]')].find((candidate) => {
        const id = candidate.getAttribute('data-plugin-row') || ''
        return id === rowId || id.endsWith(`:${rowId}`)
      })
      if (!row) return false
      if (state === 'on') return row.getAttribute('data-state') !== 'off'
      return row.getAttribute('data-state') === state
    },
    { timeout: 15000 },
    { rowId, state },
  )
  await sleep(300)
}

async function assertWorkerToggle(page) {
  const logBefore = await readLog()
  const activeBefore = countOccurrences(logBefore, '[sandbox-worker] active')
  const inactiveBefore = countOccurrences(logBefore, '[sandbox-worker] inactive')

  await openPackage(page, '@local/sandbox-worker')
  let rows = await readRows(page)
  assert.equal(rows[0]?.checked, 'true', 'worker row should start enabled')

  await clickRowSwitch(page)
  await waitForRowState(page, 'sandbox-worker', 'off')
  await waitForLogOccurrences('[sandbox-worker] inactive', inactiveBefore + 1)
  rows = await readRows(page)
  assert.equal(rows[0]?.state, 'off', 'worker row should be off')
  assert.equal(rows[0]?.checked, 'false', 'worker row switch should be unchecked')
  await backToList(page)

  const offStatuses = await cardStatuses(page)
  assert.equal(offStatuses['@local/sandbox-ui'], 'running', 'the UI package must stay running')
  assert.equal(offStatuses['@local/sandbox-host'], 'running', 'the host package must stay running')
  log('worker off; card statuses', JSON.stringify(offStatuses))

  await openPackage(page, '@local/sandbox-worker')
  rows = await readRows(page)
  assert.equal(rows[0]?.state, 'off', 'worker row should stay off after navigating away')
  await clickRowSwitch(page)
  await waitForRowState(page, 'sandbox-worker', 'on')
  await waitForLogOccurrences('[sandbox-worker] active', activeBefore + 1)
  rows = await readRows(page)
  assert.notEqual(rows[0]?.state, 'off', 'worker row should be back on')
  assert.equal(rows[0]?.checked, 'true', 'worker row switch should be checked again')
  await backToList(page)
  await ensureRunning(page, '@local/sandbox-worker')
  log('worker re-enabled')
}

async function openSandboxPanel(page) {
  let clicked = await clickFirst(page, ['Sandbox'])
  if (!clicked.clicked) {
    await clickFirst(page, ['打开侧边栏', 'Open sidebar'])
    clicked = await clickFirst(page, ['Sandbox'])
  }
  if (!clicked.clicked) {
    const more = await clickFirst(page, ['更多', 'More'])
    assert.ok(more.clicked, 'Sandbox entry and the More button are both missing')
    await sleep(500)
    clicked = await clickFirst(page, ['Sandbox'])
  }
  assert.ok(clicked.clicked, 'Sandbox sidebar entry not found')
  await page.waitForFunction(() => document.querySelector('[data-sandbox-ui="ready"]'), {
    timeout: 15000,
  })
}

async function snapshot(page) {
  try {
    return await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: (document.body?.innerText || '').slice(0, 4000),
      cards: [...document.querySelectorAll('[data-plugin-package]')].map((card) => ({
        name: card.getAttribute('data-plugin-package'),
        status: card.getAttribute('data-plugin-status'),
      })),
      rows: [...document.querySelectorAll('[data-plugin-row]')].map((row) => ({
        id: row.getAttribute('data-plugin-row'),
        state: row.getAttribute('data-state'),
        text: (row.innerText || '').slice(0, 200),
      })),
      dialogs: [...document.querySelectorAll('[aria-modal="true"]')].map((dialog) =>
        (dialog.innerText || '').slice(0, 200),
      ),
    }))
  } catch (error) {
    return { error: String(error) }
  }
}

let browser
let page
try {
  const loginUrl = await waitForLoginUrl()
  log('found login URL')

  browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=zh-CN',
      '--accept-lang=zh-CN,en-US',
    ],
    defaultViewport: { width: 1440, height: 1000 },
  })
  page = await browser.newPage()
  page.setDefaultTimeout(15000)
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('[browser:console]', message.text())
  })
  page.on('pageerror', (error) => console.error('[browser:pageerror]', error.message))

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await dismissIntro(page)
  await openPlugins(page)
  await sleep(800)
  await closeOnboarding(page)
  await waitForCards(page)
  const initialStatuses = await cardStatuses(page)
  for (const name of PACKAGES) {
    assert.equal(
      initialStatuses[name],
      'running',
      `${name} should be running before the smoke changes anything; got ${initialStatuses[name]}`,
    )
  }
  for (const name of PACKAGES) await ensureRunning(page, name)
  log('cards running', JSON.stringify(await cardStatuses(page)))

  for (const name of PACKAGES) {
    await openPackage(page, name)
    const row = await assertOneEnabledRow(page, name, rowFor(name))
    log('row verified', name, row.id, row.state, row.checked)
    if (name !== '@local/sandbox-worker') {
      await clickRowSwitch(page)
      await waitForRowState(page, rowFor(name), 'off')
      const offRows = await readRows(page)
      assert.equal(offRows[0]?.state, 'off', `${name} row should turn off`)
      assert.equal(offRows[0]?.checked, 'false', `${name} row switch should turn off`)
      await clickRowSwitch(page)
      await waitForRowState(page, rowFor(name), 'on')
      const onRows = await readRows(page)
      assert.notEqual(onRows[0]?.state, 'off', `${name} row should turn back on`)
      assert.equal(onRows[0]?.checked, 'true', `${name} row switch should turn back on`)
      log('row toggled off/on', name)
    }
    await backToList(page)
  }

  await assertWorkerToggle(page)
  await waitForCards(page)
  await closeOnboarding(page)
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const pluginsShot = `${ARTIFACTS_DIR}/sandbox-plugins.png`
  await page.screenshot({ path: pluginsShot, fullPage: true })
  log('screenshot:', pluginsShot)

  await openSandboxPanel(page)
  const panelText = await page.evaluate(() => document.body.innerText)
  assert.match(panelText, /Sandbox UI/)
  const uiShot = `${ARTIFACTS_DIR}/sandbox-ui.png`
  await page.screenshot({ path: uiShot, fullPage: true })
  log('screenshot:', uiShot)
  log('PASS')
} catch (error) {
  console.error('[smoke] FAIL:', error.stack || error)
  if (page) {
    console.error('[smoke] snapshot:', JSON.stringify(await snapshot(page), null, 2))
    try {
      await mkdir(ARTIFACTS_DIR, { recursive: true })
      const failureShot = `${ARTIFACTS_DIR}/sandbox-failure.png`
      await page.screenshot({ path: failureShot, fullPage: true })
      console.error('[smoke] failure screenshot:', failureShot)
    } catch (screenshotError) {
      console.error('[smoke] could not write failure screenshot:', screenshotError.message)
    }
  }
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
}