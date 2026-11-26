#!/bin/sh
# Runs inside each clean container of the release workflow's smoke job, which smoke.sh starts with
#   /archive/<file>  the archive to check (read-only);
#   /release         this folder (read-only);
#   /out             where it writes its result, one key=value per line: glibc, unpack_ms, doctor_ms, start_ms;
# as the runner's user, with HOME=/tmp/home and no network. The container must be clean: no Node, npm, pnpm,
# compiler or make on PATH, as on a user's machine that never built anything. It unpacks the archive, runs its
# doctor with the bundled Node, starts the server with bin/mirador (with no display it prints a one-time link
# instead of opening a window), checks that the server answers the page, the link's session and the API, and
# stops it with bin/mirador stop.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: smoke-in-container.sh /archive/<mirador-<version>-linux-<arch>.tar.gz>" >&2
  exit 2
fi
archive="$1"
file="${archive##*/}"
name="${file%.tar.gz}"

logtail() {
  # The server's log is the only evidence for a start that failed or answered nothing, and the
  # container runs with --rm, so it is gone once this exits (#57).
  if [ -f "$HOME/.local/state/mirador/server.log" ]; then
    echo "smoke: last lines of the server log:" >&2
    tail -n 40 "$HOME/.local/state/mirador/server.log" >&2 || true
  fi
}
fail() {
  echo "smoke: $*" >&2
  logtail
  exit 1
}
now_ms() { echo $(($(date +%s%N) / 1000000)); }
# /out and /tmp/smoke are where the container mounts them; the test runs this script without one,
# so both can be pointed elsewhere and keep the same meaning (#57).
out="${SMOKE_OUT:-/out}"
work="${SMOKE_WORK:-/tmp/smoke}"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result"; }

for tool in node npm npx pnpm gcc cc g++ c++ clang make; do
  if found="$(command -v "$tool")"; then fail "this container is not clean: $tool is on PATH ($found)"; fi
done

# `set -e` would end the run here with no smoke message when getconf cannot answer (#57).
glibc="$(getconf GNU_LIBC_VERSION)" || fail "getconf cannot report the glibc version"
glibc="${glibc#glibc }"
result glibc "$glibc"
# The container's own os-release; when it cannot be read, the kernel name says enough (#57).
distro="$(uname -s)"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  distro="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-$distro}")" || distro="$(uname -s)"
fi
echo "smoke: $file on $distro, glibc $glibc, $(uname -m)"

mkdir -p "$HOME" "$work"
start="$(now_ms)"
tar -xzf "$archive" -C "$work"
result unpack_ms "$(($(now_ms) - start))"
app="$work/$name"
[ -x "$app/bin/mirador" ] || fail "$file has no executable $name/bin/mirador"
[ -x "$app/node/bin/node" ] || fail "$file has no executable $name/node/bin/node"
cd "$app"

start="$(now_ms)"
./node/bin/node src/doctor.ts || fail "doctor reports a required item missing (see above)"
result doctor_ms "$(($(now_ms) - start))"

unset DISPLAY WAYLAND_DISPLAY
start="$(now_ms)"
# Captured rather than run bare: a start that fails must still print the log (#57). Its own output
# is kept apart from its errors, so a warning never spoils the link extraction below.
errfile="$work/launch.err"
launched="$(bin/mirador 2>"$errfile")" || {
  cat "$errfile" >&2 || true
  fail "bin/mirador did not start the server"
}
cat "$errfile" >&2 || true
result start_ms "$(($(now_ms) - start))"
echo "$launched"
link="$(printf '%s\n' "$launched" | grep -o 'http://127\.0\.0\.1:[0-9]*/#launch=[A-Za-z0-9_-]*' | head -n 1 || true)"
[ -n "$link" ] || fail "bin/mirador printed no one-time link"
# `set -e` would end the run on its own with no smoke message (#57).
bin/mirador status || fail "bin/mirador status reports the server is not running"

# The page, then the session the link opens and the API behind it, as a browser would.
./node/bin/node -e '
  const link = new URL(process.argv[1]);
  const origin = link.origin;
  const check = async (what, response) => {
    if (!response.ok) throw new Error(`${what} answered ${response.status}: ${await response.text()}`);
    return response;
  };
  (async () => {
    const page = await check("GET /", await fetch(`${origin}/`));
    if (!(await page.text()).includes("<html")) throw new Error("GET / answered no HTML page");
    const nonce = link.hash.slice("#launch=".length);
    const session = await check("POST /api/session", await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    }));
    const { token } = await session.json();
    const boot = await check("GET /api/bootstrap", await fetch(`${origin}/api/bootstrap`, { headers: { authorization: `Bearer ${token}` } }));
    const body = await boot.json();
    if (!body.config || !body.workspaces) throw new Error(`GET /api/bootstrap answered ${JSON.stringify(body)}`);
    console.log("smoke: the server answers GET /, POST /api/session and GET /api/bootstrap");
  })().catch((error) => {
    console.error(`smoke: ${error.message}`);
    process.exit(1);
  });
' "$link" || {
  bin/mirador stop || true
  fail "the server does not answer (see above)"
}
bin/mirador stop
