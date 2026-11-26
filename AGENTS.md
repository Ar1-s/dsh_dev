# AGENTS.md

## Agent skills

### Issue tracker

GitHub Issues in `Ar1-s/dsh_dev`, operated through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, each label string equal to its role name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

single-context: one root `GLOSSARY.md` and `docs/adr/`, shared by the whole repo. See `docs/agents/domain.md`.

## Testing and release

- **Local Docker first.** Container builds, plugin install/enable/disable, Caddy/login, and file-bridge protocol tests run on the local Docker (Linux containers, x86_64) before anything is promoted to the production test host.
- **Production is only for integration after local green.** Use an isolated directory, network, container name, and a loopback high port; never touch unknown containers, services, or ports; remove test resources when done.
- **Plugin table changes are global.** Enabling/disabling a plugin row or bundle affects every client using the profile. Only the affected plugin (and its service dependents) reloads; sessions and other plugins keep running, but the affected UI unmounts and local component state is lost. Prefer a maintenance window for bundle install/remove, image upgrades, core/management plugins, or when a session is actively using the affected plugin.
- **Runtime install/remove is not part of the current v1.** It needs pnpm inside the runtime image and a profile that is the source of truth. Enabling/disabling existing plugins needs neither.
- **Never run bulk Docker cleanup on production** (`docker system prune`, image prune, volume prune). Remove only explicitly named test resources.
