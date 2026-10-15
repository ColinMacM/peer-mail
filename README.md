# peer-mail

An omp extension that lets interactive omp sessions on one machine message each other.

Each interactive session (the TUI, or `--mode rpc`) joins under a name and gets two tools:

- `peer_list`: who has joined, whether they are running, and their directories.
- `peer_send`: send a message to a session by name, or to `all`.

A message shows up in the other session's conversation. If that session is idle it starts a turn; if it is working it reads the message at its next step. Mail to a session that isn't running waits until a session joins under that name again. `omp -p` runs don't join.

## Install

```bash
cd ~/code/peer-mail && bun install
omp plugin link ~/code/peer-mail
```

New omp sessions load it; restart running ones.

## Names

A session is named after its directory, with `-2`, `-3`… added when that name is already taken by a running session. To choose:

- `PEER_MAIL_NAME=reviewer omp`
- `/peer-name reviewer` inside a session (mail still waiting for the old name comes along)

## From a shell

```bash
bun src/cli.ts list                         # sessions, online or not, and mail waiting
bun src/cli.ts send reviewer "check the diff in ~/code/foo"   # sent as "human"
bun src/cli.ts history reviewer             # what a session has received
```

## How it works

Everything is files under `~/.omp/peer-mail` (`PEER_MAIL_DIR` to change it):

| Path | Holds |
|---|---|
| `peers/<name>.json` | a session's pid, directory and heartbeat (every 5 s; silent for 15 s means offline) |
| `inbox/<name>/<id>.json` | mail not yet received |
| `delivered/<name>/<id>.json` | mail received |

Each joined session checks its inbox every second. A message is received by renaming it from `inbox/` to `delivered/`, so exactly one session gets it.

| File | Does |
|---|---|
| `src/transport.ts` | the mail directory: join, heartbeat, send, receive, history |
| `src/inbox.ts` | one session's membership, and how a message reads to the agent |
| `src/extension.ts` | the omp extension: joins on start, delivers mail, registers the tools and `/peer-name` |
| `src/cli.ts` | the shell command |

## Limits

- One machine: sessions on different machines don't see each other.
- No permissions: any session can message any other.
- A message from another session is a request, not the user's instruction; the delivered text tells the agent so.

## Development

```bash
bun test
bun run typecheck
```
