# claude-room — Design Notes

Why claude-room is built the way it is. These notes record not just the
current shape but the failures that shaped it; each section names the
incident that forced the decision.

## 1. Why files, not a daemon

The obvious architecture for cross-session coordination is a resident
process: a small server bound to a local port, sessions connecting over a
socket, messages pushed in real time. We rejected it deliberately.

A daemon brings a lifecycle nobody wants to manage: it must be started
before the first session and survives after the last one exits; a crashed
daemon silently kills all coordination while every session assumes it still
works; on developer machines it fights with sleep, reboots, and terminal
closures; and it needs port allocation and a security story for anything
listening on localhost. All of this to move messages that are, at human
pace, low-frequency and completely latency-tolerant.

Plain files give the same result with none of the machinery. The state
directory (`log.jsonl`, `mailbox.jsonl`, `receipts.jsonl`,
`unattend.jsonl`, `lock-*.json`) lives under the project's
`.claude/room/`, resolved at runtime from `ROOM_DIR` or
`$CLAUDE_PROJECT_DIR` — never inside the plugin install dir, which is
shared across projects. Every hook invocation and CLI call is a short-lived
Node process that reads and appends. Nothing to start, nothing to monitor,
nothing to crash: if no process is running, the state is simply at rest and
the next process picks it up.

The one thing a daemon would buy — true push delivery — is approximated
with the Stop hook's `decision: block` wake-up (see §6), which covers the
case that actually matters: waking a session that has gone idle.

The cost is that concurrent writers must be disciplined. That discipline is
§3.

## 2. The stamp pattern

The hardest identity problem in this design: **a CLI process cannot know
which Claude session spawned it.** `room.js send` runs as a child of the
Bash tool; it can inspect its environment and its parent process, but
neither carries the session id in any dependable way. Yet a message in the
mailbox is meaningless without a trustworthy `from` field.

The resolution: split every identity-bearing write into two halves.

1. **The PreToolUse hook stamps.** Before the user's command executes, the
   `stamp-send` hook receives the tool call's stdin, which *does* carry the
   authoritative `session_id` from Claude Code itself. The hook parses the
   pending command (`send`, `lock`/`unlock`, `unattend reg|done`), and
   writes the record with that sid.
2. **The CLI only echoes.** When the command then runs, `room.js send`
   looks for the entry the hook just wrote (within a 5-second dedup
   window). Found: it confirms and prints a summary — including the
   sender's own short id, so the sender learns who they are and can
   verify attribution. Not found: it refuses with an error and a usage
   line.

The refusal is the load-bearing part. The predecessor of this rule was a
fallback: on a stamp miss, the CLI attributed the message to the latest
entry in the activity log. That heuristic worked right up until two
windows were active and a message landed in the mailbox under the *other*
session's name. The receiving session then replied to the wrong window and
the human spent twenty minutes untangling who had actually said what. Ever
since, the rule is absolute: **never guess `from`; prefer a refused send
over a misattributed one.** A refused send costs one retry; a
misattributed message costs trust in every message that follows.

The same pattern governs locks and the unattend queue: adjudication and
stamping happen in the hook where the sid is known; the CLI is a read-only
echo of what the hook already decided.

## 3. Concurrency lessons: append-only or lose entries

The first version wrote state the tidy way: read the JSON file, modify the
array in memory, write the whole file back. Correct in a single process —
and quietly destructive with several.

Two sessions editing in the same second each read the same base file, each
appended its own entry to its own in-memory copy, and each wrote its copy
back. Last writer wins; the other session's entry evaporated. Nothing
errored. The symptom appeared much later, as `[room]` blocks that
under-reported changes and messages that "sent" but never existed.

The fix is structural, not clever: **the common path is append-only.**
`fs.appendFileSync` of one JSON line per entry is atomic enough at the
line granularity that concurrent appenders interleave lines instead of
destroying them; `O_APPEND`-style writes at these sizes do not tear.

Rewrites do exist, but only as a garbage-collection measure: when a file
exceeds 512 KB *and* actually has entries older than the 24-hour retention
to drop, it is rewritten trimmed. If the file is large but nothing is old
enough to prune, we keep appending — refusing to pay for a full rewrite on
every write just because the file is big. The rewrite is a rare, low-
frequency event, which shrinks the read-modify-write race window to
near-zero rather than making it the common case.

The same reasoning explains the log schema: entries are flat, self-
describing records (`{kind, sid, ts, file}` or `{kind:"bash", sid, ts,
cmd}`). Aggregation (who is active, who edited what, per-file latest) is
computed at read time rather than maintained as writable shared state.

## 4. Failure-mode-driven copy

Every error message in claude-room is written against a specific
misdiagnosis the user or the AI is about to make. Generic error text is
treated as a bug.

The canonical incident: `room.js send` failed with a stamp miss — and the
operator read the failure as a *timeout*, because the command that wrapped
the send ended with an `|| echo FAILED` suffix and the wrapper's output
drowned the CLI's own explanation. Debugging went down the wrong path
(why is this hanging? raise the timeout?) until someone read the actual
refusal text. Two things changed because of it:

- The stamp-miss message now says explicitly, in plain words: *this is a
  hook-level instant rejection, NOT a timeout or hang — retry verbatim in
  the standard form shown below.* The most likely wrong conclusion is
  named and pre-empted inside the message itself.
- The send command parser now tolerates unquoted `|| …` / `&& …` suffixes
  after the quoted message text, because real commands in the wild carry
  them. Suffixes containing quotes (which could hide a second send), or
  pipes and redirects, are still rejected — accommodation ends where
  correctness does.

The pattern recurs throughout: lock denials say why the workspace is
shared and what concurrent deploys do to each other, then offer the three
actual resolutions (wait, negotiate via send, or delete the lock file if
truly stale). Idle-target warnings distinguish "session has been idle 8
minutes, may miss the Stop wake-up" from "session offline". The goal is
that a reader who has never seen this plugin can act on the error without
asking anyone what it means.

## 5. Soft warn vs. deny

The plugin guards two very different hazards and deliberately treats them
differently.

**Edit conflicts get a soft warn.** When session B opens a file that
session A edited within the last 10 minutes (and A is still alive within
the 5-minute heartbeat window), `guard-edit` injects context via
`PreToolUse` `additionalContext`. It does not block. Two sessions editing
the same file is often *fine* — different functions, different concerns —
and the session reading the warning has the most information about whether
the overlap matters. Blocking would convert a hint into an interruption;
soft context keeps the judgment where the judgment is best made.

**Deploy locks get a hard deny.** When a session tries to acquire a lock
(say, `deploy`) that a live peer already holds, the hook returns
`decision: deny` and the command never executes. Concurrent deploys are
never fine: they interleave builds, half-overwrite artifacts, and corrupt
shared release state in ways that are expensive to undo. There is no
judgment call for the asking session to make better than the hook, so the
hook makes it.

The asymmetry is the point: **deny mechanical hazards, warn judgment
hazards.** A related rule: only the holder may release a lock — a non-
holder's `unlock` is denied with an explanation, and stale locks (holder
inactive > 30 min) are taken over automatically by the next acquirer,
with the takeover being a fresh authoritative write rather than a repair
dance.

## 6. Wake-up semantics

Message delivery has two paths, and knowing their boundaries matters.

**Path one: the natural boundary.** Unread messages are delivered when the
receiving session's turn ends (Stop hook) or when a session starts
(SessionStart hook). A session deep in a long turn is *busy by
definition* — interrupting it mid-tool-call is not possible from a hook
anyway, and would be unwelcome even if it were. So delivery waits for the
turn boundary, where the message joins the context at a natural seam. The
Stop hook prints receipts *before* waking anyone, so each message wakes
its receiver exactly once.

**Path two: waking the idle.** The interesting case is a session that has
finished its turn and is sitting idle — no turn boundary in its future
until the human types again. Here the Stop hook returns
`{"decision": "block", "reason": …}` with the message body: Claude Code
restarts the session's loop with the reason as injected context, and the
idle session processes the message immediately. This is why "send to an
idle session" usually *just works*: the receiver's Stop hook fires once it
goes idle, finds the message, and blocks it back awake.

The boundary of path two: `decision: block` can only wake a session that
has *just gone idle* — it cannot interrupt a session that is actively
mid-turn, and it says nothing about machines that are asleep. Two
mitigations: senders get an explicit idle warning when the target has been
quiet for more than 3 minutes ("may miss the wake-up"), and receivers are
always caught up at their next SessionStart regardless.

**What `wait` adds.** Both paths deliver to the *receiver*; neither helps
the *sender* who wants an answer now. `wait <myShortId>` blocks the
sender's Bash call — polling the mailbox every 3 seconds, up to 300
seconds — and returns the moment a reply addressed to the sender arrives,
printing it in full and marking the receipt. It is synchronous
communication layered on an asynchronous substrate: the substrate stays
turn-boundary-friendly, and the sender opts into blocking only for the
duration of one tool call. The CLI resolves its short id prefix against
the activity log to a full sid before polling, because receipts are keyed
by full sid — an unresolved prefix would read nothing and cause
redelivery of already-seen messages, which is exactly the kind of quiet
wrongness §2 exists to prevent.
