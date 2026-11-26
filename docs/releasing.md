# Releasing

For maintainers. A release is a tag, a set of prebuilt Linux archives on a GitHub release, and a promotion PR
that pins that release in `scripts/bootstrap.sh`. Nothing reaches users until all three are done: the
workflow only creates a draft, a maintainer publishes it by hand, and the one-line install keeps installing the
previous release it pins until the promotion PR is merged (with no release pinned, every platform installs
from source).

## What the release workflow builds

`.github/workflows/release.yml` runs on a pushed `v*` tag, or by hand (**Actions › release › Run workflow**).
Its `build` job makes one archive per architecture, each on a GitHub-hosted runner of that architecture:

| Archive | Runner |
|---------|--------|
| `mirador-<version>-linux-x64.tar.gz` | `ubuntu-24.04` |
| `mirador-<version>-linux-arm64.tar.gz` | `ubuntu-24.04-arm` |

Each archive is one folder, `mirador-<version>-linux-<arch>/`, holding:

- Mirador's committed sources as they are (`bin/`, `src/`, `public/`, `docs/`, `package.json`, the lockfile and
  the license files). Nothing is bundled or compiled: the server runs its TypeScript with Node, as from a clone.
- `node/bin/node`, the official Node binary (`NODE_VERSION` in the workflow), fetched from nodejs.org and
  checked against the sha256 pinned beside `NODE_VERSION` for its architecture (`NODE_SHA256_LINUX_X64`,
  `NODE_SHA256_LINUX_ARM64`; `scripts/release/fetch-node.sh`). The `SHASUMS256.txt` nodejs.org serves at
  the same moment is not trusted: whoever could swap the tarball could swap it too. `bin/mirador` runs the
  bundled Node before any Node on `PATH` or from mise.
- `node_modules` with the lockfile's production dependencies, installed with no install scripts. `node-pty` is
  then built from its sources inside an AlmaLinux 8 container (`BUILD_IMAGE`, glibc 2.28, Node 24's own minimum),
  so the archive runs on any Linux with glibc 2.28 or newer. The build checks that the addon needs no newer
  glibc and that, in that container, the bundled Node loads it, opens a terminal with it and runs esbuild
  (`scripts/release/build-linux.sh`, `scripts/release/build-in-container.sh`,
  `scripts/release/check-glibc.sh`). The other platforms' prebuilds are left out.

The `smoke` job then checks each archive on a runner of its architecture (`scripts/release/smoke.sh`). It
unpacks the archive in clean containers, with no Node, pnpm or compiler and no network: the bare
`BUILD_IMAGE` (AlmaLinux 8, glibc 2.28, the oldest glibc supported) and `CURRENT_IMAGE` (Debian 13), both
pinned by digest. In each it runs the archive's doctor, starts the server with `bin/mirador`, checks that it
answers the page, the one-time link's session and the API, and stops it
(`scripts/release/smoke-in-container.sh`). The job summary shows each archive's size and, per container, how
long the unpack, the doctor and the server start took. The same script runs locally, with docker, on an
archive that `build-linux.sh` wrote:

```sh
sh scripts/release/smoke.sh dist/mirador-0.2.0-linux-x64.tar.gz "$BUILD_IMAGE" "$CURRENT_IMAGE"
```

The `publish` job waits for both builds, both smoke checks and the approval of the `release` environment.
Then it writes `SHA256SUMS`, attests the build provenance of each archive, and creates a **draft** release
with the archives, `SHA256SUMS` and, in its notes, the lines the promotion PR pins. It never publishes the
release.

The `build` and `smoke` jobs can only read the repository and use no secrets; only `publish` can write
releases and attestations.

## Before the first release

- Create the `release` environment (**Settings › Environments**) with the owner as required reviewer, and limit
  its deployments to tags matching `v*`. Do this before any tag is pushed: a job that names an environment
  that does not exist creates it, with no reviewer.
- Decide whether to turn on immutable releases (**Settings › General › Releases**). Once a release is published
  they lock its assets and its tag, so an archive whose sha256 is pinned in `scripts/bootstrap.sh` can never be
  swapped. A mistake in a published release's files then needs a new version number; a release published on
  the wrong tag does not (see [A release published on the wrong tag](#a-release-published-on-the-wrong-tag)).
  Drafts can still be edited.

## Cutting a release

1. In a PR to main, set the new version in `package.json` and turn the `Unreleased` section of `CHANGELOG.md`
   into that version's section. Merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.2.0 <merge-commit>
   git push origin v0.2.0
   ```

   The workflow stops at once if the tag is not `v<major>.<minor>.<patch>`, optionally with a pre-release
   suffix such as `-rc.1`, or differs from `package.json`
   (`scripts/release/check-tag.sh`). To run it by hand instead, pick the tag under **Use workflow from** and
   give the same tag as input.
3. When both builds and both smoke checks pass, read the smoke job's summary (sizes and timings), then
   approve the `publish` job of the `release` environment.

## Reviewing the draft

On the draft release (**Releases**), before publishing it:

1. Download both archives and `SHA256SUMS` into an empty folder, and check them:

   ```sh
   sha256sum -c SHA256SUMS
   gh attestation verify mirador-0.2.0-linux-x64.tar.gz -R mata-2p/mirador
   gh attestation verify mirador-0.2.0-linux-arm64.tar.gz -R mata-2p/mirador
   ```

2. Check the draft's tag. This must print the version's tag, `v0.2.0`, not `untagged-…`:

   ```sh
   gh release view v0.2.0 -R mata-2p/mirador --json tagName --jq .tagName
   ```

   `gh release view` finds a draft by its tag, and prints `release not found` (exit 1) when no release has
   that tag (both tested on a test draft, 2026-11-26). When it says `release not found`, the draft is on
   another tag: list the drafts' tags with
   `gh api repos/mata-2p/mirador/releases --jq '.[]|select(.draft)|{id,name,tag_name}'`. A draft creates its
   tag only when it is published: a draft published on `untagged-…` creates that tag, and
   `scripts/bootstrap.sh` cannot download from it. Check it again after every edit of the draft.

   A draft's page URL (`url` in `gh release view`, `html_url` in the API) always ends in
   `releases/tag/untagged-<hex>`, even when its tag is right, and the hex changes after an edit. That URL is
   not the check: only `tag_name` tells which tag the draft will publish on.

   On the web, a healthy draft shows its tag and its commit under the title, and its edit page says
   **Tag: v0.2.0 — Existing tag**. The broken 0.2.0 draft showed no tag.
3. The smoke job already unpacked each archive in clean containers (the oldest glibc supported and a
   current distribution), ran its doctor and started its server. To try one by hand as well, unpack it on a
   clean Linux system with no Node, pnpm or compiler and run `node/bin/node src/doctor.ts`, then
   `bin/mirador`.
4. The first release with archives is shown to the owner as a draft, before anyone publishes it.
5. Publish it: **Edit › Publish release**.

Edit a draft's notes with `gh release edit … --notes-file`. It keeps the draft's `tag_name` (tested on a test
draft, 2026-11-26: `tag_name` stayed the same, and the notes matched the file byte for byte, CRLF line ends
included):

```sh
gh release edit v0.2.0 -R mata-2p/mirador --notes-file notes.md
```

Never edit them with a REST API `PATCH` that sends only `body`: it resets a draft's tag to its `untagged-…`
placeholder, and publishing the draft then creates that tag. If a `PATCH` cannot be avoided, send `tag_name`
with it, then read `tag_name` again (`gh api repos/mata-2p/mirador/releases/<id> --jq .tag_name`).

## Release candidates

A release candidate (`0.2.0-rc.1`) goes through the same steps, with three differences, plus one rule for the
final version:

- The workflow creates its draft as a pre-release, because the tag has a pre-release suffix, so the releases
  page keeps the last stable release as **Latest**. Before publishing, check that the edit page's
  **Release label** group has **Pre-release** selected, not **None** or **Latest**. The label stays editable
  after publishing.
- With immutable releases on, a published candidate's tag and assets cannot change and its tag name cannot be
  used again, even after the release is deleted: a fix ships as the next candidate (`-rc.2`).
- No promotion PR: `scripts/bootstrap.sh` in main never pins a candidate. To try the install end to end, run a
  local copy of `bootstrap.sh` whose three pin lines carry the candidate's version and sums, in a clean
  container, as an ordinary user with a scratch home.
- When the final version is cut, its `CHANGELOG.md` section folds in the candidates' sections and reads complete
  against the previous stable version, with one line that names the candidates. The release workflow does not
  read `CHANGELOG.md`: its notes carry only `SHA256SUMS`, the attestation command and the pin lines.

## The promotion PR

Once the release is published, check that `https://github.com/mata-2p/mirador/releases/download/v<version>/SHA256SUMS`
answers 200: the installer downloads from `releases/download/v<version>/`. Then a PR to main pins it in
`scripts/bootstrap.sh`: it replaces the three pin lines at the top of `main`, which carry the previous
release's version and sums (all three empty while no release is pinned),

```sh
  MIRADOR_VERSION="<previous version>"
  MIRADOR_SHA256_LINUX_X64="<its linux-x64 sha256>"
  MIRADOR_SHA256_LINUX_ARM64="<its linux-arm64 sha256>"
```

with the lines in the new release's notes (`scripts/release/pins.sh` prints them from `SHA256SUMS`), and changes
nothing else. Check each sha256 against the published `SHA256SUMS`. Leaving a platform's sha256 empty keeps
that platform on the install from source. From the merge on, `curl … bootstrap.sh | sh` installs that release
on Linux x64 and arm64.

The checksum the installer trusts comes from this reviewed change to main, not from the release that serves the
archive: someone who could replace an archive on the release still could not make the installer accept it.

## A release published on the wrong tag

The symptom: the published release is on a tag named `untagged-<hex>`, which publishing created at the tip of
main, instead of `v<version>`; `v<version>` has no release, and `releases/download/v<version>/…`, which
`scripts/bootstrap.sh` downloads from, answers 404. It happened with 0.2.0, after the draft's notes were edited
with a `PATCH` that sent only `body` (see [Reviewing the draft](#reviewing-the-draft)).

With immutable releases on, a published release's files and tag are locked, so it cannot be moved to
`v<version>`; its title, notes and **Release label** stay editable, and it can still be deleted (step 4).
A tag that never had an immutable release can still get one, so `v<version>` ships with the same files and
no new version number:

1. Download the wrong release's three files into a fresh temporary folder, and check them:

   ```sh
   cd "$(mktemp -d)"
   gh release download untagged-<hex> -R mata-2p/mirador
   sha256sum -c SHA256SUMS
   gh attestation verify mirador-<version>-linux-x64.tar.gz -R mata-2p/mirador
   gh attestation verify mirador-<version>-linux-arm64.tar.gz -R mata-2p/mirador
   ```

   The attestations stay valid: they name the archives' sha256 and the workflow run on `refs/tags/v<version>`,
   not the release.
2. Create a draft on `v<version>` with those three files, the same title, and the notes in `notes.md` (the
   wrong release's notes, from `gh release view untagged-<hex> -R mata-2p/mirador --json body --jq .body`,
   changed where needed). `--verify-tag` stops it when `v<version>` is not on GitHub, instead of creating the
   tag:

   ```sh
   gh release create v<version> -R mata-2p/mirador --draft --verify-tag --title "Mirador v<version>" \
     --notes-file notes.md \
     mirador-<version>-linux-x64.tar.gz mirador-<version>-linux-arm64.tar.gz SHA256SUMS
   ```

3. Review it as in [Reviewing the draft](#reviewing-the-draft), its tag included, then publish it with
   **Latest** selected under **Release label**.
4. Delete the release on the wrong tag, then its `untagged-<hex>` tag. For 0.2.0 both were deleted on the
   web: first the release, from its page, then the tag, from the **Tags** tab. GitHub allowed both although
   the release was immutable. **Delete tag** is disabled while the tag has a release, so the release goes
   first. The same in one command, a path that was not tested:

   ```sh
   gh release delete untagged-<hex> -R mata-2p/mirador --cleanup-tag
   ```

   Under immutable releases, the name of a deleted release's tag can never be used again. Nothing uses
   `untagged-<hex>`, so that does not matter.
5. Check that `releases/download/v<version>/SHA256SUMS` answers 200, and that no `untagged` release or tag
   remains (the last two print nothing):

   ```sh
   curl -sSL -o /dev/null -w '%{http_code}\n' https://github.com/mata-2p/mirador/releases/download/v<version>/SHA256SUMS
   gh release list -R mata-2p/mirador --json tagName --jq '.[].tagName | select(startswith("untagged"))'
   git ls-remote --tags https://github.com/mata-2p/mirador.git 'untagged*'
   ```

Then the promotion PR goes ahead as usual.

## Updates and Node security releases

The one-line install checks for no updates, and Mirador makes no update check either. Users update by running
the line again, which adds the pinned version beside the ones they have and points `current` at it.

The archives bundle Node, so a Node security release means a Mirador release. Upgrading Node is changing
three lines of `.github/workflows/release.yml` together, in a reviewed PR: `NODE_VERSION` and the two sums
beside it, `NODE_SHA256_LINUX_X64` and `NODE_SHA256_LINUX_ARM64`. A build whose tarball does not match its
pinned sum stops before building anything.

Read the two sums from that version's `SHASUMS256.txt`, and check its signature with the Node.js release keys
first, in an empty folder and a scratch keyring:

```sh
v=24.22.3   # the new NODE_VERSION
curl -fsSLO "https://nodejs.org/dist/v$v/SHASUMS256.txt"
curl -fsSLO "https://nodejs.org/dist/v$v/SHASUMS256.txt.sig"
export GNUPGHOME="$(mktemp -d)"
# The fingerprints listed under "Release keys" in https://github.com/nodejs/node#release-keys:
gpg --keyserver hkps://keys.openpgp.org --recv-keys <fingerprint> ...
gpg --verify SHASUMS256.txt.sig SHASUMS256.txt
grep -E 'linux-(x64|arm64)\.tar\.xz$' SHASUMS256.txt
```

`gpg --verify` must say `Good signature` from a key whose fingerprint is in that list (the warning that the
key is not certified is expected in a scratch keyring). The `linux-x64` line's sum goes in
`NODE_SHA256_LINUX_X64`, the `linux-arm64` line's in `NODE_SHA256_LINUX_ARM64`. Then cut a patch release and
promote it as above.
