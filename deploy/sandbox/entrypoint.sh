#!/bin/bash
set -euo pipefail

SEED_DIR=/opt/dsh-seed
DSH_HOME=${DSH_HOME:-/data/dsh-home}
PROFILE=web
RUN_UID=1000
RUN_GID=1000
LOG="$DSH_HOME/dsh.log"

log() {
  printf '[dsh-sandbox] %s\n' "$*"
}

fail() {
  printf '[dsh-sandbox] ERROR: %s\n' "$*" >&2
  exit 1
}

[ -f "$SEED_DIR/.seed-id" ] || fail "seed fingerprint missing at $SEED_DIR/.seed-id"

install -d -o "$RUN_UID" -g "$RUN_GID" -m 0750 "$DSH_HOME"
install -d -o "$RUN_UID" -g "$RUN_GID" -m 0750 "$DSH_HOME/profiles"

seed_id=$(cat "$SEED_DIR/.seed-id")
current_id=""
if [ -f "$DSH_HOME/.seed-id" ]; then
  current_id=$(cat "$DSH_HOME/.seed-id")
fi

if [ ! -f "$DSH_HOME/profiles/$PROFILE/package.json" ]; then
  log "initializing DSH_HOME from image seed"
  cp -a "$SEED_DIR/profiles/." "$DSH_HOME/profiles/"
elif [ "$current_id" != "$seed_id" ]; then
  log "seed changed ($current_id -> $seed_id); refreshing profile"
  backup="$DSH_HOME/profiles/$PROFILE.bak-$(date +%Y%m%d%H%M%S)"
  saved_patch=""
  if [ -f "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml" ]; then
    saved_patch="$DSH_HOME/cordis.patch.yml.keep"
    cp "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml" "$saved_patch"
  fi
  mv "$DSH_HOME/profiles/$PROFILE" "$backup"
  log "backup: $backup"
  cp -a "$SEED_DIR/profiles/." "$DSH_HOME/profiles/"
  if [ -n "$saved_patch" ]; then
    cp "$saved_patch" "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
    rm -f "$saved_patch"
    log "preserved the existing cordis.patch.yml"
  fi
  find "$DSH_HOME/profiles" -maxdepth 1 -type d -name "$PROFILE.bak-*" -printf '%T@ %p\n' \
    | sort -nr | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
else
  log "profile seed is up to date"
fi
echo "$seed_id" > "$DSH_HOME/.seed-id"

# The seed is root-owned; DSH runs as 1000.
chown -R "$RUN_UID:$RUN_GID" "$DSH_HOME"

# One fresh log per sandbox run. The smoke container reads this file from the
# shared named volume to discover the one-time login URL.
: > "$LOG"
chmod 0644 "$LOG"

dump=/tmp/dsh-sandbox-dump.yml
dump_err=/tmp/dsh-sandbox-dump.err
log "validating the profile with --dump-config"
if ! setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups \
  env HOME="$DSH_HOME" DSH_HOME="$DSH_HOME" TMPDIR=/tmp \
  dsh --profile "$PROFILE" --dump-config > "$dump" 2> "$dump_err"; then
  cat "$dump_err" >&2 || true
  fail "--dump-config failed"
fi
if grep -Eqi 'skipping|did not activate|startup failed' "$dump_err"; then
  cat "$dump_err" >&2
  fail "profile validation reported a plugin failure"
fi
for row in sandbox-ui sandbox-host sandbox-worker; do
  grep -q -- "- id: $row" "$dump" || fail "plugin row $row is missing from the dumped config"
done
log "three sandbox fixture rows are present in the profile"

BIND_IP=$(hostname -i | awk '{print $1}')
[ -n "$BIND_IP" ] || fail "could not resolve a container IPv4 address"

log "starting DSH on $BIND_IP:3080 (profile $PROFILE)"
# Keep DSH as PID 1 so docker stop reaches it directly. The startup URL is
# teed into the shared volume for the smoke container; truncating above means
# only the latest run's URL is visible.
exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups \
  env HOME="$DSH_HOME" DSH_HOME="$DSH_HOME" TMPDIR=/tmp \
  dsh --profile "$PROFILE" --host "$BIND_IP" --port 3080 --no-open \
  > >(tee -a "$LOG") 2>&1
