#!/usr/bin/env bash
# Container tests for docker/entrypoint.sh against the fixture image (ADR-0004, ADR-0008).
#
#   test/entrypoint/run.sh <image>      e.g. selfhost-kit-entrypoint:test (see test/entrypoint/Dockerfile)
#
# What needs a real container: the root path (chown, gosu), UMASK, `docker run --user`, and real
# Litestream (replicate, graceful stop, restore, failing loudly). The entrypoint's other shell logic is
# covered on the host by test/docker/entrypoint.test.ts. The replica is a file:// URL on a temp bind
# mount, so no bucket or network is needed. Waits poll a condition with a bound; no check is timed.
set -euo pipefail

IMAGE="${1:?usage: test/entrypoint/run.sh <image>}"
PUID=1234
PGID=2345
NAME="selfhost-kit-entrypoint-$$"
URL="file:///replica"
FAILURES=0

ROOT_DATA="$(mktemp -d)"
UMASK_DATA="$(mktemp -d)"
USER_DATA="$(mktemp -d)"
ARGS_DATA="$(mktemp -d)"
FIRST_DATA="$(mktemp -d)"
SECOND_DATA="$(mktemp -d)"
BROKEN_DATA="$(mktemp -d)"
DENIED_DATA="$(mktemp -d)"
REDACT_DATA="$(mktemp -d)"
REPLICA_MAIN="$(mktemp -d)"
REPLICA_ARGS="$(mktemp -d)"
UNREADABLE="$(mktemp -d)" # mode 0700, owned by the runner: PUID can't use it
ALL_DIRS=("$ROOT_DATA" "$UMASK_DATA" "$USER_DATA" "$ARGS_DATA" "$FIRST_DATA" "$SECOND_DATA" "$BROKEN_DATA"
  "$DENIED_DATA" "$REDACT_DATA" "$REPLICA_MAIN" "$REPLICA_ARGS" "$UNREADABLE")
REPLICA="$REPLICA_MAIN"

as_root() { # as_root <dir> <shell script>: runs the script on <dir> mounted at /x, as root
  docker run --rm -v "$1:/x" --entrypoint sh "$IMAGE" -c "$2"
}

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Files are owned by PUID or root; remove them from inside a container.
  for d in "${ALL_DIRS[@]}"; do
    as_root "$d" "rm -rf /x/* /x/.[!.]*; chown $(id -u):$(id -g) /x" >/dev/null 2>&1 || true
    rmdir "$d" 2>/dev/null || true
  done
}
trap cleanup EXIT

pass() { echo "  ok   $*"; }
fail() {
  echo "  FAIL $*"
  FAILURES=$((FAILURES + 1))
}
check() {
  local what="$1"
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}

in_container() { docker exec "$NAME" "$@"; }
logs() { docker logs "$NAME" 2>&1; }
entrypoint_lines() { logs | grep '^\[entrypoint\]' || true; }

healthy() {
  docker exec "$NAME" node -e \
    "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1
}

wait_healthy() {
  for _ in $(seq 1 60); do
    healthy && return 0
    sleep 1
  done
  echo "container never became healthy:"
  logs
  return 1
}

# Litestream initializes a database created after it started on its first 1 s sync tick; a write made
# and stopped before then isn't replicated. Wait (bounded) for that first snapshot before writing.
wait_replicated() {
  for _ in $(seq 1 30); do
    [ -n "$(as_root "$1" 'ls -A /x')" ] && return 0
    sleep 1
  done
  return 1
}

wait_exited() {
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && return 0
    sleep 1
  done
  return 1
}

# start <data dir> [docker run options…] [-- command…]
start() {
  local data="$1"
  shift
  local opts=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    opts+=("$1")
    shift
  done
  [ "${1:-}" = "--" ] && shift
  docker run -d --name "$NAME" -v "$data:/data" -v "$REPLICA:/replica" "${opts[@]}" "$IMAGE" "$@" >/dev/null
  wait_healthy
}

# run_to_exit <data dir> [docker run options…]: for containers that must stop on their own.
run_to_exit() {
  local data="$1"
  shift
  docker run -d --name "$NAME" -v "$data:/data" -v "$REPLICA:/replica" "$@" "$IMAGE" >/dev/null
  wait_exited || true # the checks below report a container that is still running
}

stop_and_remove() {
  docker stop "$NAME" >/dev/null
  docker rm "$NAME" >/dev/null
}

exit_code() { docker inspect -f '{{.State.ExitCode}}' "$NAME"; }

# Owner (uid:gid) of the first process whose executable (argv[0] basename) is $1.
# Not /proc/<pid>/comm: Node 24 renames its main thread "MainThread".
process_owner() {
  # shellcheck disable=SC2016 # the script expands inside the container, not here
  in_container sh -c 'for p in $(ls /proc | grep -E "^[0-9]+$" | sort -n); do
    exe=$(tr "\0" "\n" < /proc/$p/cmdline 2>/dev/null | head -n 1)
    [ "${exe##*/}" = "'"$1"'" ] && { stat -c "%u:%g" /proc/$p; break; }; done'
}

get() { # get <path>: prints the body; exit 0 on 2xx
  in_container node -e "fetch('http://127.0.0.1:3000$1').then(async r=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)},()=>process.exit(1))"
}

post_row() {
  in_container node -e "fetch('http://127.0.0.1:3000/rows',{method:'POST',body:process.argv[1]}).then(r=>process.exit(r.status===201?0:1),()=>process.exit(1))" "$1"
}

mode_of() { in_container stat -c '%a' "$1"; }
owner_of() { in_container stat -c '%u:%g' "$1"; }
wrong_owner() { in_container find /data \( ! -user "$PUID" -o ! -group "$PGID" \); }

# Like an Unraid share: the replica directories belong to PUID:PGID. The entrypoint never chowns a replica.
as_root "$REPLICA_MAIN" "chown $PUID:$PGID /x"
as_root "$REPLICA_ARGS" "chown $PUID:$PGID /x"

echo "started as root: ownership and privilege drop"
as_root "$ROOT_DATA" 'mkdir -p /x/old && touch /x/old/file && chown -R 0:0 /x/old'
start "$ROOT_DATA" -e PUID=$PUID -e PGID=$PGID
check "everything under /data is owned by PUID:PGID, the root-owned file included" test -z "$(wrong_owner)"
check "secrets/fixture-secret is mode 600" test "$(mode_of /data/secrets/fixture-secret)" = 600
check "node runs as PUID:PGID, not root" test "$(process_owner node)" = "$PUID:$PGID"
check "the default UMASK 022 gives files mode 644" test "$(mode_of /data/umask-probe)" = 644
check "without LITESTREAM_REPLICA_URL there is no litestream process" test -z "$(process_owner litestream)"
check "and the log says nothing about litestream" bash -c "! docker logs '$NAME' 2>&1 | grep -qi litestream"
docker stop "$NAME" >/dev/null
check "a graceful stop exits cleanly (not SIGKILL)" test "$(exit_code)" != 137
docker rm "$NAME" >/dev/null
start "$ROOT_DATA" -e PUID=$PUID -e PGID=$PGID
check "a restart on the same /data keeps everything owned by PUID:PGID" test -z "$(wrong_owner)"
stop_and_remove

echo "UMASK=027"
start "$UMASK_DATA" -e PUID=$PUID -e PGID=$PGID -e UMASK=027
check "files are created mode 640" test "$(mode_of /data/umask-probe)" = 640
stop_and_remove

echo "started as a non-root user (docker run --user)"
as_root "$USER_DATA" "chown $PUID:$PGID /x && touch /x/root-file && chown 0:0 /x/root-file"
start "$USER_DATA" --user "$PUID:$PGID"
check "node runs as that user" test "$(process_owner node)" = "$PUID:$PGID"
check "nothing is chowned" test "$(owner_of /data/root-file)" = "0:0"
stop_and_remove

echo "arguments reach the command exactly"
start "$ARGS_DATA" -e PUID=$PUID -e PGID=$PGID -- node /app/server.mjs "two words" "it's"
check "without Litestream" test "$(get /argv)" = '["two words","it'"'"'s"]'
stop_and_remove
REPLICA="$REPLICA_ARGS"
start "$ARGS_DATA" -e PUID=$PUID -e PGID=$PGID -e LITESTREAM_REPLICA_URL="$URL" -- node /app/server.mjs "two words" "it's"
check "under litestream replicate -exec" test "$(get /argv)" = '["two words","it'"'"'s"]'
stop_and_remove
REPLICA="$REPLICA_MAIN"

echo "refuses a non-numeric PUID"
run_to_exit "$BROKEN_DATA" -e PUID=abc
check "the container exits on its own" test "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false
check "with status 1" test "$(exit_code)" = 1
check "the log says why" grep -qF '[entrypoint] PUID and PGID must be numeric (got PUID=abc PGID=100)' <(logs)
docker rm "$NAME" >/dev/null

echo "Litestream: first boot with an empty replica"
start "$FIRST_DATA" -e PUID=$PUID -e PGID=$PGID -e LITESTREAM_REPLICA_URL="$URL"
check "the log names the replica target" grep -qxF "[entrypoint] litestream: replicating /data/app.db to $URL" <(logs)
check "an empty replica means a normal first run" \
  grep -qxF "[entrypoint] litestream: no replica found, starting with an empty database" <(logs)
check "litestream runs as PUID:PGID" test "$(process_owner litestream)" = "$PUID:$PGID"
check "node runs as PUID:PGID" test "$(process_owner node)" = "$PUID:$PGID"
check "litestream takes its first snapshot" wait_replicated "$REPLICA_MAIN"
check "a row is written" post_row "hello replica"
# Stop right after the write: the final sync on shutdown must carry it.
docker stop "$NAME" >/dev/null
check "a graceful stop exits cleanly (not SIGKILL)" test "$(exit_code)" != 137
docker rm "$NAME" >/dev/null
SECRET="$(as_root "$FIRST_DATA" 'cat /x/secrets/fixture-secret')"
check "the secret is a real value" test -n "$SECRET"
check "no secret bytes in the replica" bash -c "! docker run --rm -v '$REPLICA_MAIN:/x' --entrypoint grep '$IMAGE' -rqF '$SECRET' /x"

echo "Litestream: a new box (empty /data, same replica)"
start "$SECOND_DATA" -e PUID=$PUID -e PGID=$PGID -e LITESTREAM_REPLICA_URL="$URL"
check "restored from the replica before starting" \
  grep -qxF "[entrypoint] litestream: restored /data/app.db from replica" <(logs)
check "the row came back" test "$(get /rows)" = '["hello replica"]'
stop_and_remove

echo "Litestream: restart with an existing database"
start "$SECOND_DATA" -e PUID=$PUID -e PGID=$PGID -e LITESTREAM_REPLICA_URL="$URL"
check "does not restore over an existing database" bash -c "! docker logs '$NAME' 2>&1 | grep -q restored"
stop_and_remove

echo "Litestream: a broken replica URL"
run_to_exit "$SECOND_DATA" -e PUID=$PUID -e PGID=$PGID -e LITESTREAM_REPLICA_URL=bogus://nowhere
check "the container exits on its own" test "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false
check "with a non-zero status" test "$(exit_code)" != 0
check "litestream's error is in the log" grep -q 'unknown replica type' <(logs)
docker rm "$NAME" >/dev/null

# With an empty /data the startup restore hits the permission error and stops the container.
echo "Litestream: empty /data and a replica directory PUID:PGID cannot read"
REPLICA="$UNREADABLE"
run_to_exit "$DENIED_DATA" -e PUID=$PUID -e PGID=$PGID -e LITESTREAM_REPLICA_URL="$URL"
check "the container exits on its own" test "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false
check "with a non-zero status" test "$(exit_code)" != 0
check "the permission error is in the log" grep -q 'permission denied' <(logs)
docker rm "$NAME" >/dev/null
REPLICA="$REPLICA_MAIN"

echo "Litestream: credentials in the replica URL are never logged by the entrypoint"
run_to_exit "$REDACT_DATA" -e PUID=$PUID -e PGID=$PGID \
  -e LITESTREAM_REPLICA_URL='s3://user:hunter2@bucket.invalid/db?endpoint=http://127.0.0.1:9'
check "the container exits on its own" test "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false
check "with a non-zero status" test "$(exit_code)" != 0
check "the entrypoint names the redacted target" \
  grep -qxF '[entrypoint] litestream: replicating /data/app.db to s3://bucket.invalid/db' <(entrypoint_lines)
check "no entrypoint line holds the password or the query" \
  bash -c "! grep -qE 'hunter2|user:|endpoint' <<<\"\$1\"" _ "$(entrypoint_lines)"
docker rm "$NAME" >/dev/null

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "all checks passed"
