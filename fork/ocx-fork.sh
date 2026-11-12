#!/usr/bin/env bash
# Moves the fork branch onto upstream releases and installs it over the npm package. Usage: README.md here.
set -euo pipefail

FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$FORK_DIR" rev-parse --show-toplevel)"
BRANCH="berish"
UPSTREAM="upstream"
# Local, untracked state: pinned test Bun builds and the diff currently applied to the package.
STATE="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/ocx-fork"
INSTALLED="$STATE/installed.patch"
PKG="@bitkyc08/opencodex"
die() { echo "ocx-fork: $*" >&2; exit 1; }
log() { echo "==> $*"; }
g() { git -C "$REPO" "$@"; }

# Locate the package through the installed launcher, then put ITS Node toolchain first on PATH.
# Another node/npm earlier on PATH (e.g. ~/.local/bin) has a different global prefix, and
# `ocx update` runs a bare `npm`, which would install the new release there instead.
OCX_BIN="$(command -v opencodex)" || die "opencodex is not on PATH"
PKG_DIR="$(cd "$(dirname "$(readlink -f "$OCX_BIN")")/.." && pwd)"
export PATH="$(dirname "$OCX_BIN"):$PATH"
[[ "$(npm root -g)/$PKG" -ef "$PKG_DIR" ]] || die "npm on $(dirname "$OCX_BIN") does not own $PKG_DIR"
# Run on top of every fork revision; the fork's own tests come from its diff.
GUARD_TESTS="tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/structure-ssot.test.ts"
# The menu-bar app ships its own compiled, unpatched ocx and starts it whenever port 10100 is free.
APP="/Applications/OpenCodex.app"
APP_WAS_RUNNING=0
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"

installed_version() { node -p "require('$PKG_DIR/package.json').version"; }
latest_version() { npm view "$PKG" dist-tags.latest; }

# The stable upstream release under the branch; preview tags (v2.99.0-preview.*) never serve as a base.
base_version() {
  local tag
  tag="$(g describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' "$BRANCH" 2>/dev/null)" \
    || die "no upstream release tag under $BRANCH; run: git -C $REPO fetch $UPSTREAM tag v<version>"
  echo "${tag#v}"
}

# The src overlay is only valid on the commit npm published, so the tag must be that commit.
fetch_release() { # <version>
  local ver="$1" sha attempt
  sha="$(npm view "$PKG@$ver" gitHead)"
  [[ -n "$sha" ]] || die "npm has no gitHead for $PKG@$ver"
  for attempt in 1 2 3; do
    g rev-parse -q --verify "refs/tags/v$ver" >/dev/null && break
    g fetch -q --no-tags "$UPSTREAM" "refs/tags/v$ver:refs/tags/v$ver" || log "fetch attempt $attempt failed"
  done
  g rev-parse -q --verify "refs/tags/v$ver" >/dev/null || die "could not fetch tag v$ver from $UPSTREAM"
  [[ "$(g rev-parse "v$ver^{commit}")" == "$sha" ]] || die "tag v$ver is not $sha, the commit npm $PKG@$ver was built from"
}

# Tag that marks the branch tip as verified by finalize; install takes nothing else.
head_tag() { g tag --points-at "$BRANCH" --list 'berish-v*' | head -1; }

# shortcut: only src/ reaches the package (the npm tarball ships gui/dist prebuilt), so a fork change
# outside src/ is not installed; pack our own tarball once the fork needs one.
fork_patch() { # <file>
  g diff --binary "v$(base_version)" "$BRANCH" -- src >"$1"
}

# The package sits inside ~/.nvm, which is a git repo; the ceiling stops git from resolving patch
# paths against that repo's root.
pkg_apply() { # <patch> [git apply flags...]
  local p="$1"; shift
  (cd "$PKG_DIR" && GIT_CEILING_DIRECTORIES="$(dirname "$PKG_DIR")" git apply --include='src/*' "$@" "$p")
}

pkg_state() { # <fork patch>
  if pkg_apply "$1" -R --check 2>/dev/null; then echo "applied"
  elif [[ -f "$INSTALLED" ]] && pkg_apply "$INSTALLED" -R --check 2>/dev/null; then echo "another revision applied"
  elif pkg_apply "$1" --check 2>/dev/null; then echo "stock, fork not applied"
  else echo "unknown: the fork does not apply to this package"; fi
}

rebase_in_progress() {
  [[ -d "$(g rev-parse --path-format=absolute --git-path rebase-merge)" \
    || -d "$(g rev-parse --path-format=absolute --git-path rebase-apply)" ]]
}

require_clean_branch() {
  if rebase_in_progress; then die "a rebase is in progress in $REPO; finish it with git rebase --continue"; fi
  [[ "$(g symbolic-ref --short -q HEAD)" == "$BRANCH" ]] || die "check out $BRANCH in $REPO"
  { g diff --quiet && g diff --cached --quiet; } || die "commit or stash the changes in $REPO first"
}

ocx() { node "$PKG_DIR/bin/ocx.mjs" "$@"; }

app_running() { pgrep -f "^$APP/Contents/MacOS/opencodex-desktop" >/dev/null; }

bundled_running() { pgrep -f "^$APP/Contents/MacOS/ocx" >/dev/null; }

# Quit the app before the proxy goes down, or it takes the free port with its own ocx.
# Quitting can leave the app's bundled ocx serving; that one is stopped like any proxy.
quit_app() {
  if app_running; then
    APP_WAS_RUNNING=1
    log "quitting OpenCodex.app while the proxy restarts"
    osascript -e 'quit app "OpenCodex"' >/dev/null
    for _ in $(seq 1 45); do app_running || break; sleep 1; done
    app_running && die "OpenCodex.app did not quit; quit it from the menu bar and rerun"
  fi
  bundled_running || return 0
  log "stopping the app's bundled ocx"
  ocx stop
  for _ in $(seq 1 30); do bundled_running || return 0; sleep 1; done
  die "the app's bundled ocx is still running; stop it and rerun"
}

# --autostart starts the app hidden in the menu bar; it attaches to the running proxy.
reopen_app() {
  [[ "$APP_WAS_RUNNING" == 1 ]] || return 0
  log "reopening OpenCodex.app"
  open -g -a "$APP" --args --autostart
}

# Command line of the process that serves the proxy port, empty when nothing does.
serving_cmd() {
  local pid
  pid="$(ocx resolve --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).liveness.pid??"")}catch{}})')"
  [[ -n "$pid" ]] && ps -o command= -p "$pid"
  return 0
}

check_serving() {
  local cmd; cmd="$(serving_cmd)"
  [[ "$cmd" == *"$PKG_DIR"* ]] || die "the proxy is served by '${cmd:-nothing}', expected $PKG_DIR; run: $0 serve"
}

# Root-table `model = ...` line of the Codex config, empty when absent.
root_model() { awk '/^\[/ {exit} /^model[[:space:]]*=/ {print; exit}' "$CODEX_CONFIG" 2>/dev/null || true; }

# `ocx update` stops the proxy, which restores native Codex config and drops a routed default model;
# its restart re-injects only the routing keys. Put the saved line back next to model_catalog_json.
restore_root_model() { # <saved line>
  [[ -n "$1" && -z "$(root_model)" ]] || return 0
  local tmp; tmp="$(mktemp)"
  if awk -v line="$1" '!done && /^model_catalog_json[[:space:]]*=/ {print; print line; done=1; next} {print} END {exit !done}' \
    "$CODEX_CONFIG" >"$tmp"; then
    cat "$tmp" >"$CODEX_CONFIG" # rewrite in place: keeps the file's 0600 mode
    log "restored Codex default $1"
  else
    log "WARNING: could not restore Codex default $1 in $CODEX_CONFIG; add it by hand"
  fi
  rm -f "$tmp"
}

bun_bin() {
  if [[ -n "${OCX_BUN:-}" ]]; then echo "$OCX_BUN"; return; fi
  if command -v bun >/dev/null 2>&1; then command -v bun; return; fi
  [[ -x "$PKG_DIR/node_modules/bun/bin/bun.exe" ]] || die "bun not found; set OCX_BUN"
  echo "$PKG_DIR/node_modules/bun/bin/bun.exe"
}

cmd_verify() { # <version>
  local ver="$1" bun tests pin
  bun="$(bun_bin)"
  tests="$(g diff --name-only "v$ver" "$BRANCH" -- 'tests/*.test.ts' | tr '\n' ' ')"
  # scripts/test.ts refuses any Bun but package.json#testRunnerBun; keep that exact version here.
  pin="$(node -p "require('$REPO/package.json').testRunnerBun || ''")"
  if [[ -n "$pin" ]]; then
    export OCX_TEST_RUNNER_BUN="$STATE/bun-$pin/bun"
    if [[ ! -x "$OCX_TEST_RUNNER_BUN" ]]; then
      mkdir -p "$STATE/bun-$pin"
      if [[ "$("$bun" --version)" == "$pin" ]]; then
        cp "$bun" "$OCX_TEST_RUNNER_BUN"
      else
        npm install --silent --prefix "$STATE/bun-$pin/npm" "bun@$pin"
        cp "$STATE/bun-$pin/npm/node_modules/bun/bin/bun.exe" "$OCX_TEST_RUNNER_BUN"
      fi
    fi
  fi
  (
    cd "$REPO"
    "$bun" install --frozen-lockfile
    # scripts/test.ts spawns a bare `bun`; the repo's own devDependency provides it.
    export PATH="$REPO/node_modules/.bin:$PATH"
    log "typecheck"
    "$bun" x tsc --noEmit
    log "tests: $tests$GUARD_TESTS"
    # shellcheck disable=SC2086 # paths never contain spaces
    "$bun" scripts/test.ts $tests $GUARD_TESTS
  )
}

# Verifies the branch on its release and tags the tip berish-v<version>[-r<n>].
cmd_finalize() {
  local ver="${1:?usage: finalize <version>}" files tag n=2
  require_clean_branch
  [[ "$(base_version)" == "$ver" ]] || die "$BRANCH sits on v$(base_version), not v$ver"
  fetch_release "$ver"
  tag="$(head_tag)"
  if [[ -n "$tag" ]]; then
    log "$BRANCH is already finalized as $tag"
    return
  fi
  files="$(g diff --name-only "v$ver" "$BRANCH")"
  # Only the fork's files: upstream devlogs quote conflict markers on purpose.
  # shellcheck disable=SC2086 # paths never contain spaces
  if [[ -n "$files" ]] && g grep -nE '^(<<<<<<<|>>>>>>>)( |$)' "$BRANCH" -- $files; then
    die "conflict markers remain in $BRANCH"
  fi
  cmd_verify "$ver"
  tag="berish-v$ver"
  while g rev-parse -q --verify "refs/tags/$tag" >/dev/null; do tag="berish-v$ver-r$n"; n=$((n + 1)); done
  g tag "$tag" "$BRANCH"
  log "tagged $tag; publish with: git -C $REPO push --force-with-lease origin $BRANCH $tag"
}

# Rebases the branch onto the release, then finalizes; a conflict stops before anything is installed.
cmd_prepare() {
  local ver="${1:-$(latest_version)}" base
  require_clean_branch
  base="$(base_version)"
  fetch_release "$ver"
  if [[ "$ver" != "$base" ]]; then
    log "rebasing $BRANCH from v$base onto v$ver"
    g rebase --onto "v$ver" "v$base" "$BRANCH" \
      || die "conflicts in $REPO; resolve them (fork/AGENTS.md), git rebase --continue, then: $0 finalize $ver"
  fi
  cmd_finalize "$ver"
}

# Through the launchd service, so launchd keeps the npm proxy alive after this script ends.
restart_proxy() {
  quit_app
  log "restarting the proxy service"
  ocx service restart
  for _ in $(seq 1 20); do
    if ocx health >/dev/null 2>&1; then
      log "proxy healthy"
      check_serving
      reopen_app
      return
    fi
    sleep 2
  done
  die "proxy is not healthy; check ~/.opencodex/service.log, roll back with: $0 revert"
}

cmd_install() {
  local inst base tag cur
  inst="$(installed_version)"
  base="$(base_version)"
  [[ "$inst" == "$base" ]] || die "installed $inst, $BRANCH sits on v$base; run: $0 prepare $inst"
  tag="$(head_tag)"
  [[ -n "$tag" ]] || die "the $BRANCH tip is not finalized; run: $0 finalize $base"
  mkdir -p "$STATE"
  cur="$STATE/candidate.patch"
  fork_patch "$cur"
  if pkg_apply "$cur" -R --check 2>/dev/null; then
    cp "$cur" "$INSTALLED"
    log "$tag is already applied to $inst"
    check_serving
    return
  fi
  # Same release with an older fork revision: swap it out first, and put it back if the new one does not fit.
  if [[ -f "$INSTALLED" ]] && pkg_apply "$INSTALLED" -R --check 2>/dev/null; then
    log "reverting the previously installed fork revision"
    pkg_apply "$INSTALLED" -R
    if ! pkg_apply "$cur" --check; then
      pkg_apply "$INSTALLED"
      die "$tag does not apply to $PKG_DIR; the previous revision stays installed"
    fi
  fi
  pkg_apply "$cur" --check || die "$tag does not apply to $PKG_DIR"
  pkg_apply "$cur"
  cp "$cur" "$INSTALLED"
  log "$tag applied to $PKG $inst"
  restart_proxy
}

cmd_revert() {
  { [[ -f "$INSTALLED" ]] && pkg_apply "$INSTALLED" -R --check 2>/dev/null; } \
    || die "no installed fork revision on $PKG_DIR"
  pkg_apply "$INSTALLED" -R
  log "fork removed; the package is stock $(installed_version)"
  restart_proxy
}

# Rebase + verify first; the installed package is replaced only after the branch is finalized.
cmd_update() {
  local latest inst model backup rc=0
  latest="$(latest_version)"
  inst="$(installed_version)"
  if [[ "$inst" == "$latest" ]]; then
    log "already on $latest"
    cmd_install
    return
  fi
  cmd_prepare "$latest"
  # ocx update stops the proxy before installing; a warm npm cache keeps that window short.
  log "prefetching $PKG@$latest into the npm cache (the proxy stays up meanwhile)"
  npm install --silent --ignore-scripts --no-save --no-audit --no-fund --prefix "$STATE/prefetch" "$PKG@$latest"
  # Presets and migrations of a new release may rewrite operator config; keep the pre-update state to diff.
  backup="$HOME/.opencodex/backups/pre-$latest-$(date +%Y%m%dT%H%M%S)"
  mkdir -p -m 700 "$backup" && cp -p "$HOME/.opencodex/config.json" "$CODEX_CONFIG" "$backup/"
  log "config backup: $backup"
  model="$(root_model)"
  quit_app
  log "ocx update $inst -> $latest"
  ocx update || rc=$?
  restore_root_model "$model"
  ((rc == 0)) || die "ocx update failed (exit $rc)"
  inst="$(installed_version)"
  [[ "$inst" == "$latest" ]] || die "ocx update installed $inst, expected $latest; run: $0 prepare $inst && $0 install"
  cmd_install
}

cmd_status() {
  local cmd cur base tag inst latest state
  cmd="$(serving_cmd)"
  base="$(base_version)"
  tag="$(head_tag)"
  inst="$(installed_version)"
  latest="$(latest_version)"
  cur="$(mktemp)"
  fork_patch "$cur"
  state="$(pkg_state "$cur")"
  rm -f "$cur"
  echo "installed:  $inst (fork: $state)"
  echo "fork:       $BRANCH $(g rev-parse --short "$BRANCH") on v$base, ${tag:-not finalized}"
  echo "npm latest: $latest"
  case "$cmd" in
    *"$PKG_DIR"*) echo "serving:    npm package (fork path)" ;;
    "$APP"/*) echo "serving:    OpenCodex.app bundled ocx $("$APP/Contents/MacOS/ocx" --version | awk '{print $2}'), fork NOT active; run: $0 serve" ;;
    "") echo "serving:    nothing" ;;
    *) echo "serving:    $cmd" ;;
  esac
  echo "fork commits:"
  g log --format='  %h %s' "v$base..$BRANCH"
  # The next step, when the package and the branch disagree.
  if [[ "$inst" != "$base" ]]; then
    if [[ "$base" == "$latest" ]]; then echo "next:       $0 update"; else echo "next:       $0 prepare $inst"; fi
  elif [[ -z "$tag" ]]; then
    echo "next:       $0 finalize $base"
  elif [[ "$state" != applied ]]; then
    echo "next:       $0 install"
  fi
}

case "${1:-}" in
  status) cmd_status ;;
  update) cmd_update ;;
  prepare) cmd_prepare "${2:-}" ;;
  finalize) cmd_finalize "${2:-}" ;;
  install) cmd_install ;;
  revert) cmd_revert ;;
  serve) restart_proxy ;;
  *)
    echo "usage: $0 {status|update|prepare [version]|finalize <version>|install|revert|serve}" >&2
    exit 2
    ;;
esac
