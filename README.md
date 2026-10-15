# peer-mail

An omp extension that lets omp sessions on one machine message each other inside named swarms. A session that hasn't joined a swarm is isolated: it has no peer tools, and no one can message it.

## Commands

| Command | Does |
|---|---|
| `/startswarm [name] <prompt>` | Starts swarm `name` afresh, deleting its earlier members and mail; joins it; runs `<prompt>` |
| `/swarm [name] <prompt>` | Joins swarm `name` as it is now (starting it if it doesn't exist); runs `<prompt>` |
| `/swarm` | Shows this session's swarm and its members |
| `/swarm-leave` | Leaves the swarm; the session is isolated again |
| `/peer-name [name]` | Shows or changes this session's name in its swarm |

Without `[name]`, the swarm is named after the session's directory. Roles go in the prompt:

```text
(terminal 1)  /startswarm [project_fix_robot] You are the programmer. Fix the gripper timeout in src/arm.rs and ask the reviewer to check it.
(terminal 2)  /swarm [project_fix_robot] You are the reviewer. Review what the programmer sends you and reply with problems you find.
(terminal 3)  plain omp: isolated, can't see or be reached by the swarm
```

Members get `peer_list` and `peer_send`. A message shows up in the other member's conversation; if that session is idle it starts a turn, and if it's working it reads the message at its next step. Mail to a member that isn't running waits until a session rejoins under that name.

`/startswarm` begins a new phase. Sessions still in the old phase are told they are no longer in the swarm, lose their peer tools, and can't send or receive; `/swarm [name]` puts them in the new one.

Members are named `agent`, `agent-2`, … unless `PEER_MAIL_NAME` is set or `/peer-name` changes it.

## Install

```bash
cd ~/code/peer-mail && bun install
omp plugin link ~/code/peer-mail
```

New omp sessions load it; restart running ones.

## From a shell

```bash
bun src/cli.ts swarms                                   # swarms, members online, when started
bun src/cli.ts list project_fix_robot                   # members, online or not, mail waiting
bun src/cli.ts send project_fix_robot agent "status?"   # message a member as "human"
bun src/cli.ts history project_fix_robot agent          # what a member has received
```

## How it works

Everything is files under `~/.omp/peer-mail/swarms/<name>/` (`PEER_MAIL_DIR` moves the root):

| Path | Holds |
|---|---|
| `phase.json` | the current phase: id, who started it, when |
| `peers/<name>.json` | a member's phase, pid, directory and heartbeat (every 5 s; silent for 15 s means offline) |
| `inbox/<name>/<id>.json` | mail not yet received |
| `delivered/<name>/<id>.json` | mail received |

`/startswarm` deletes the directory and writes a new phase. Every member action checks its phase against `phase.json`, and peers and messages from another phase are ignored. Members check their inbox every second; a message is received by renaming it from `inbox/` to `delivered/`, so exactly one session gets it.

| File | Does |
|---|---|
| `src/transport.ts` | a swarm's mail directory: phases, members, send, receive, history |
| `src/inbox.ts` | one session's membership, and how a message reads to the agent |
| `src/extension.ts` | the omp extension: the commands, mail delivery, and the peer tools |
| `src/cli.ts` | the shell command |

## Limits

- One machine: sessions on different machines don't see each other.
- Inside a swarm every member can message every other; isolation is by not joining.
- A message from another session is a request, not the user's instruction; the delivered text tells the agent so.
- `omp -p` runs have no slash commands, so they can't join.

## Development

```bash
bun test
bun run typecheck
```
