#!/bin/sh
# Copies the built social-tunnel.app to ~/Applications, replacing an older copy (plan criteria 80, 81).
# SOCIAL_TUNNEL_BUNDLE overrides the bundle to copy (tests).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src=${SOCIAL_TUNNEL_BUNDLE:-$here/../src-tauri/target/release/bundle/macos/social-tunnel.app}
apps=$HOME/Applications
name=social-tunnel.app

if [ ! -x "$src/Contents/MacOS/social-tunnel-app" ] || [ ! -x "$src/Contents/MacOS/social-tunnel" ]; then
  echo "No built bundle at $src. Run: cd app && bunx tauri build --bundles app" >&2
  exit 1
fi
[ ! -L "$apps" ] || { echo "Refusing to install through a symlink." >&2; exit 1; }
/bin/mkdir -p "$apps"
apps=$(cd "$apps" && pwd -P)
dest=$apps/$name

# Lock the directory inode, not a removable lockfile. Hold it through rollback and cleanup.
exec 9<"$apps"
if ! /usr/bin/lockf -s -t 0 9; then
  echo "Another install is in progress, or the install directory could not be locked." >&2
  exit 1
fi

check_destination() {
  if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -d "$dest" ]; }; then
    echo "Refusing to replace a symlink or non-directory." >&2
    exit 1
  fi
  exe=$dest/Contents/MacOS/social-tunnel-app
  [ -e "$exe" ] || return 0
  # lsof resolves a named file by device/inode; txt selects mapped program text, not argv.
  if result=$(/usr/sbin/lsof +w -nP -a -d txt -Fp -- "$exe" 2>&1); then
    echo "Quit social-tunnel first."
    exit 1
  else
    status=$?
    if [ "$status" -ne 1 ] || [ -n "$result" ]; then
      echo "Could not verify that social-tunnel is closed." >&2
      exit 1
    fi
  fi
}

check_destination
if [ -d "$dest" ] && [ "$(cd "$src" && pwd -P)" = "$dest" ]; then
  echo "The built bundle is already at the install destination." >&2
  exit 1
fi

stage=$(/usr/bin/mktemp -d "$apps/.social-tunnel.XXXXXXXX")
backup=$stage/old/$name
staged=$stage/new/$name
installed=no
publish() {
  # Move to the parent, never into an existing bundle. -n can exit 0 without moving.
  /bin/mv -hn "$1" "$apps/" && [ ! -e "$1" ]
}
cleanup() {
  if [ "$installed" = no ] && [ -e "$backup" ]; then
    if [ -e "$dest" ] || [ -L "$dest" ] || ! publish "$backup"; then
      echo "Could not restore the previous bundle; it remains at $backup." >&2
      return 1
    fi
  fi
  /bin/rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
/bin/mkdir "$stage/new" "$stage/old"
/usr/bin/ditto "$src" "$staged"

# Catch a launch during staging. The OS launcher does not take the installer lock.
check_destination
if [ -d "$dest" ]; then /bin/mv -h "$dest" "$stage/old/"; fi
publish "$staged"
installed=yes
echo "Installed $dest"
