# Contributing

Issues and pull requests are welcome. For anything large, please open an issue first so we can agree on the approach.

## Getting started

You need macOS and Node 20 or later. There's nothing to install:

```bash
npm test
```

The tests use fake inbox sockets in a temp folder and never touch your real Claude sessions or `~/.claude`.

To try a relay change against your own setup, run `npm run launchd:restart`. To try an extension change, reload it from the extensions page and refresh x.com. Extension UI changes can also be tried on `test/fixtures/x-dom.html`; the [README](README.md#development) explains how.

## Guidelines

- **No runtime dependencies.** The relay and extension use only Node's standard library and browser APIs. This keeps a tool that handles a local token easy to audit.
- **Add a test** for any behavior change in the relay, hooks or scripts.
- **Treat post content as untrusted.** Anything from X must stay inside the delimited data block in messages, and must never reach a shell command or file path unvalidated.
- **Keep the relay local.** It must keep listening only on 127.0.0.1 with the token, Origin and Host checks in place.
- **The hooks must never disturb a session.** They swallow every error and exit with code 0.
- **Note undocumented behavior.** If you rely on Claude Code internals, say in a comment which version you verified, and add it to the Limitations section of the README.
- **Keep personal data out of the repository**, including tokens, real posts or DMs, and local paths in test fixtures.

If the on-disk archive format changes, update `templates/archive/` as well, because the archivist's instructions describe that format.
