#!/usr/bin/env bash
# Builds the fork branch the way upstream builds its npm release and installs that build in place of the
# global npm package. Usage: README.md here.
set -euo pipefail

FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$FORK_DIR" rev-parse --show-toplevel)"
BRANCH="berish"
UPSTREAM="upstream"
# Local, untracked state: the pinned test Bun and the built tarballs.
STATE="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/ocx-fork"
BUILD_WT="$(dirname "$REPO")/opencodex-worktrees/build"
PKG="@bitkyc08/opencodex"
# Written into the installed package; its absence means a stock package (GUI update or bare ocx update).
MARKER=".berish-fork.json"
TARBALL=""
die() { echo "ocx-fork: $*" >&2; exit 1; }
log() { echo "==> $*"; }
g() { git -C "$REPO" "$@"; }

# Locate the package through the installed launcher, then put ITS Node toolchain first on PATH.
# Another node/npm earlier on PATH (e.g. ~/.local/bin) has a different global prefix.
OCX_BIN="$(command -v opencodex)" || die "opencodex is not on PATH"
PKG_DIR="$(cd "$(dirname "$(readlink -f "$OCX_BIN")")/.." && pwd)"
export PATH="$(dirname "$OCX_BIN"):$PATH"
[[ "$(npm root -g)/$PKG" -ef "$PKG_DIR" ]] || die "npm on $(dirname "$OCX_BIN") does not own $PKG_DIR"
# Siblings of the live package, as in upstream's transactional install: same volume, so swaps are renames.
SCOPE_DIR="$(dirname "$PKG_DIR")"
STAGE="$SCOPE_DIR/.berish-stage"
PREVIOUS="$SCOPE_DIR/.berish-previous"
# Run on top of every fork revision; the fork's own tests come from its diff.
GUARD_TESTS="tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/structure-ssot.test.ts"
# The menu-bar app ships its own compiled ocx without the fork and starts it whenever port 10100 is free.
APP="/Applications/OpenCodex.app"
APP_WAS_RUNNING=0
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"

installed_version() { node -p "require('$PKG_DIR/package.json').version"; }
installed_tag() { node -e 'try { console.log(require(process.argv[1]).tag) } catch {}' "$PKG_DIR/$MARKER"; }
latest_version() { npm view "$PKG" dist-tags.latest; }

# The stable upstream release under the branch; preview tags (v2.99.0-preview.*) never serve as a base.
base_version() {
  local tag
  tag="$(g describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' "$BRANCH" 2>/dev/null)" \
    || die "no upstream release tag under $BRANCH; run: git -C $REPO fetch $UPSTREAM tag v<version>"
  echo "${tag#v}"
}

# Fetches the release tag and checks it is the commit npm published, so the fork sits on a real release.
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

# Tag that marks the branch tip as verified by finalize; only such tips are built and installed.
head_tag() { g tag --points-at "$BRANCH" --list 'berish-v*' | head -1; }

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

# PID of the process that serves the proxy port, empty when nothing does.
serving_pid() {
  ocx resolve --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).liveness.pid??"")}catch{}})'
}

serving_cmd() {
  local pid; pid="$(serving_pid)"
  [[ -n "$pid" ]] && ps -o command= -p "$pid"
  return 0
}

check_serving() {
  local cmd; cmd="$(serving_cmd)"
  [[ "$cmd" == *"$PKG_DIR"* ]] || die "the proxy is served by '${cmd:-nothing}', expected $PKG_DIR; run: $0 serve"
}

# Root-table `model = ...` line of the Codex config, empty when absent.
root_model() { awk '/^\[/ {exit} /^model[[:space:]]*=/ {print; exit}' "$CODEX_CONFIG" 2>/dev/null || true; }

# A proxy stop restores native Codex config and drops a routed default model; the restart re-injects only the
# routing keys. Put the saved line back next to model_catalog_json.
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
  log "tagged $tag"
}

# Rebases the branch onto the release, then finalizes; a conflict stops before anything is built.
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

# The fork on GitHub follows every verified tip; a rebase rewrites the branch, hence --force-with-lease.
cmd_publish() {
  local tag; tag="$(head_tag)"
  [[ -n "$tag" ]] || die "the $BRANCH tip is not finalized; run: $0 finalize $(base_version)"
  log "publishing $BRANCH and $tag to origin"
  g push --force-with-lease origin "$BRANCH" "$tag"
}

# Packs the tagged tip the way upstream's release.yml packs its npm release: stamp the release version into
# the version sources, build the GUI, run prepack, record gitHead, npm pack without scripts. A throwaway
# worktree keeps the checkout clean. Sets TARBALL.
build_tarball() { # <tag>
  local tag="$1" ver bun packed
  ver="$(base_version)"
  TARBALL="$STATE/dist/$tag.tgz"
  if [[ -f "$TARBALL" ]]; then
    log "reusing $TARBALL"
    return
  fi
  bun="$(bun_bin)"
  mkdir -p "$STATE/dist" "$(dirname "$BUILD_WT")"
  g worktree remove --force "$BUILD_WT" 2>/dev/null || true
  g worktree add -q --detach "$BUILD_WT" "$tag"
  log "building $tag as $PKG@$ver"
  (
    cd "$BUILD_WT"
    "$bun" install --frozen-lockfile
    export PATH="$BUILD_WT/node_modules/.bin:$PATH"
    bun scripts/release-version-sources.ts sync "$ver"
    bun run build:gui
    npm run prepack
    SOURCE_SHA="$(git rev-parse HEAD)" node -e '
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      pkg.gitHead = process.env.SOURCE_SHA;
      fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");'
  )
  packed="$(cd "$BUILD_WT" && npm pack --ignore-scripts --silent --pack-destination "$STATE/dist")"
  mv "$STATE/dist/$packed" "$TARBALL"
  g worktree remove --force "$BUILD_WT"
  log "built $TARBALL"
}

# Installs the tarball into $STAGE with upstream's staging command, checks that the staged tree is exactly
# the tagged source and starts, then marks it with the tag.
stage_tarball() { # <tag>
  local tag="$1" ver staged src
  ver="$(base_version)"
  staged="$STAGE/lib/node_modules/$PKG"
  rm -rf "$STAGE"
  # npm needs <stage>/lib before a global install into a bare prefix (upstream #5760).
  mkdir -p "$STAGE/lib"
  log "installing $tag into $STAGE"
  npm install -g --prefix "$STAGE" --allow-scripts=bun --no-audit --no-fund "$TARBALL"
  [[ "$(node -p "require('$staged/package.json').version")" == "$ver" ]] || die "the staged package is not $ver"
  [[ -x "$staged/node_modules/bun/bin/bun.exe" ]] || die "the staged package has no bundled bun"
  src="$(mktemp -d)"
  g archive "$tag" src bin | tar -x -C "$src"
  # compatibility-version.json is generated at pack time from the stamped sources.
  diff -r --exclude=compatibility-version.json "$src/src" "$staged/src" >/dev/null \
    || die "the staged src/ differs from $tag"
  diff -r "$src/bin" "$staged/bin" >/dev/null || die "the staged bin/ differs from $tag"
  rm -rf "$src"
  # An isolated home keeps the launcher away from the live proxy's state.
  OPENCODEX_HOME="$(mktemp -d)" CODEX_HOME="$(mktemp -d)" node "$staged/bin/ocx.mjs" --version | grep -qx "opencodex $ver" \
    || die "the staged ocx does not start"
  printf '{ "tag": "%s", "commit": "%s", "version": "%s" }\n' "$tag" "$(g rev-parse "$tag^{commit}")" "$ver" >"$staged/$MARKER"
  log "staged $tag passed its checks"
}

# Restarts through launchd and waits for a healthy proxy that is a new process running from PKG_DIR.
restart_and_check() { # [pid serving before the restart]
  local pid cmd
  log "restarting the proxy service"
  ocx service restart || return 1
  for _ in $(seq 1 30); do
    if ocx health >/dev/null 2>&1; then
      pid="$(serving_pid)"
      if [[ -n "$pid" && "$pid" != "${1:-}" ]]; then
        cmd="$(ps -o command= -p "$pid")"
        [[ "$cmd" == *"$PKG_DIR"* ]] || { log "the proxy is served by '$cmd'"; return 1; }
        log "proxy healthy (pid $pid)"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

restart_proxy() {
  quit_app
  restart_and_check "" || die "proxy is not healthy; check ~/.opencodex/service.log"
  reopen_app
}

cmd_build() {
  local tag; tag="$(head_tag)"
  [[ -n "$tag" ]] || die "the $BRANCH tip is not finalized; run: $0 finalize $(base_version)"
  build_tarball "$tag"
  stage_tarball "$tag"
}

# Swaps the staged tree in with two same-volume renames and restarts the service. If the proxy does not come
# back on the new tree, the previous tree goes back and the service restarts on it.
cmd_install() {
  local tag model old_pid backup
  tag="$(head_tag)"
  [[ -n "$tag" ]] || die "the $BRANCH tip is not finalized; run: $0 finalize $(base_version)"
  if [[ "$(installed_tag)" == "$tag" ]]; then
    log "$tag is already installed"
    check_serving
    return
  fi
  build_tarball "$tag"
  stage_tarball "$tag"
  # A new release may migrate operator config on its first start; keep the pre-install state to diff.
  backup="$HOME/.opencodex/backups/pre-$tag-$(date +%Y%m%dT%H%M%S)"
  mkdir -p -m 700 "$backup" && cp -p "$HOME/.opencodex/config.json" "$CODEX_CONFIG" "$backup/"
  log "config backup: $backup"
  quit_app
  model="$(root_model)"
  old_pid="$(serving_pid)"
  rm -rf "$PREVIOUS"
  mv "$PKG_DIR" "$PREVIOUS"
  mv "$STAGE/lib/node_modules/$PKG" "$PKG_DIR" || { mv "$PREVIOUS" "$PKG_DIR"; die "could not move the staged tree into place; nothing changed"; }
  if restart_and_check "$old_pid"; then
    restore_root_model "$model"
    reopen_app
    rm -rf "$STAGE"
    find "$STATE/dist" -name '*.tgz' ! -name "$tag.tgz" -delete
    log "$tag installed; the previous package is kept at $PREVIOUS ($0 revert)"
    return
  fi
  log "the proxy did not come back on $tag; restoring the previous package"
  mv "$PKG_DIR" "$STAGE/failed"
  mv "$PREVIOUS" "$PKG_DIR"
  restart_and_check "" || die "the previous package does not start either; check ~/.opencodex/service.log"
  restore_root_model "$model"
  reopen_app
  die "$tag did not start; the previous package is back, the failed tree is $STAGE/failed"
}

# Swaps the previous package back in and keeps the current one as previous, so a second revert undoes the first.
cmd_revert() {
  local swap="$SCOPE_DIR/.berish-swap" model old_pid
  [[ -d "$PREVIOUS" ]] || die "no previous package at $PREVIOUS"
  quit_app
  model="$(root_model)"
  old_pid="$(serving_pid)"
  rm -rf "$swap"
  mv "$PKG_DIR" "$swap"
  mv "$PREVIOUS" "$PKG_DIR"
  mv "$swap" "$PREVIOUS"
  restart_and_check "$old_pid" || die "proxy is not healthy after the revert; check ~/.opencodex/service.log, undo with: $0 revert"
  restore_root_model "$model"
  reopen_app
  log "reverted to $(installed_version) $(installed_tag)"
}

# The whole cycle: rebase onto the newest upstream release, verify, publish the fork, build, install.
cmd_update() {
  local latest base
  latest="$(latest_version)"
  base="$(base_version)"
  if [[ "$latest" != "$base" ]]; then cmd_prepare "$latest"; else cmd_finalize "$base"; fi
  cmd_publish || log "WARNING: the push failed; publish later with: $0 publish"
  cmd_install
}

cmd_status() {
  local base tag itag latest cmd
  base="$(base_version)"
  tag="$(head_tag)"
  itag="$(installed_tag)"
  latest="$(latest_version)"
  cmd="$(serving_cmd)"
  if [[ -n "$itag" ]]; then
    echo "installed:  $(installed_version), fork build $itag"
  else
    echo "installed:  $(installed_version), stock npm package without the fork"
  fi
  echo "fork:       $BRANCH $(g rev-parse --short "$BRANCH") on v$base, ${tag:-not finalized}"
  echo "npm latest: $latest"
  case "$cmd" in
    *"$PKG_DIR"*) echo "serving:    npm package path" ;;
    "$APP"/*) echo "serving:    OpenCodex.app bundled ocx $("$APP/Contents/MacOS/ocx" --version | awk '{print $2}'), fork NOT active; run: $0 serve" ;;
    "") echo "serving:    nothing" ;;
    *) echo "serving:    $cmd" ;;
  esac
  echo "fork commits:"
  g log --format='  %h %s' "v$base..$BRANCH"
  if [[ -z "$tag" ]]; then
    echo "next:       $0 finalize $base"
  elif [[ "$itag" != "$tag" ]]; then
    echo "next:       $0 install"
  elif [[ "$base" != "$latest" ]]; then
    echo "next:       upstream released $latest; $0 update when you decide to move"
  fi
}

case "${1:-}" in
  status) cmd_status ;;
  update) cmd_update ;;
  prepare) cmd_prepare "${2:-}" ;;
  finalize) cmd_finalize "${2:-}" ;;
  publish) cmd_publish ;;
  build) cmd_build ;;
  install) cmd_install ;;
  revert) cmd_revert ;;
  serve) restart_proxy ;;
  *)
    echo "usage: $0 {status|update|prepare [version]|finalize <version>|publish|build|install|revert|serve}" >&2
    exit 2
    ;;
esac
