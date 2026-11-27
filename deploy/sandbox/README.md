# T1 local multi-plugin sandbox

This directory is the repeatable local Docker sandbox for the **plugin
management API** work (issue #15). T1 is the acceptance base for T2-T6: a
fixed DSH image with one profile and three independent leaf plugin rows. The
management API does not exist yet, so the sandbox proves the base through the
native **Plugins** page.

## What is in the box

| Fixture | Leaf row id | Halves | What it proves |
| --- | --- | --- | --- |
| `@local/sandbox-ui` | `sandbox-ui` | host + visible web client | A row can contribute a client panel and a sidebar entry. |
| `@local/sandbox-host` | `sandbox-host` | host only | A pure host row loads without a client bundle. |
| `@local/sandbox-worker` | `sandbox-worker` | host only, effect logs | A row can be switched off and on independently; its effect is disposed. |

Every fixture is its own package and its own profile bundle, with exactly one
patch row. That keeps row-level enable/disable equivalent to package-level
enable/disable for this sandbox, so the native page can exercise one row at a
time.

The image fixes:

- `@deepseek-ai/dsh@0.2.2-rc.5`
- pnpm `11.28.5` (profile tooling)
- `node:24-bookworm-slim` by default (`NODE_IMAGE` can override the base);
  the digest used for the local run is recorded below. The tag itself floats.

## Prerequisites

- Docker Desktop or Docker Engine with **Compose v2.20+**, Linux containers,
  x86_64. Docker Desktop 28.3.3 was used for the local run.
- Node.js **20+** on the host for `sandbox.mjs`. The repository does not ship
  a host Node installation; use any installed Node, or the bundled runtime in
  this environment.
- About 4 GB of free disk space for the DSH image, the Chromium smoke image,
  and the named volume.
- Network access for the first build: the base image, the npm registry, and
  Debian packages for Chromium. If Docker Hub is blocked, override the base
  image with a mirror (see below).

### Restricted network

Docker Hub is not reachable from every network. Pull the same Node image from
a mirror and pass it as `NODE_IMAGE`:

```bash
docker pull docker.m.daocloud.io/library/node:24-bookworm-slim
docker tag docker.m.daocloud.io/library/node:24-bookworm-slim node:24-bookworm-slim
NODE_IMAGE=node:24-bookworm-slim node deploy/sandbox/sandbox.mjs up
```

PowerShell:

```powershell
$env:NODE_IMAGE = 'docker.m.daocloud.io/library/node:24-bookworm-slim'
node deploy/sandbox/sandbox.mjs up
```

The tag/digest used locally was
`sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530`.

## Commands

From the repository root:

```bash
# Build, start, wait for health, print a ready-to-open login URL
node deploy/sandbox/sandbox.mjs up

# Run the Chromium smoke test (builds the smoke image on first use)
node deploy/sandbox/sandbox.mjs smoke

# Full clean-room check: destroy, build/start, smoke, collect logs, destroy
# On failure it stops at the failing step and leaves the resources in place,
# with the failure screenshot and logs, so the failure can be diagnosed.
node deploy/sandbox/sandbox.mjs verify

# Inspect
node deploy/sandbox/sandbox.mjs logs
node deploy/sandbox/sandbox.mjs logs --follow
node deploy/sandbox/sandbox.mjs status
node deploy/sandbox/sandbox.mjs collect

# Destroy containers, network, and the test volume
node deploy/sandbox/sandbox.mjs down
```

The raw Compose equivalents are:

```bash
docker compose -f deploy/sandbox/compose.yml up -d --build --wait
docker compose -f deploy/sandbox/compose.yml logs --no-color dsh
docker compose -f deploy/sandbox/compose.yml build smoke
docker compose -f deploy/sandbox/compose.yml run --rm --no-deps smoke
docker compose -f deploy/sandbox/compose.yml down -v --remove-orphans
```

`up` prints a URL like
`http://127.0.0.1:38080/?token=...`. Open it in a browser. The token is a
login credential: it sets an HttpOnly `dsh-auth-*` cookie for 30 days. Do not
share the URL or commit logs containing it.

The first human visit shows the preview/workspace screen. Click **继续**
(Continue), then close the **开始使用** (Get started) dialog. The sidebar
**插件** (Plugins) page then shows the three installed packages.

## What the smoke test asserts

The smoke container shares DSH's network namespace, reads the login URL from
the shared `dsh.log`, and drives Chromium with `puppeteer-core`:

1. DSH answered with a token URL and the web app reached the workspace screen.
2. The native **Plugins** page lists `@local/sandbox-ui`,
   `@local/sandbox-host`, and `@local/sandbox-worker`, each with status
   `running`.
3. Opening each package detail page shows exactly one leaf row, enabled, with
   its switch checked. Every row is then switched off and back on, and each
   transition is checked (`data-state="off"`, `aria-checked="false"`, then
   enabled again). This exercises the UI and host rows independently too.
4. Turning the worker row off also writes `[sandbox-worker] inactive` to the
   DSH log, leaves the UI and host packages running, and the off state persists
   after navigating back and into the page again. Turning it back on restores
   the row and logs another `[sandbox-worker] active`.
5. The client fixture's **Sandbox** sidebar entry opens a panel containing
   `data-sandbox-ui="ready"`, proving the visible client half loaded.

Failures print the current DOM snapshot (cards, rows, dialogs) and the browser
console, and write `sandbox-failure.png`. Successful runs write
`sandbox-plugins.png` and `sandbox-ui.png`; `collect` also writes
`deploy/sandbox/sandbox.log`. All artifacts go through the smoke container's
bind mount.

## Isolation and lifecycle

All resources are explicitly named and project-scoped:

| Resource | Name |
| --- | --- |
| Compose project | `dsh-sandbox` |
| Container | `dsh-sandbox-dsh` |
| Network | `dsh-sandbox-net` |
| Volume | `dsh-sandbox-dsh-home` |
| Host port | `127.0.0.1:${SANDBOX_PORT:-38080}` |
| Image | `dsh-sandbox:0.2.2-rc.5` |
| Smoke image | `dsh-sandbox-smoke:0.2.2-rc.5` |

The DSH container is read-only apart from `/tmp` and the named volume. It
drops all capabilities except the five needed to initialize the volume and
drop privileges (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`),
and runs DSH as uid/gid 1000. Only a loopback host port is published; there is
no Caddy, TLS, or public ingress in T1.

The entrypoint seeds `/data/dsh-home` from the image profile once. On a later
image with a different seed fingerprint, it backs up the old profile, copies
the new seed, restores the old `cordis.patch.yml`, and keeps the three newest
backups. This is the sandbox-sized version of the seed lifecycle; the full
production behavior is T4 (#19).

`down` runs `docker compose down -v --remove-orphans`. It removes only this
project's container, network, and named volume. It never runs `docker system
prune`, image prune, or volume prune. `verify` intentionally does not call
`down` after a failure: the container, network, and volume stay in place for
diagnosis, and the operator runs `down` when finished.

## Native page details used by the test

- Package cards: `[data-plugin-package="<package name>"]` with
  `data-plugin-status="running|disabled|not-running|problem"`.
- Package detail rows: `[data-plugin-rows] [data-plugin-row="include:<row id>"]`.
  A disabled row has `data-state="off"`; its switch has
  `aria-checked="false"`.
- The detail breadcrumb is a button whose `aria-label` starts with
  `返回插件` (or `Back to plugins`); the sidebar **Plugins** button does not
  return to the list.

## Deviations from the production spec (§5)

This is a local T1 sandbox, not the production deployment. The differences
are deliberate and documented here so they are not mistaken for the final
image contract:

- The seed fingerprint hashes the installed profile **and** `/opt/plugins`;
  it does not take a `BUILD_REVISION` argument. Rebuilding the image with new
  fixture bytes changes the fingerprint and refreshes the volume.
- `npm install -g --allow-scripts=...` bulk-approves the four native helper
  packages. The smoke starts DSH and exercises plugin rows, but does not yet
  smoke-test terminal/subprocess/PTY behavior; that is T6 work.
- The base image is a moving tag by default; the digest used for the local run
  is recorded above. A production build should pin it in a versions lock.

## Known limitations

- **DSH is pinned to 0.2.2-rc.5.** This is deliberate for T1 reproducibility.
- **No management API, no admin token, no Caddy/TLS.** T2-T6 add those. This
  sandbox only exercises the existing native plugin page.
- **Onboarding is manual for humans.** The smoke dismisses the preview and
  get-started dialogs; a human must do the same on first visit.
- **The seed refresh is sandbox-sized.** It keeps the patch layer and three
  backups, but it does not attempt the full production seed contract.
- **pnpm/corepack remain in the runtime image.** T1 favors a simple, working
  image over the production runtime-install constraint. The production image
  is specified in `docs/specs/v1-intranet-server.md` §5.
- **Chromium smoke image is large** and the first build downloads Debian
  packages. It is not part of the production deployment.
- **No GPU and no sound** are expected; the smoke uses headless Chromium with
  `--no-sandbox` inside a disposable container.
- **Port 38080 may be busy.** Set `SANDBOX_PORT` to another loopback port;
  update the printed URL accordingly (the CLI does this automatically).
- **The token URL is sensitive.** Logs and `collect` output contain it.

## Acceptance checklist

| T1 acceptance criterion | Where satisfied |
| --- | --- |
| One command builds and starts from a clean state | `sandbox.mjs up` / `verify` |
| One command destroys containers, network, and test volume | `sandbox.mjs down` |
| Independent resource names; no production or unknown containers touched | explicit project/container/network/volume names; `down` is project-scoped |
| Profile has at least 3 leaf rows: >=1 visible client UI, >=1 host-only | three fixture packages, one row each; UI client panel + two host-only |
| Native plugin page shows the rows and enabled state | smoke steps 2-3 |
| Smoke is repeatable and gives useful failure diagnostics | `verify`; DOM snapshot, console, screenshots |
| Docs cover prerequisites, start/stop commands, known limits | this README |
