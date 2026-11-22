#!/bin/sh
# Copies the built social-tunnel.app to ~/Applications, replacing an older copy (plan criteria 80, 81).
# SOCIAL_TUNNEL_BUNDLE overrides the bundle to copy (tests).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src=${SOCIAL_TUNNEL_BUNDLE:-$here/../src-tauri/target/release/bundle/macos/social-tunnel.app}
dest=$HOME/Applications/social-tunnel.app

if [ ! -x "$src/Contents/MacOS/social-tunnel-app" ] || [ ! -x "$src/Contents/MacOS/social-tunnel" ]; then
  echo "No built bundle at $src. Run: cd app && bunx tauri build --bundles app" >&2
  exit 1
fi
# A running copy would keep its old binary open; refuse instead of replacing it underneath.
if /bin/ps -axo command= |
    COPY_EXE="$dest/Contents/MacOS/social-tunnel-app" /usr/bin/awk '
      { sub(/^[[:space:]]*/, ""); e = ENVIRON["COPY_EXE"]; if ($0 == e || index($0, e " ") == 1) found = 1 }
      END { exit !found }'; then
  echo "Quit social-tunnel first."
  exit 1
fi
[ ! -L "$HOME/Applications" ] && [ ! -L "$dest" ] || {
  echo "Refusing to install through a symlink." >&2
  exit 1
}
if [ -d "$dest" ] && [ "$(cd "$src" && pwd -P)" = "$(cd "$dest" && pwd -P)" ]; then
  echo "The built bundle is already at the install destination." >&2
  exit 1
fi
mkdir -p "$HOME/Applications"
stage=$(/usr/bin/mktemp -d "$HOME/Applications/.social-tunnel.XXXXXXXX")
cleanup() {
  if [ -e "$stage/old.app" ] && [ ! -e "$dest" ]; then
    /bin/mv -h "$stage/old.app" "$dest" || return
  fi
  /bin/rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
/usr/bin/ditto "$src" "$stage/new.app"
if [ -e "$dest" ]; then /bin/mv -h "$dest" "$stage/old.app"; fi
/bin/mv -h "$stage/new.app" "$dest"
echo "Installed $dest"
