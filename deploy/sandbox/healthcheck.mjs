import os from 'node:os'

const ip = Object.values(os.networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address

if (!ip) process.exit(1)

try {
  const response = await fetch(`http://${ip}:3080/`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(2500),
  })
  process.exit([200, 303, 401, 403].includes(response.status) ? 0 : 1)
} catch {
  process.exit(1)
}
