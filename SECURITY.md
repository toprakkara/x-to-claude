# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, using **Report a vulnerability** on this repository's Security tab, rather than in a public issue. Include the steps to reproduce the problem and the impact you expect.

This is a small project maintained in spare time, so there's no guaranteed response time.

## What counts

x-to-claude passes text from X, written by strangers, into Claude Code sessions on your machine. These are the issues that matter most:

- A web page reaching the relay, reading its responses or obtaining its token.
- Post content escaping the delimited data block in a message.
- Post content reaching a shell command or a file path outside the archive folder.
- The archivist gaining access beyond its allow-list.
- Secrets being written to logs or to the archive.

## What doesn't count

Prompt injection can be reduced but not eliminated. A model following instructions in a post you chose to send to a session isn't a vulnerability in itself, unless it gets past one of the safeguards above. Choose carefully what you send to sessions with broad permissions, especially those running with `bypassPermissions` or `crossSessionInbound: "accept"`.

Anyone who can already run code as your user can read the relay's token. That's outside this project's threat model.
