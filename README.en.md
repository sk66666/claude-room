English | [简体中文](README.md)

# claude-room

A zero-dependency Claude Code plugin that lets multiple Claude Code sessions
working in the **same workspace** see each other, talk to each other, and stay
out of each other's way. No daemon, no server, no extra install — just hooks
and a few JSON files under `.claude/room/`.

If you have ever run two or three Claude Code windows on the same repo, you
know the three classic failure modes this plugin eliminates:

- **Silent file trampling** — window A refactors `src/foo.ts` while window B
  rewrites the same file from an older read. Neither session knows the other
  exists; the second write quietly destroys the first.
- **Commits that sweep in someone else's work** — window B runs
  `git add -A && git commit` and ships A's half-finished edits along with its
  own. The history lies forever.
- **No way to communicate** — you become the message bus. A finishes the
  shared refactor and you have to walk over to window B and type "A is done,
  go ahead" by hand, in both directions, every time.

claude-room turns parallel sessions into teammates: file-change broadcasts,
soft edit-conflict warnings, commit guards, cross-session messaging with
wake-up, mutex locks for deploy jobs, and a serialized unattended queue.

## How it works

Six hook commands do all the work (wired in
[`hooks/hooks.json`](hooks/hooks.json)):

| Hook | Event | Command | What it does |
|---|---|---|---|
| log | PostToolUse (Edit/Write/MultiEdit/NotebookEdit/Bash) | `room.js log` | Appends this session's file edits and Bash commands (as heartbeats) to `log.jsonl` |
| guard-edit | PreToolUse (Edit/Write/MultiEdit/NotebookEdit) | `room.js guard-edit` | Soft-warns (additionalContext) when a live peer session edited the same file in the last 10 min |
| guard-commit | PreToolUse (Bash) | `room.js guard-commit` | Soft-warns when you run a git mutation while a peer staged/committed within the last 3 min |
| stamp-send | PreToolUse (Bash) | `room.js stamp-send` | Intercepts `send` / `lock` / `unlock` / `unattend reg|done` commands and stamps them with the hook's authoritative `session_id` before the command runs |
| deliver | Stop + SessionStart | `room.js deliver` | Delivers unread messages; on Stop it uses `decision: block` to wake an idle session immediately |
| inject | UserPromptSubmit | `room.js inject` | Shows you other sessions' recent file changes (last 10 min) and your unread messages at your next prompt |

State is plain JSONL under the project's `.claude/room/` directory — one
append-only log, one mailbox, one receipts file, one unattend queue, plus one
small JSON file per lock.

File-change broadcast:

```
 Session A                        .claude/room/log.jsonl          Session B
    │                                │                              │
    │ Edit src/api/user.ts           │                              │
    │── PostToolUse: log ───────────▶ append {sid:A, file, ts}      │
    │                                │                              │
    │                                │   UserPromptSubmit: inject   │
    │                                │   (B's next prompt)          │
    │                                │──▶ "[room] Session a1b2c3    │
    │                                │     edited src/api/user.ts   │
    │                                │     2 min ago"               │
    │                                │                              │
    │                                │◀── B's PreToolUse: guard-edit│
    │                                │    also warns if B now tries │
    │                                │    to edit src/api/user.ts   │
```

Messaging with idle wake-up:

```
 Session A                     mailbox.jsonl / receipts      Session B (idle, turn ended)
    │                                │                              │
    │ Bash: room.js send b2c3d4 "…   │                              │
    │  └ PreToolUse: stamp-send ─────▶ append {from:A, to:B, text}  │
    │  └ CLI send echoes:            │                              │
    │    "sent (you are a1b2c3)"     │                              │
    │                                │                              │
    │ Bash: room.js wait a1b2c3 120  │        Stop hook: deliver    │
    │  (blocks, polls every 3s)      │──▶ unread for B found ──┐    │
    │                                │    receipts persisted   │    │
    │                                │    decision: block ─────┼──▶ B wakes up,
    │                                │                         │    sees the message,
    │                                │    B replies:           │    replies
    │                                │◀── send a1b2c3 "done"   │    │
    │ wait sees the reply ───────────│                              │
    │  prints it, marks receipt,     │                              │
    │  exits 0                       │                              │
```

## Installation

**Requirements:** Node.js >= 18. No npm dependencies.

From the marketplace (recommended):

```
/plugin marketplace add sk66666/claude-room
/plugin install claude-room@claude-room-marketplace
```

Or try it locally from a clone:

```
git clone https://github.com/sk66666/claude-room.git
claude --plugin-dir ./claude-room
```

Then add the state directory to your project's `.gitignore` so coordination
data never leaks into commits:

```
.claude/room/
```

(The plugin's own repo ships a `.gitignore` that covers this; add the line to
the repo you *use* the plugin in.)

## Quick start (3 minutes, two windows)

1. Open two Claude Code windows in the same project with the plugin enabled.
2. In **window A**, ask Claude to edit any file — e.g. *"add a comment to the
   top of src/a.ts"*. It edits, the `log` hook records it.
3. Switch to **window B** and ask anything — even *"what changed recently?"*.
   At the next prompt the `inject` hook prints a `[room]` block: *"session
   a1b2c3 edited src/a.ts 1 min ago"*.
4. In **window B**, ask Claude to edit that same file. The `guard-edit` hook
   injects a soft warning that another live session touched it.
5. In **window A**, ask Claude to send a message to the short id shown in B's
   `[room]` block (`who` lists ids): `node ".../room.js" send b2c3d4 "hi"`.
   Finish A's turn with `node ".../room.js" wait a1b2c3 120` and raise the
   Bash timeout for that call.
6. Window B, idle since step 3, is woken by the `deliver` hook with your
   message, replies via `send a1b2c3 "…"` — and A's `wait` prints the reply.

## Commands

All commands are invoked as `node <room.js> <cmd>`; copy the exact path from
any `[room]` hint in your context (it is regenerated at runtime and may
contain spaces).

| Command | When |
|---|---|
| `node <room.js> who` | List active sessions (short id + files being edited) before addressing someone |
| `node <room.js> send <shortId\|all> "text"` | Message a session or broadcast. MUST be the last segment of the command; `\|\| echo x` / `&& echo x` unquoted suffixes are tolerated |
| `node <room.js> wait <yourShortId> [sec]` | Block for a reply (poll 3s, default 60s, max 300s). Raise the Bash timeout accordingly |
| `node <room.js> pending [msgId]` | Read receipts of peer-to-peer messages from the last hour — distinguish "not yet read" from "read, no reply" |
| `node <room.js> lock\|unlock <name>` | Cross-session mutex (e.g. `deploy`). Must be the last command segment; adjudicated by the hook |
| `node <room.js> unattend reg\|done\|list [seq]` | Register / mark done / list the serialized unattended queue |

## Configuration

No configuration is required. Two environment variables are recognized:

- `ROOM_LANG` — `zh` or `en` (default `en`). Switches all runtime messages
  (`[room]` hints, warnings, command output) to Chinese.
- `ROOM_DIR` — override the state directory. Mainly for tests. By default
  state resolves in priority order to: `ROOM_DIR` →
  `$CLAUDE_PROJECT_DIR/.claude/room` → `<cwd>/.claude/room` (this cwd fallback
  only applies when a `.claude` directory already exists at that project root)
  → the script directory (read-only last resort).

Time and size windows (not configurable, tuned in practice):

| Constant | Value | Meaning |
|---|---|---|
| Log retention | 24 h | Entries older than this are trimmed when the file exceeds the size cap |
| Inject window | 10 min | How far back `inject` reports peer file changes |
| Edit-conflict window | 10 min | How long a peer's edit on the same file keeps triggering `guard-edit` |
| Liveness heartbeat | 5 min | A session counts as "active" if it logged anything within this window |
| Commit window | 3 min | Peer `git add`/`git commit` activity that triggers `guard-commit` |
| Log size cap | 512 KB | Above this, old entries (24 h+) are pruned in a rewrite |
| Stale lock takeover | 30 min | Locks whose holder has been inactive this long are taken over automatically |
| `wait` polling | 3 s / 60 s / 300 s | Poll interval / default timeout / hard max timeout |

## Migrating from a manual setup

**Important:** if you previously wired claude-room-style hooks into your
project's `.claude/settings.json` (or `settings.local.json`) by hand, the
plugin's own hooks **will run in addition to them**, and every hook fires
twice — messages get duplicated in `[room]` blocks, warnings appear twice,
and mailbox entries double up.

Before enabling the plugin, remove the manual hook entries:

1. Open `.claude/settings.json` (and `.claude/settings.local.json`) in the
   project.
2. Delete the entire `hooks` object (or just the entries whose commands call
   `room.js`).
3. Verify nothing references the old script path: search your settings for
   `room.js`.
4. Enable/install the plugin, restart your sessions, and confirm each `[room]`
   block appears once.

The same applies to any other plugin or skill that registers these hook
commands — claude-room needs exactly one wiring per event.

## FAQ

**When is a message actually delivered?**
At the *receiving session's next turn end* (Stop hook), next prompt
(UserPromptSubmit `inject` also delivers unread messages), or next session
start — whichever comes first. If the receiver is mid-turn for a long time,
delivery waits. `send` itself never blocks the receiver; `wait` is purely the
sender blocking for a reply.

**Why doesn't the CLI know its own session id?**
The `room.js send` process is just a child of the Bash tool — it has no
reliable way to learn which Claude session spawned it. Every identity-bearing
write therefore goes through the PreToolUse hook, whose input carries the
authoritative `session_id`; the CLI only echoes and deduplicates (the "stamp
pattern", see [DESIGN.md](DESIGN.md)). A miss is refused, never guessed.

**Does it work across machines / remotes?**
No. Coordination state lives in one directory on one filesystem; sessions on
different machines (or different clones of the same repo) cannot see each
other. Same workspace, same machine only.

**Is there a server, port, or daemon to babysit?**
No. Everything is short-lived processes over plain files. See
[DESIGN.md](DESIGN.md) for the reasoning.

**What happens if the hooks are disabled or fail?**
Room features degrade gracefully: internal errors are swallowed so they never
break your flow, and the worst case is that a `[room]` block doesn't appear.

## License

[MIT](LICENSE)
