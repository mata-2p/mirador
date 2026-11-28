# Security model

What the local server accepts and the limits that remain. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Security

The server can start shells, so it only accepts:

- connections on `127.0.0.1`, with a `Host` header naming that listener (blocks DNS rebinding);
- API calls carrying a session token in an `Authorization` header (WebSockets offer it as a subprotocol). There is no cookie: cookies are shared by every port on `127.0.0.1`, so any local server you visit would receive one;
- a session token obtained only by trading a launch nonce: the launcher reads the launch secret from `$XDG_RUNTIME_DIR/mirador/state.json` (mode 0600, new on every start), asks the server for a nonce, and opens the window at `/#launch=<nonce>`. The nonce works once and expires 60 seconds after the launcher asks for it, so seeing it later in the browser command line or history grants nothing;
- state-changing requests and WebSockets whose `Origin` is the app itself;
- folders (tree, terminals, summaries) that resolve, after symlinks, inside the root of the workspace named in the request.

Every response forbids framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), so a page on another local port cannot overlay the app. Memory text is rendered with `textContent` only, never as HTML.

Known limits (each needs a process already running as you):

- Attention reports come from the terminal's own processes through the inherited `HERDR_*` variables, so any program in an agent terminal can change what the inbox says about that terminal. The bridge's and gentle-shell's sources always keep their slot, a `seq` far past the clock is refused, and their next report replaces a source someone pushed ahead of the clock, but a process that keeps reporting can still override what they last said.
- Hard links: the editor checks paths after symlinks, but a hard link inside the root to a file outside it reads and saves that file; a path cannot tell a hard link apart.
- Between resolving a file and opening it, a folder in its path could be swapped for a symlink. Reads open the file itself without following a symlink (`O_NOFOLLOW`) and a save resolves the file again just before writing, which narrows that window without closing it.
- A workspace whose root is `/` puts every folder of the machine inside its root guard.
- The runtime folder (`$XDG_RUNTIME_DIR/mirador`, or `~/.cache/mirador` without `XDG_RUNTIME_DIR`) is per user, not per Mirador: every Mirador you start shares it and its herdr socket folder, and any of your processes can read it.

## What stays on the machine

Zero telemetry, no accounts; the server listens on `127.0.0.1` only. That is Mirador, not the agents running inside it: Claude Code, pi or any other agent still talks to its own provider. In the full mode the night shift and **Improve with AI** send their prompts to Claude through pi, and the night shift writes to a Telegram bot only once you connect your own. For **Where it left off**, Mirador keeps your last message to Claude Code, its last answer and its compaction summary in plaintext under `~/.local/state/mirador/left-off/` (0600, 30 days by default, `leftOff: false` turns it off); they are never sent anywhere ([details](attention.md#where-it-left-off)).

Mirador runs `opencode --version` only when an action of yours needs it: the first time you open, wake or restore an opencode agent in a server's life (the restore at start only when there are opencode agents to reopen), and in `mirador doctor` (which `install.sh` runs at the end). It never runs it at start otherwise, and the agent list does not run it. That command is whatever `opencode` you installed, so it may use the network depending on how opencode is installed: a `pnpm dlx` or `npx` wrapper, for example, may download opencode first ([details](extending.md)).

## Opening Mirador from another machine

The server listens on `127.0.0.1` only, and that does not change. To use a Mirador that runs on one machine (the host) from the browser of another (the client), forward its port through an SSH tunnel. Read the risks below first: the tunnel gives the client a way into terminals on the host.

1. On the client, open the tunnel and leave it running:

   ```sh
   ssh -N -L 127.0.0.1:4545:127.0.0.1:4545 you@host
   ```

   Use the same port number on both ends. The server accepts only a `Host` header naming its own listener (`127.0.0.1:<port>` or `localhost:<port>`), so a forward to another local port, such as `-L 127.0.0.1:8080:127.0.0.1:4545`, is refused with `421 unexpected host`. When the client runs its own Mirador on `4545`, give the host's Mirador another `port` in its config, such as `4546`, restart it, and forward `127.0.0.1:4546:127.0.0.1:4546`.

2. In a second SSH session on the host, without `-X` or `-Y`, run `mirador`. With no display it starts the server if needed and prints the one-time link, `http://127.0.0.1:4545/#launch=…`. Open that link in the client's browser within 60 seconds. It signs in one browser tab, once; run `mirador link` on the host for a new link. This works on a Linux host. On macOS, and on WSL2 with a Windows browser to open, `mirador` opens its window on the host and prints no link; `mirador link` prints one there too.

The session token, the `Host` check and the `Origin` check work as on one machine, because the browser still talks to `127.0.0.1`. The token is what keeps other processes out, and the launch secret behind it stays in the host's runtime folder.

Risks:

- Anyone with a shell on either end can reach the forwarded port. On the client, every process and every user of the machine can connect to `127.0.0.1:4545` while the tunnel is open, as they can on the host. They still need a session token, which lives in the client browser's tab.
- The panel gives full terminal access. A session can open shells on the host as you and read and save files in every workspace, so treat the client browser as a login to the host.
- Keep the forward bound to `127.0.0.1` on the client: write the `127.0.0.1:` before the local port, as above. Without it, a client whose SSH config sets `GatewayPorts` listens on every network interface.
- Never expose the port to a network: no `-g`, no `0.0.0.0` or `*` as the bind address, and no reverse proxy in front of Mirador. The server has no TLS and no login beyond the one-time link, and it was not built to face a network.
- Close the tunnel when you are done: stop the `ssh -N` with Ctrl+C. Closing the browser window does not end the forward, and the terminals keep running on the host.

### On a phone

The "Te esperan" inbox works in a phone's browser through the same tunnel. The phone needs an SSH client that can forward a local port; the server, its address and its checks stay exactly as above.

The phone inbox is experimental in 0.2.0. What was measured on an iPhone, and how to get out of **Reconectando… / Reconnecting…**, are in [The phone inbox is experimental](attention.md#the-phone-inbox-is-experimental).

1. In the phone's SSH client, forward the same port, bound to `127.0.0.1` on the phone:

   ```sh
   ssh -N -L 127.0.0.1:4545:127.0.0.1:4545 you@host
   ```

   In an app that sets up forwards in a form instead of a command line, that is a local forward from `127.0.0.1`, port `4545`, to `127.0.0.1`, port `4545`.

2. On the host, run `mirador link`. It prints only a fresh one-time link, `http://127.0.0.1:4545/#launch=…`, on one line, and opens no window. When Mirador is not running it prints `mirador: not running; start it with mirador first, then run mirador link` and exits 1, starting nothing.

3. Open that link in the phone's browser within 60 seconds. It works once and signs in that one tab; run `mirador link` again for a new one.

The phone gets the same session as any window: the `Host` and `Origin` checks, the 60-second single-use link and the session token apply to it as they do to the desktop, and it has the same full access. Other apps on the phone can connect to the forwarded port while the tunnel is up, but without a session token they get no API call and no terminal socket.

### A lost phone: sign out the other windows

A session lasts until Mirador restarts, or until 32 newer sessions push it out. A lost phone whose tab still holds one keeps that access. To end it from another window:

1. Open **Ajustes / Settings** (the sliders button at the top right).
2. Under **Otras ventanas / Other windows**, press **Cerrar sesión en las demás ventanas / Sign out the other windows** and confirm.

It clears every session except the one of the window you pressed it in, and says how many it cleared. Every other window and phone gets `401` at its next call, and what it has open stops at once: its terminal sockets close and its inbox stream ends, so no new card reaches it. It needs a new one-time link to come back. The terminals themselves keep running on the host. The action is `DELETE /api/session/others`, behind the same session token, `Host` and `Origin` checks as every other API call.

The fallback, when no signed-in window is at hand, is still **restarting Mirador**: `mirador stop && mirador` on the host. A restart forgets every session, this window's included, and makes a new launch secret, so no earlier link works either. The agents reopen at the next start, as after any stop.
