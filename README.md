# x-to-claude

Send a post from X to a Claude Code session running on your Mac with one click. Spec (in Turkish): [SPEC.md](SPEC.md).

```
Browser extension (x.com)  ──HTTP, token──▶  local relay (127.0.0.1:47615)  ──Unix socket──▶  Claude Code session
                                                   ▲
                               ~/.x-to-claude/sessions/*.json  ◀── SessionStart / SessionEnd hooks
```

The extension adds a button next to the bookmark button on every post:

- **Left click: save to the archive.** The relay asks Jev (TypeSafe's System One model) which archive category fits. If Jev picks an existing category with confidence ≥ 0.85, the relay writes the note itself. Otherwise the post goes to the archivist, a dedicated Claude Code session that decides and can open a new category. Saved posts show an orange button.
- **Right click (or Shift+Enter): send to a session.** Lists your live Claude Code sessions, from both the terminal and the desktop app. The post you pick goes to that session as a message, with its URL, author, date, text, any quoted post and media links.
- **Right click → "＋ Yeni oturum" (New session): discuss the post in a new Desktop session.** The relay runs the first turn in the background with all tools off, because the post is untrusted data: Claude summarises the post and asks what you want to do with it. The relay then opens the session in Claude Desktop with `claude://resume?session=<id>`; the session is named `X: @handle — …`. Code sessions need a folder, so these sessions live in an empty folder of their own (`newSession.dir`, default `~/_DEV/x-sohbet`). The link format was taken from `claude --desktop` in Claude Code 2.1.290; the relay can't call `claude --desktop` itself, because that command needs a terminal.

If Jev judges a saved post relevant to a configured topic (by default legal tech, for the `Method Path` session), the relay sends that session a short notice. The extension's UI text is in Turkish.

## Status

| Part | Status |
|---|---|
| Relay: `/sessions`, `/send`, token, Origin and Host checks, size and rate limits, a queue that merges rapid sends | Done, tested |
| Session registry hooks and installer | Done, tested |
| Browser extension: button, session menu, toast, options page | Done; tested end to end on the real x.com in Arc |
| Inbox socket message format (`relay/inbox.mjs`) | Verified on Claude Code 2.1.286; end-to-end delivery from the relay to a Claude Code session tested |
| Archive: `/save`, `/saved`, Jev classification, escalation to the archivist, topic notices | Done, tested with a stubbed Jev; Jev itself evaluated against 38 Claude-labelled posts |

The inbox socket's message line isn't documented. The format was taken from Claude Code 2.1.286 and may break in a later version.

## Setup

Requires Node 20+ and a Chromium-based browser (Chrome 116+, Arc). No external dependencies.

1. Start the relay and write its token into the extension folder (`extension/relay.json`, mode 0600, git-ignored):
   ```bash
   npm run relay
   ```
   ```bash
   npm run extension:config
   ```
2. Add the hooks to your user settings (`~/.claude/settings.json`; a backup is made first). To see what will be written, run `--dry-run` first:
   ```bash
   node scripts/install-hooks.mjs --dry-run
   ```
   ```bash
   npm run hooks:install
   ```
   Only sessions started or resumed **after** this step appear in the list.
3. Load the extension: open `chrome://extensions` (`arc://extensions` in Arc), turn on Developer mode, click "Load unpacked" and pick the `extension/` folder. The token is read from `relay.json`. To check the connection, click the extension icon and press "Bağlantıyı dene" (Test connection) on the options page.
4. Optional: copy the extension ID shown on the options page into the `extensionId` field of `~/.x-to-claude/config.json`. From then on the relay accepts requests only from this extension. An unpacked extension's ID is derived from its folder path, so moving the folder changes the ID.
5. Install the launchd agent so the relay starts at login and restarts if it crashes:
   ```bash
   npm run launchd:install
   ```
   Other commands:
   - `npm run launchd:status` shows the agent's state.
   - `npm run launchd:restart` restarts the relay after a code or `config.json` change.
   - `npm run launchd:uninstall` removes the agent.

   Logs go to `~/.x-to-claude/relay.log`. The agent uses the absolute path of the Node binary that was active at install time; if you switch Node versions with nvm, run the install again.

## Archive

The archive lives in its own folder (`archiveDir`, default `~/_DEV/x-arsiv`) with its own Claude Code session, the archivist. That folder holds:

- `CLAUDE.md` — the archivist's instructions;
- `kategoriler.md` — the categories, one `- slug — description` line each. The descriptions are also Jev's choice criteria;
- `gelen/` — incoming posts: `kuyruk.jsonl` from the button, imports, and hand-off lists;
- `plan/` — one classification line per post;
- `kutuphane/<category>/<date>-<handle>-<id>.md` — the notes, plus `_indeks.md`;
- `bildirimler.jsonl` — the topic notices the relay sent.

Notes are never written by hand. A plan line goes through `scripts/render-archive.mjs`, which writes or moves the note. The archivist runs in `dontAsk` mode with a narrow allow-list (`.claude/settings.json` in the archive folder): it can edit only `kategoriler.md`, `gunluk.md` and `plan/`, run only the note writer, and list and message sessions. It has no other shell access and no web access.

Start the archivist from the archive folder:

```bash
claude --name x-arsiv --permission-mode dontAsk --strict-mcp-config
```

The relay recognises the archivist by its working directory, not by name. You don't need to keep it open: when a save needs the archivist and none is running, the relay wakes it in the background. The relay runs `claude -p` in the archive folder, with the same `dontAsk` permissions and without MCP servers, and passes it the IDs still waiting in `gelen/kuyruk.jsonl`. The archivist classifies them and exits.

- Rapid saves are batched into one wake-up (10 s).
- A save that arrives during a run triggers one more run afterwards, if it is still waiting.
- A failed run blocks new wake-ups for 30 minutes.
- The relay also checks the queue at start-up and every 30 minutes.

Wake-ups are logged to `~/.x-to-claude/arsivci-uyandirma.log`. Settings live in `archivistWake` in `config.json`: `enabled`, `claudePath`, and `model` (`null` uses your default). You can still open the archivist yourself to talk to it; while it is open, the relay sends saves to it instead.

Jev's key (`OPENROUTER_API_KEY` or `TYPESAFE_API_KEY`) is read from `jevEnvFile` in `~/.x-to-claude/config.json`; it never goes into the config. Without a key every save goes to the archivist. Other settings: `jevThreshold` (0.85) and `notifyRoutes` (`name`, `topic`, `threshold`).

Scripts, run from the archive folder:

- `scripts/fetch-oembed.mjs` fetches post content from X's oEmbed endpoint. It is resumable.
- `scripts/jev-batch.mjs` classifies an import with Jev and writes a hand-off list for the archivist.
- `scripts/jev-eval.mjs` compares Jev's choices with the archivist's labels.

## Delivery rules

The relay isn't a child process of the target session and doesn't send an auth line. Claude Code therefore treats its messages as coming from another session that asserts no permission class:

- **Sessions that prompt for permissions** (default, auto, acceptEdits) deliver the message right away.
- **Sessions that bypass permissions** hold the message for approval:
  - In the terminal, an approval dialog opens.
  - The desktop app and VS Code can't show that dialog, so the message is dropped after 5 minutes.
  - To deliver to such sessions too, set `crossSessionInbound` to `"accept"`. This applies to every message from your other sessions, not only the relay's.
  - Tested: with `"accept"` in user settings, a relay running under launchd (not a child of any session) delivered to a desktop session in bypass mode. The setting took effect in the open session without a restart.

The relay's `ok` response only means the message was written to the socket. The socket sends no reply, so the relay isn't told when a message is held or dropped.

Each message carries a `session_id` field. If the socket has meanwhile passed to another session, Claude Code drops the message, so it never reaches the wrong session. This was tested too.

## Tests

```bash
npm test
```

The tests never touch real Claude sessions; they open their own fake inbox sockets in a temp folder. For the extension's DOM side there is `test/fixtures/x-dom.html`, which mimics X's markup and stubs `chrome.runtime`. Serve it with the `fixture` server in `.claude/launch.json`. Append `?mode=down|notoken|error` and `&theme=dark` to the URL to try the error states and the dark theme.

## Security

- The relay listens only on 127.0.0.1. Every request needs `X-Relay-Token`. An `Origin` header, if present, must be `chrome-extension://`. The `Host` header must be 127.0.0.1 or localhost, which guards against DNS rebinding. The relay sends no CORS headers.
- The token lives only in the extension's service worker and never reaches the x.com page.
- Post text travels between randomly generated delimiters, with a note saying it is data, not instructions.
- The relay never exposes a session's socket path. The hooks don't store the session token.

## Findings (2026-10-05)

- Desktop app sessions also open an inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/<pid>.sock`).
- Claude Code also records its sessions in `~/.claude/sessions/<pid>.json`, with name, cwd, status and `messagingSocketPath`. This is an undocumented internal format: it could replace the hooks but might break in a new version. The same folder also holds `.key` files. For now the project uses the documented route, the hooks.

## License

MIT. See [LICENSE](LICENSE).
