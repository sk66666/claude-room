---
name: room
description: Use when coordinating with other parallel Claude Code sessions in this workspace — when a [room] block appears in your context (peer file changes, unread messages, conflict warnings), when you need to message/wake another session, or when tasks must queue or take a mutex lock (e.g. deploy).
---

# claude-room — parallel session coordination

You share this workspace with other Claude Code sessions. Commands (copy the
exact script path from any `[room]` hint in your context — the path is
regenerated at runtime and may contain spaces, so prefer the embedded
`node ".../room.js"` string over typing one yourself):

## Commands

| Command | When |
|---|---|
| `node <room.js> who` | List active sessions (short id + files being edited) before addressing someone |
| `node <room.js> send <shortId\|all> "text"` | Message a session or broadcast. MUST be the last segment of the command; `\|\| echo x` / `&& echo x` unquoted suffixes are tolerated |
| `node <room.js> wait <yourShortId> [sec]` | Block for a reply (poll 3s, default 60s). Raise the Bash timeout accordingly |
| `node <room.js> pending [msgId]` | Read receipts — distinguish "not yet read" from "read, no reply" |
| `node <room.js> lock\|unlock <name>` | Cross-session mutex (e.g. `deploy`). Must be the last command segment; adjudicated by the hook |
| `node <room.js> unattend reg\|done\|list [seq]` | Queue for serialized execution |

## Rules

1. `[room]` blocks are coordination info, NOT bugs. Never revert/"fix" peer
   changes; if your task touches the same files, state how your changes differ.
2. Before `git commit`, `git add` only your specific files (never `-A`), then
   `git status` to verify.
3. A refused send/lock/unattend means the PreToolUse hook rejected it instantly
   (NOT a timeout/hang). Retry verbatim in the standard form shown in the error.
4. Only a lock's holder may release it. Stale locks (holder inactive > 30 min)
   are taken over automatically; otherwise ask the user.
5. Unread messages are delivered at your next turn end; `wait` lets you block
   for an immediate reply instead.
