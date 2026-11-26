#!/bin/sh
{ trap '[ "${started:-}" = 1 ] || { echo "bootstrap.sh: this copy of the script is incomplete (the download was cut short), so nothing ran; download it again" >&2; exit 1; }' EXIT; }
# Mirador bootstrap, meant for: curl -fsSL https://raw.githubusercontent.com/mata-2p/mirador/main/scripts/bootstrap.sh | sh
# Read it before running it. It clones Mirador into ${XDG_DATA_HOME:-~/.local/share}/mirador (or
# fast-forwards that clone when it has no local changes), then runs the clone's install.sh with the
# arguments given (curl ... | sh -s -- --root ~/code), from the folder you ran this in, so the paths
# install.sh prints are full ones. It never runs sudo; install.sh only says how to install what is
# missing. POSIX sh: `sh` may be dash.
#
# Linux x64 and arm64 with glibc 2.28 or newer get the release pinned below instead (MIRADOR_VERSION and the
# sha256 of each platform's archive): its prebuilt archive, which bundles Node and a built node-pty, is
# downloaded from GitHub Releases, checked against the sha256 pinned here before it is unpacked into
# <that folder>/<version>, and <that folder>/current points at it; then its doctor runs and bin/mirador
# install adds the launcher. A git clone in that folder is never overwritten or deleted: the
# script stops and says what to do. A first install cut off abruptly leaves only its download folders
# (.download.XXXXXX) there: the next run removes them and goes on. It checks for no updates; running it
# again is how you update, and when a Mirador server runs it says that the server keeps the previous
# version until it restarts. Every other platform, one with an empty sha256, and every platform while
# MIRADOR_VERSION is empty (no release pinned) install from source as above.
#
# A download cut short hands sh only part of this file, so nothing runs before the last line: the trap
# above, set first, says the copy is incomplete whenever sh ends before main has started. Everything else
# is in functions that only main calls, and the last line calls main in a brace group: a copy cut anywhere
# in that line ends in a syntax error (an unclosed group or quote) or before main is called, never in a
# call with part of its arguments. Both lines are braced so that no part of them runs: only a cut within
# the shebang or right after it ends sh without that message, still running nothing.

# Whether this machine takes the pinned prebuilt release: a version is pinned, it is Linux x64 or arm64 with
# a sha256 pinned for it, and its glibc is 2.28 or newer (the official Node binary's minimum). Sets
# platform and sha for it.
prebuilt_platform() {
  [ -n "$MIRADOR_VERSION" ] || return 1
  [ "$(uname -s)" = Linux ] || return 1
  case "$(uname -m)" in
    x86_64 | amd64) platform=linux-x64 sha="$MIRADOR_SHA256_LINUX_X64" ;;
    aarch64 | arm64) platform=linux-arm64 sha="$MIRADOR_SHA256_LINUX_ARM64" ;;
    *) return 1 ;;
  esac
  [ -n "$sha" ] || return 1
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  if ! glibc_2_28 "$libc"; then
    echo "bootstrap.sh: the prebuilt release needs glibc 2.28 or newer (found: ${libc:-none}), so Mirador installs from source" >&2
    return 1
  fi
}

# Whether getconf's answer ("glibc 2.39") names glibc 2.28 or newer.
glibc_2_28() {
  case "$1" in "glibc "*) ;; *) return 1 ;; esac
  libc_version="${1#glibc }"
  libc_major="${libc_version%%.*}"
  libc_minor="${libc_version#*.}"
  libc_minor="${libc_minor%%.*}"
  case "$libc_major:$libc_minor" in *[!0-9:]* | :* | *:) return 1 ;; esac
  [ "$libc_major" -gt 2 ] || { [ "$libc_major" -eq 2 ] && [ "$libc_minor" -ge 28 ]; }
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}

# Removes what a prebuilt install left half done: the download folder, then the folders this run made for it
# ($dir and those above it up to $made_top), each only while it is empty.
cleanup() {
  if [ -n "${staging:-}" ]; then rm -rf "$staging"; fi
  if [ -n "${made_top:-}" ]; then
    made="$dir"
    while [ -n "$made" ] && rmdir "$made" 2>/dev/null && [ "$made" != "$made_top" ]; do
      made="${made%/*}"
    done
  fi
  return 0
}

# Whether $dir is a folder holding nothing but download folders that a run of this script made with mktemp
# (.download.XXXXXX: six letters or digits, a real folder, no link) and left there when it was cut off before
# its cleanup ran, and at least one of them. Sets leftovers to their paths, one per line.
only_leftovers() {
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  leftovers=""
  for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "${entry##*/}" in
      .download.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;;
      *) return 1 ;;
    esac
    [ -d "$entry" ] && [ ! -L "$entry" ] || return 1
    leftovers="$leftovers$entry
"
  done
  [ -n "$leftovers" ]
}

# Installs the pinned release for $platform into $dir/<version>, points $dir/current at it, runs its doctor and
# adds the launcher. The archive is checked against the pinned $sha before anything is unpacked.
prebuilt() {
  case "$sha" in *[!0-9a-f]*) sha_ok=0 ;; *) sha_ok=1 ;; esac
  if [ "$sha_ok" = 0 ] || [ "${#sha}" -ne 64 ]; then
    echo "bootstrap.sh: the sha256 pinned in this script for $platform is not 64 lowercase hex digits, so this copy of the script is broken; nothing was installed" >&2
    exit 1
  fi
  if [ -e "$dir/.git" ]; then
    echo "bootstrap.sh: $dir is a git clone of Mirador (an install from source), so this installer leaves it as it is and stops. To keep it, update it with: git -C $dir pull --ff-only && $dir/install.sh. To switch to the prebuilt release, move the clone away (for example: mv $dir $dir.clone), then run this again" >&2
    exit 1
  fi
  if [ "$#" -gt 0 ]; then
    echo "bootstrap.sh: the prebuilt install takes no installer options (given: $*); run it without them" >&2
    exit 1
  fi
  if [ -e "$dir" ] && [ ! -L "$dir/current" ]; then
    if ! only_leftovers; then
      echo "bootstrap.sh: $dir exists and is neither a prebuilt install of Mirador nor a git clone of it; move it away, then run this again" >&2
      exit 1
    fi
    # A first install cut off before its cleanup ran (power off, SIGKILL): finish that cleanup, then install
    # as on a fresh machine, the folder this run makes included.
    printf '%s' "$leftovers" | while IFS= read -r leftover; do
      rm -rf "$leftover"
      echo "bootstrap.sh: removed $leftover, a download an earlier run left half done"
    done
    rmdir "$dir"
  fi

  name="mirador-$MIRADOR_VERSION-$platform"
  url="https://github.com/mata-2p/mirador/releases/download/v$MIRADOR_VERSION/$name.tar.gz"
  target="$dir/$MIRADOR_VERSION"
  if [ -d "$target" ]; then
    echo "bootstrap.sh: Mirador $MIRADOR_VERSION is already in $target, so nothing was downloaded"
  else
    if ! command -v curl >/dev/null 2>&1; then
      echo "bootstrap.sh: missing curl (it downloads Mirador); install it, then run this again" >&2
      exit 1
    fi
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
      echo "bootstrap.sh: missing sha256sum and shasum (one of them checks the download); install coreutils, then run this again" >&2
      exit 1
    fi
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM
    # The highest of $dir and its parents that does not exist yet: cleanup removes no folder above it.
    made_top=""
    missing="$dir"
    while [ -n "$missing" ] && [ ! -e "$missing" ]; do
      made_top="$missing"
      missing="${missing%/*}"
    done
    mkdir -p "$dir"
    # Inside the data folder, so the finished version moves into place with a rename.
    staging="$(mktemp -d "$dir/.download.XXXXXX")"
    echo "bootstrap.sh: downloading $url"
    if ! curl -fsSL --proto '=https' --tlsv1.2 -o "$staging/$name.tar.gz" "$url"; then
      echo "bootstrap.sh: could not download $url (curl failed, see above); nothing was installed" >&2
      exit 1
    fi
    got="$(sha256_of "$staging/$name.tar.gz")"
    got="${got%% *}"
    if [ "$got" != "$sha" ]; then
      echo "bootstrap.sh: $name.tar.gz does not match the sha256 pinned in this script (expected $sha, got $got), so it was not unpacked and nothing was installed; download this script again, and report it if it happens again" >&2
      exit 1
    fi
    echo "bootstrap.sh: the download matches the sha256 pinned in this script"
    mkdir "$staging/unpacked"
    if ! tar -xzf "$staging/$name.tar.gz" -C "$staging/unpacked"; then
      echo "bootstrap.sh: $name.tar.gz could not be unpacked (tar failed, see above); nothing was installed" >&2
      exit 1
    fi
    if [ ! -x "$staging/unpacked/$name/bin/mirador" ] || [ ! -x "$staging/unpacked/$name/node/bin/node" ]; then
      echo "bootstrap.sh: $name.tar.gz holds no $name/bin/mirador and $name/node/bin/node; nothing was installed" >&2
      exit 1
    fi
    mv "$staging/unpacked/$name" "$target"
    rm -rf "$staging"
    staging=""
    made_top=""
    echo "bootstrap.sh: unpacked Mirador $MIRADOR_VERSION into $target"
  fi
  previous="$(readlink "$dir/current" 2>/dev/null || true)"
  # Earlier versions stay beside it: pointing current back at one, then running its bin/mirador install, rolls back.
  ln -sfn "$MIRADOR_VERSION" "$dir/current"
  echo "bootstrap.sh: $dir/current now points at $MIRADOR_VERSION"

  app="$dir/current"
  # On an update, a server already running keeps the code it started with. bin/mirador status tells, as the
  # launcher always does: its state file names a pid that is alive and runs src/server.ts.
  if [ -n "$previous" ] && [ "$previous" != "$MIRADOR_VERSION" ] && "$app/bin/mirador" status >/dev/null 2>&1; then
    echo "bootstrap.sh: a Mirador server is running, and it keeps running Mirador $previous until you restart it with: mirador stop && mirador"
  fi
  echo "bootstrap.sh: checking the machine (doctor)"
  if ! "$app/node/bin/node" "$app/src/doctor.ts"; then
    echo "bootstrap.sh: the doctor found a problem (see above); fix it, then run this again" >&2
    exit 1
  fi
  echo "bootstrap.sh: adding the launcher (bin/mirador install)"
  if ! "$app/bin/mirador" install; then
    echo "bootstrap.sh: $app/bin/mirador install failed (see above), so the launcher was not added; Mirador $MIRADOR_VERSION is in $target, so fix the problem, then run this again" >&2
    exit 1
  fi
  echo "bootstrap.sh: done; start Mirador with: $app/bin/mirador"
}

main() {
  started=1
  set -eu
  # The release this script installs prebuilt (see docs/releasing.md). A promotion PR to main sets these three
  # lines, and only them, to the lines in the next release's notes (scripts/release/pins.sh), replacing the
  # previous release's. An empty sha256 leaves its platform on the install from source; an empty
  # MIRADOR_VERSION (no release pinned) leaves every platform there. They are set here, not read from the
  # environment, so only a reviewed change to this script can change what it downloads.
  MIRADOR_VERSION="0.2.0"
  MIRADOR_SHA256_LINUX_X64="c534887213a3beaa0401fe469b70f70a6d70aee612d452bcb8a96656e05732d9"
  MIRADOR_SHA256_LINUX_ARM64="42cdb3647214714dc7432d8317ed472d64570f39a43b8f61e9680befe49accd4"

  repo="${MIRADOR_REPO_URL:-https://github.com/mata-2p/mirador.git}"
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/mirador"

  if [ "$(id -u)" = 0 ]; then
    echo "bootstrap.sh: do not run this as root (or with sudo); run it as your own user, Mirador installs into your home folder" >&2
    exit 1
  fi

  if prebuilt_platform; then
    prebuilt "$@"
    exit 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    # The clone, and with it install.sh's own hints, does not exist yet: name the package manager on PATH.
    hint="see https://git-scm.com/downloads"
    if [ "$(uname -s)" = Darwin ]; then
      hint="install it with: xcode-select --install"
    elif command -v pacman >/dev/null 2>&1; then
      hint="install it with: sudo pacman -S git"
    elif command -v apt-get >/dev/null 2>&1; then
      hint="install it with: sudo apt install git"
    elif command -v dnf >/dev/null 2>&1; then
      hint="install it with: sudo dnf install git"
    elif command -v zypper >/dev/null 2>&1; then
      hint="install it with: sudo zypper install git"
    fi
    echo "bootstrap.sh: missing git (it downloads Mirador); $hint" >&2
    exit 1
  fi

  if [ -d "$dir/.git" ]; then
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      echo "bootstrap.sh: $dir has local changes, so it was not updated; commit or discard them to update" >&2
    else
      echo "bootstrap.sh: updating $dir (git pull --ff-only)"
      git -C "$dir" pull --ff-only
    fi
  elif [ -e "$dir" ]; then
    echo "bootstrap.sh: $dir exists and is not a git clone of Mirador; move it away, then run this again" >&2
    exit 1
  else
    echo "bootstrap.sh: cloning $repo into $dir"
    mkdir -p "$(dirname "$dir")"
    if ! git clone --quiet "$repo" "$dir"; then
      echo "bootstrap.sh: could not download Mirador from $repo (git clone failed, see above); nothing was installed" >&2
      exit 1
    fi
  fi

  exec "$dir/install.sh" "$@"
}

{ main "$@"; }
