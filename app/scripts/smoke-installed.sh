#!/bin/sh
# Run the isolated login proof, then the installed tray's native menu and Quit.
# `login` and `preflight` are also runnable separately; neither launches the tray.
set -eu
app="$HOME/Applications/social-tunnel.app"
exe="$app/Contents/MacOS/social-tunnel-app"
sidecar="$app/Contents/MacOS/social-tunnel"
label=tech.antoniofulg.social-tunnel
agent="gui/$(id -u)/$label"
plist="$HOME/Library/LaunchAgents/$label.plist"
login_plist="$HOME/Library/LaunchAgents/$label.tray.plist"
here=$(cd "$(dirname "$0")" && pwd)
built="$here/../src-tauri/target/release/bundle/macos/social-tunnel.app"

fail() { printf 'FAIL [tray-app %s] %s\n' "$1" "$2" >&2; exit 1; }
agent_pid() { /bin/launchctl print "$agent" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3 }'; }
app_pid() {
  /bin/ps -axo pid=,command= | COPY_EXE="$exe" awk '{
    pid = $1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
    e = ENVIRON["COPY_EXE"]; if ($0 == e || index($0, e " ") == 1) print pid
  }'
}
runs() {
  /bin/ps -axo pid=,command= | awk '
    $2 ~ /(^|\/)social-tunnel$/ && $3 == "run" { print $1 }
    $2 ~ /(^|\/)bun$/ {
      for (i = 3; i < NF; i++) if ($i ~ /(^|\/)cli[.]ts$/ && $(i+1) == "run") { print $1; break }
    }'
}
state() {
  pid=$(agent_pid)
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$(runs)" = "$pid" ] || return 1
  started=$(LC_ALL=C /bin/ps -p "$pid" -o lstart=) || return 1
  hash=$(shasum -a 256 < "$plist") || return 1
  printf 'pid=%s start=%s count=1 plist_sha256=%s\n' "$pid" "$started" "${hash%% *}"
}
connected() {
  # Never print the JSON: it includes private config values.
  out=$("$sidecar" status --json 2>/dev/null) || return 1
  printf '%s' "$out" | jq -es --argjson pid "$1" \
    'length == 1 and (.[0] | .command == "status" and .ok and .state == "connected" and .pid == $pid)' >/dev/null 2>&1
}
preflight() {
  [ -x "$exe" ] && [ -x "$sidecar" ] || fail C82 "installed bundle missing"
  /usr/bin/cmp -s "$built/Contents/MacOS/social-tunnel-app" "$exe" &&
    /usr/bin/cmp -s "$built/Contents/MacOS/social-tunnel" "$sidecar" &&
    /usr/bin/cmp -s "$built/Contents/Info.plist" "$app/Contents/Info.plist" ||
    fail C82 "installed binaries or bundle identity differ from the local build"
  [ ! -e "$login_plist" ] || fail C82 "Open at Login is already on"
  # LaunchServices and the packaged sidecar must use the same default config.
  [ -z "${SOCIAL_TUNNEL_CONFIG:-}${XDG_CONFIG_HOME:-}" ] || fail C82 "shell overrides config"
  for key in SOCIAL_TUNNEL_CONFIG XDG_CONFIG_HOME; do
    [ -z "$(/bin/launchctl getenv "$key")" ] || fail C82 "launchd overrides config"
  done
  home=$(/bin/launchctl getenv HOME)
  [ -z "$home" ] || [ "$home" = "$HOME" ] || fail C82 "launchd HOME differs"
  state0=$(state) || fail C82 "expected exactly the live external run and a readable plist"
  pid0=$(agent_pid)
  connected "$pid0" && [ "$(state)" = "$state0" ] || fail C82 "packaged status is not connected to the same external PID"
  printf 'Read-only preflight: packaged sidecar connected; %s\n' "$state0"
}
login() {
  [ -x "$exe" ] || fail C79 "installed executable missing"
  job="$agent.tray"
  [ ! -e "$login_plist" ] || fail C79 "Open at Login is already on"
  ! /bin/launchctl print "$job" >/dev/null 2>&1 || fail C79 "tray login job already registered"
  before=$(state) || fail C79 "could not read live baseline"
  if ! (cd "$here/../src-tauri" &&
        load-gate wait &&
        SOCIAL_TUNNEL_APP_EXE="$exe" CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 \
          cargo test --locked -j 2 --test login_agent -- --test-threads=1); then
    fail C79 "isolated login backend test failed"
  fi
  [ "$(state)" = "$before" ] &&
    [ ! -e "$login_plist" ] &&
    ! /bin/launchctl print "$job" >/dev/null 2>&1 || fail C79 "real login or tunnel state changed"
  printf 'PASS [tray-app C78] login\nPASS [tray-app C79] login\n'
}
ui() {
  /usr/bin/osascript -e "tell application \"System Events\" to tell (first process whose unix id is $tray_pid) to $1" 2>/dev/null
}
wait_for_start() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    tray_pid=$(app_pid)
    case "$tray_pid" in ''|*[!0-9]*) sleep 1 ;; *) return 0 ;; esac
  done
  return 1
}
native() {
  preflight
  # Check that there is an unlocked GUI before trying System Events or launching anything.
  orca computer permissions --json >/dev/null || fail C11 "Orca could not access the GUI"
  [ "$(/usr/bin/osascript -e 'tell application "System Events" to get UI elements enabled' 2>/dev/null)" = true ] ||
    fail C11 "System Events accessibility unavailable"
  preflight
  [ -z "$(app_pid)" ] || fail C82 "installed tray is already running"
  /usr/bin/open -gj "$app" && wait_for_start || fail C11 "installed tray did not launch"
  # Wait for two status polls before inspecting the native menu. Never select Run Check or Settings:
  # both can start a live doctor (C49/C62).
  sleep 4
  type=$(/usr/bin/lsappinfo info -only ApplicationType "$(/usr/bin/lsappinfo find pid="$tray_pid")")
  case "$type" in *UIElement*) ;; *) fail C11 "installed tray is not a UI element" ;; esac
  [ "$(ui 'count of menu bar items of menu bar 2')" = 1 ] || fail C11 "expected one menu bar extra"
  printf 'PASS [tray-app C11] menu\n'
  ui 'click menu bar item 1 of menu bar 2' >/dev/null || fail C82 "could not open the native menu"
  items=$(ui 'get name of every menu item of menu 1 of menu bar item 1 of menu bar 2') ||
    fail C82 "could not read the native menu"
  case "$items" in "Connected, Managed outside the app (pid $pid0).,"*) ;; *) fail C82 "external connected rows missing" ;; esac
  case ", $items, " in *", Reconnect, "*) fail C82 "Reconnect shown for external run" ;; esac
  [ "$(state)" = "$state0" ] || fail C82 "live tunnel changed while tray ran"
  printf 'PASS [tray-app C82] menu\n'
  ui 'click menu item "Quit social-tunnel" of menu 1 of menu bar item 1 of menu bar 2' >/dev/null ||
    fail C82 "could not select tray Quit"
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(app_pid)" ] && break; sleep 1; done
  [ -z "$(app_pid)" ] && [ "$(state)" = "$state0" ] || fail C82 "Quit did not preserve the external run"
  connected "$pid0" || fail C82 "packaged status changed before reopen"
  /usr/bin/open -gj "$app" && wait_for_start || fail C82 "could not reopen the installed tray"
  [ "$(state)" = "$state0" ] || fail C82 "live tunnel changed after reopen"
  printf 'PASS [tray-app C82] quit\n'
}

case "${1:-all}" in
  all) login; native ;;
  login) login ;;
  preflight) preflight ;;
  native) native ;;
  *) printf 'Usage: %s [login|preflight|native]\n' "$0" >&2; exit 2 ;;
esac
