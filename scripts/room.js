#!/usr/bin/env node
// claude-room v3: coordination layer for parallel Claude Code sessions in a
// shared workspace — file-change broadcast, edit-conflict soft guards, commit
// coordination, cross-session messaging.
// log          — PostToolUse, records this session's file edits / Bash heartbeats
// inject       — UserPromptSubmit, emits other sessions' changes (last 10 min) + unread messages
// guard-edit   — PreToolUse(Edit|Write|...), soft-warns on concurrent edits of the same file
// guard-commit — PreToolUse(Bash), soft-warns on git mutations while peers staged/committed
// stamp-send   — PreToolUse(Bash), intercepts `room.js send` and writes the mailbox with the
//                hook's authoritative session_id (a CLI cannot know its own sid)
// send         — CLI, AI sends a message (stamp hit → dedup echo; miss → refuse — never
//                guess the sender, a former "latest log entry" fallback misattributed sends)
// deliver      — Stop/SessionStart hook, delivers unread messages (Stop uses decision:block
//                to wake an idle session immediately)
// wait         — CLI, blocking poll for a reply (every 3s, default timeout 60s)
// who          — CLI, lists active sessions' short ids and files being edited
// pending      — CLI, read receipts of peer-to-peer messages from the last hour
// lock/unlock  — PreToolUse adjudication + CLI echo, cross-session mutex (e.g. deploy)
// unattend     — unattended queue: reg/done are stamped by the hook, list echoes the queue
const fs = require("fs");
const path = require("node:path");
const { msg } = require("./messages");

// Canonical self-invocation string embedded in hint messages, generated from the
// real script location (plugin cache paths may contain spaces; forward slashes
// keep it copy-pasteable in any shell).
const CLI_PATH = `node "${__dirname.replace(/\\/g, "/")}/room.js"`;

// State dir resolution (in priority order):
//   1. ROOM_DIR env           — test injection
//   2. $CLAUDE_PROJECT_DIR/.claude/room — hook processes (env var is set there)
//   3. <cwd>/.claude/room     — CLI invocations via the Bash tool (CLAUDE_PROJECT_DIR
//                               is NOT guaranteed there, but cwd is the project dir;
//                               only applies when .claude already exists)
//   4. __dirname              — last resort (read-only commands still work)
// State must live per-project so parallel sessions in the same repo share it;
// the plugin install dir is shared across projects and must never hold state.
const ROOM_DIR =
  process.env.ROOM_DIR ||
  (process.env.CLAUDE_PROJECT_DIR
    ? path.join(process.env.CLAUDE_PROJECT_DIR, ".claude", "room")
    : fs.existsSync(path.join(process.cwd(), ".claude"))
      ? path.join(process.cwd(), ".claude", "room")
      : __dirname);
const LOG_FILE = path.join(ROOM_DIR, "log.jsonl");
const MAILBOX_FILE = path.join(ROOM_DIR, "mailbox.jsonl");
const RECEIPTS_FILE = path.join(ROOM_DIR, "receipts.jsonl");
const UNATTEND_FILE = path.join(ROOM_DIR, "unattend.jsonl");
const RETENTION_MS = 24 * 60 * 60 * 1000; // 日志保留：24 小时
const WINDOW_MS = 10 * 60 * 1000;         // inject 窗口：10 分钟
const EDIT_MS = 10 * 60 * 1000;           // guard-edit：他人编辑该文件窗口
const ALIVE_MS = 5 * 60 * 1000;           // guard-edit：会话活跃窗口（心跳）
const COMMIT_MS = 3 * 60 * 1000;          // guard-commit：他人提交窗口
const CMD_MAX = 200;                      // bash 命令截断长度
const MAX_LOG_BYTES = 512 * 1024;         // 日志体积阈值：超限时低频全量重写并修剪 24h 以上旧条目
const SEND_DEDUP_MS = 5000;               // CLI send 对 hook 刚写过的相同消息去重的窗口
const PENDING_MS = 60 * 60 * 1000;        // pending 命令回看的消息窗口：1 小时
const IDLE_WARN_MS = 3 * 60 * 1000;       // send 目标闲置警告阈值：超 3 分钟无活动大概率错过 Stop 唤醒
const STALE_LOCK_MS = 30 * 60 * 1000;     // 锁持有者死亡判定：超 30 分钟无活动视为残留锁，可被接管
const WAIT_POLL_MS = 3 * 1000;            // wait 轮询间隔：3 秒
const WAIT_MAX_SEC = 300;                 // wait 超时上限：5 分钟（防僵尸阻塞）
const GIT_MUTATION_RE = /(^|\s)git\s+(add|commit|push|rm|mv|restore|checkout|reset)\b/;
const GIT_STAGE_COMMIT_RE = /git\s+(add|commit)\b/;
// room.js send <to> "<text>"：to 为 4 位以上 sid 前缀或字面量 all；text 必须带引号且是命令末尾
// 文本捕获用转义感知形式（[^"\\]|\\.）：遇未转义引号即止，文本内可含转义双引号（\"），捕获后还原成真实引号；
// 消息引号后允许接不含引号的 || / && 短语后缀（如 "…\" || echo FAILED"——实测事故：曾因这种后缀 stamp 未命中被误诊为超时）；
// 含引号的后缀（可藏第二条 send）与管道/重定向后缀仍拒绝
// 脚本路径可能带引号（node "…/room.js" send），room\.js 后允许一个闭合引号
const SEND_CMD_RE = /room\.js['"]?\s+send\s+(all|[0-9a-zA-Z]{4,})\s+"((?:[^"\\]|\\.)*)"\s*(?:(?:\|\||&&)[^"']*)?$|room\.js['"]?\s+send\s+(all|[0-9a-zA-Z]{4,})\s+'((?:[^'\\]|\\.)*)'\s*(?:(?:\|\||&&)[^"']*)?$/;
// room.js lock|unlock <name>：互斥锁裁决也走 PreToolUse hook（CLI 不知道自己的 sid，必须 hook 权威裁决）
const LOCK_CMD_RE = /room\.js['"]?\s+(lock|unlock)\s+([a-z0-9-]{1,40})\s*$/;
// room.js unattend reg|done <seq>：无人值守队列注册/完成，sid 同样由 stamp hook 权威盖戳；必须是命令末尾段
const UNATTEND_CMD_RE = /room\.js['"]?\s+unattend\s+(reg|done)\s+([0-9]{1,3})\s*$/;
const UNATTEND_STAMP_MS = 5000;             // unattend CLI 对 hook 刚写条目的确认窗口（同 send 去重窗口）

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// hook 输入的 file_path 恒为绝对路径，Windows 下反斜杠分隔，必须归一化
function toRepoRelative(p, cwd) {
  const file = String(p).replace(/\\/g, "/");
  const dir = String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  if (file.toLowerCase().startsWith(dir.toLowerCase() + "/")) {
    return file.slice(dir.length + 1);
  }
  return file;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonl(file, entries) {
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf8");
}

// 追加写避免并发丢条目：read-modify-write 在多窗口并行会话下会互相覆盖；
// 仅体积超限且确有 24h 以上旧条目可修剪时才全量重写（无可修剪时继续追加，避免每次写都重写整个文件）
function appendTrimmed(file, entry) {
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let trimmed = null;
  if (size > MAX_LOG_BYTES) {
    const all = readJsonl(file);
    const kept = all.filter((e) => e.ts >= entry.ts - RETENTION_MS);
    if (kept.length < all.length) trimmed = [...kept, entry];
  }
  if (trimmed) writeJsonl(file, trimmed);
  else fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

function shortSid(sid) {
  return String(sid).slice(0, 6);
}

function isAlive(entries, sid, now, aliveMs) {
  return entries.some((e) => e.sid === sid && e.ts >= now - aliveMs);
}

// 软提示唯一出口：有冲突时输出 additionalContext 纯 JSON；无冲突输出空串
function emitWarning(text) {
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
    })
  );
}

// ── 消息：id 用 时间戳+pid+进程内序号 保证跨进程唯一 ──
let msgSeq = 0;
function appendMessage(from, to, text) {
  const now = Date.now();
  const id = now.toString(36) + "-" + process.pid.toString(36) + "-" + (++msgSeq);
  appendTrimmed(MAILBOX_FILE, { id, from, to, ts: now, text });
  return id;
}

function myUnread(me, now) {
  if (!me) return [];
  const receipts = new Set(
    readJsonl(RECEIPTS_FILE)
      .filter((r) => r.sid === me)
      .map((r) => r.id)
  );
  return readJsonl(MAILBOX_FILE)
    .filter(
      (m) =>
        m.id &&
        m.ts >= now - RETENTION_MS &&
        m.from !== me &&
        (m.to === "all" || String(me).startsWith(m.to)) &&
        !receipts.has(m.id)
    )
    .sort((a, b) => a.ts - b.ts);
}

function markRead(me, msgs) {
  for (const m of msgs) {
    appendTrimmed(RECEIPTS_FILE, { id: m.id, sid: me, ts: Date.now() });
  }
}

function formatMessages(msgs, now) {
  return msgs.map((m) => {
    const min = Math.max(1, Math.round((now - m.ts) / 60000));
    const to = m.to === "all" ? msg("toBroadcast") : msg("toDirect", m.to);
    return msg("msgLine", shortSid(m.from), to, min, m.text);
  });
}

// ── v3 命令 ──

// PreToolUse(Bash)：hook 输入带权威 session_id，在命令真正执行前把消息落盘
function cmdStampSend(input) {
  const sid = input.session_id ? String(input.session_id) : "";
  const cmd = input.tool_input && input.tool_input.command ? String(input.tool_input.command) : "";
  if (!sid || !cmd) return;
  const m = SEND_CMD_RE.exec(cmd);
  if (m) {
    const to = m[1] || m[3] || "";
    const text = (m[2] !== undefined ? m[2] : m[4] || "").replace(/\\"/g, '"');
    if (!to || !text) return;
    appendMessage(sid, to, text);
    return;
  }
  const lm = LOCK_CMD_RE.exec(cmd);
  if (lm) lockAdjudicate(sid, lm[1] === "unlock", lm[2]);
  const um = UNATTEND_CMD_RE.exec(cmd);
  if (um) {
    appendTrimmed(UNATTEND_FILE, { type: um[1], seq: parseInt(um[2], 10), sid, ts: Date.now() });
  }
}

// ── 互斥锁：裁决在 hook（deny 拦下命令并提示），CLI 只回显结果 ──
function lockFile(name) {
  return path.join(ROOM_DIR, `lock-${name}.json`);
}

function readLock(name) {
  const p = lockFile(name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// 持有者最近一次活动（扫全量 log，不受 10 分钟窗口限制）
function holderLastActiveTs(sid) {
  let latest = null;
  for (const e of readJsonl(LOG_FILE)) {
    if (e.sid !== sid || !e.ts) continue;
    if (!latest || e.ts > latest) latest = e.ts;
  }
  return latest;
}

function lockAdjudicate(sid, isUnlock, name) {
  const now = Date.now();
  if (isUnlock) {
    const cur = readLock(name);
    if (!cur) return; // no lock: allow
    if (cur.sid !== sid) {
      process.stdout.write(
        JSON.stringify({
          decision: "deny",
          reason: msg("lockDenyRelease", name, shortSid(cur.sid), path.basename(lockFile(name))),
        })
      );
      return;
    }
    fs.unlinkSync(lockFile(name)); // holder releasing: allow
    return;
  }
  const cur = readLock(name);
  if (!cur || cur.sid === sid) {
    fs.writeFileSync(lockFile(name), JSON.stringify({ sid, ts: now }));
    return; // first acquire / refresh: allow
  }
  const holderTs = holderLastActiveTs(cur.sid);
  if (holderTs && now - holderTs <= STALE_LOCK_MS) {
    const min = Math.max(1, Math.round((now - holderTs) / 60000));
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: msg("lockDenyHeld", name, shortSid(cur.sid), min, path.basename(lockFile(name)), CLI_PATH),
      })
    );
    return;
  }
  // holder dead: take over the stale lock
  fs.writeFileSync(lockFile(name), JSON.stringify({ sid, ts: now }));
}

// CLI: read-only echo of lock state (the actual adjudication already happened
// in the hook, before the command ran)
function cmdLockCli(name, isUnlock) {
  if (!name) {
    process.stdout.write(msg("lockUsage", CLI_PATH) + "\n");
    process.exitCode = 1;
    return;
  }
  const cur = readLock(name);
  if (isUnlock) {
    if (cur) {
      process.stdout.write(msg("lockCliStillHeld", name, shortSid(cur.sid)) + "\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(msg("lockCliReleased", name) + "\n");
    }
    return;
  }
  if (!cur) {
    process.stdout.write(msg("lockCliNoRecord", name, CLI_PATH, isUnlock ? "unlock" : "lock") + "\n");
    process.exitCode = 1;
    return;
  }
  const sec = Math.max(1, Math.round((Date.now() - cur.ts) / 1000));
  process.stdout.write(msg("lockCliHolder", name, shortSid(cur.sid), sec) + "\n");
}

// ── 无人值守队列（/unattend 命令）：多窗口按序号排队互斥执行，注册/完成标记 sid 由 stamp hook 盖戳 ──

// 按 seq 聚合 unattend.jsonl：任意 done 即算该序号完成；重复 reg 保留最早一条
function unattendRows() {
  const rows = new Map();
  for (const e of readJsonl(UNATTEND_FILE)) {
    if ((e.type !== "reg" && e.type !== "done") || !e.seq) continue;
    const prev = rows.get(e.seq);
    if (!prev) {
      rows.set(e.seq, { seq: e.seq, sid: e.sid, regTs: e.type === "reg" ? e.ts : null, done: e.type === "done" });
    } else if (e.type === "reg") {
      if (!prev.regTs) prev.regTs = e.ts;
    } else {
      prev.done = true;
    }
  }
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}

function formatQueue(rows, now) {
  const lines = rows.map((r) => {
    const regMin = r.regTs ? Math.max(1, Math.round((now - r.regTs) / 60000)) : "";
    return msg("queueRow", r.seq, r.sid ? shortSid(r.sid) : "?", r.done, regMin);
  });
  const next = rows.find((r) => !r.done);
  const lock = readLock("unattend");
  const lockDesc = lock ? msg("queueHeldBy", shortSid(lock.sid)) : msg("queueIdle");
  const nextDesc = next ? msg("queueNext", next.seq, shortSid(next.sid)) : msg("queueAllDone");
  return msg("queueHeader") + "\n" + lines.join("\n") + msg("queueFooter", nextDesc, lockDesc);
}

function cmdUnattendList() {
  const rows = unattendRows();
  if (!rows.length) {
    process.stdout.write(msg("queueEmpty", CLI_PATH) + "\n");
    return;
  }
  process.stdout.write(formatQueue(rows, Date.now()) + "\n");
}

// CLI: registration. The hook already persisted it with the authoritative sid in
// PreToolUse; the CLI confirms it (takes the latest entry within the 5s window,
// i.e. the one this hook just wrote) and echoes the queue.
function cmdUnattendReg(seqArg) {
  const seq = parseInt(seqArg, 10);
  if (!Number.isInteger(seq) || seq < 1) {
    process.stdout.write(msg("unattendUsage", CLI_PATH) + "\n");
    process.exitCode = 1;
    return;
  }
  const now = Date.now();
  const stamped = [...readJsonl(UNATTEND_FILE)].reverse().find(
    (e) => e.type === "reg" && e.seq === seq && e.ts >= now - UNATTEND_STAMP_MS
  );
  if (!stamped) {
    process.stdout.write(msg("unattendStampFailReg", CLI_PATH, seq) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(msg("unattendRegOk", seq, shortSid(stamped.sid)) + "\n");
  process.stdout.write(formatQueue(unattendRows(), now) + "\n");
}

// CLI: mark this seq as done (regardless of outcome, only then can the queue
// advance); echoes the next session's short id so it can be woken via send.
function cmdUnattendDone(seqArg) {
  const seq = parseInt(seqArg, 10);
  if (!Number.isInteger(seq) || seq < 1) {
    process.stdout.write(msg("unattendUsage", CLI_PATH) + "\n");
    process.exitCode = 1;
    return;
  }
  const now = Date.now();
  const stamped = [...readJsonl(UNATTEND_FILE)].reverse().find(
    (e) => e.type === "done" && e.seq === seq && e.ts >= now - UNATTEND_STAMP_MS
  );
  if (!stamped) {
    process.stdout.write(msg("unattendStampFailDone", CLI_PATH, seq) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(msg("unattendDoneOk", seq, shortSid(stamped.sid)) + "\n");
  const next = unattendRows().find((r) => !r.done);
  if (next) {
    process.stdout.write(msg("unattendNext", next.seq, shortSid(next.sid), CLI_PATH) + "\n");
  } else {
    process.stdout.write(msg("unattendAllDone") + "\n");
  }
}

// CLI: invoked by the AI. The only legal path is that PreToolUse stamp-send has
// already persisted the message with the authoritative session_id; the CLI only
// dedups and echoes (including this session's short id so the sender can verify
// attribution). On a stamp miss (non-standard command form etc.) it refuses
// outright — never guess `from`; prefer a retry over misattribution.
function cmdSendCli(toArg, textArg) {
  const to = String(toArg || "");
  const text = String(textArg || "");
  if (!to || !text) {
    process.stdout.write(msg("sendUsage", CLI_PATH) + "\n");
    process.exitCode = 1;
    return;
  }
  const now = Date.now();
  const stamped = readJsonl(MAILBOX_FILE).find(
    (m) => m.to === to && m.text === text && m.ts >= now - SEND_DEDUP_MS
  );
  if (!stamped) {
    process.stdout.write(msg("sendStampFail", CLI_PATH, to) + "\n");
    process.exitCode = 1;
    return;
  }
  // Target check: echo the peer's files-in-edit so the sender can verify they
  // picked the right session; warn on black holes / prefix collisions.
  let targetDesc = "";
  if (to !== "all") {
    const hits = activeSessions(now).filter((s) => s.sid.startsWith(to));
    if (hits.length === 1) {
      targetDesc = hits[0].files.length
        ? msg("sendTargetFiles", hits[0].files.slice(0, 3).join(msg("filesJoin")))
        : msg("sendTargetBashOnly");
      const idleMs = now - hits[0].lastTs;
      if (idleMs >= IDLE_WARN_MS) {
        const idleMin = Math.max(1, Math.round(idleMs / 60000));
        targetDesc += msg("sendTargetIdle", idleMin);
      }
    } else if (hits.length === 0) {
      targetDesc = msg("sendTargetOffline");
    } else {
      targetDesc = msg("sendTargetAmbiguous");
    }
  }
  process.stdout.write(msg("sendOk", shortSid(stamped.from), to, targetDesc, text) + "\n");
  process.stdout.write(msg("sendWaitHint", CLI_PATH, shortSid(stamped.from)) + "\n");
}

// CLI: receipt status of peer-to-peer messages from the last hour. While waiting
// for a reply, the sender can distinguish "peer hasn't read it yet" from "read
// but no reply". List text is truncated; use `pending <messageId>` for full text.
// Broadcasts are not listed (read semantics are ambiguous with many receivers)
function cmdPending(idArg) {
  const now = Date.now();
  const receipts = new Set(readJsonl(RECEIPTS_FILE).map((r) => r.id));
  const msgs = readJsonl(MAILBOX_FILE).filter(
    (m) => m.to !== "all" && m.id && m.ts >= now - PENDING_MS
  );
  if (idArg) {
    const m = msgs.find((x) => x.id.startsWith(idArg));
    if (!m) {
      process.stdout.write(msg("pendingNotFound", idArg) + "\n");
      process.exitCode = 1;
      return;
    }
    const min = Math.max(1, Math.round((now - m.ts) / 60000));
    const read = receipts.has(m.id);
    process.stdout.write(msg("pendingFull", shortSid(m.from), m.to, min, read, m.text) + "\n");
    return;
  }
  if (!msgs.length) {
    process.stdout.write(msg("pendingNone") + "\n");
    return;
  }
  const lines = msgs
    .sort((a, b) => b.ts - a.ts)
    .map((m) => {
      const min = Math.max(1, Math.round((now - m.ts) / 60000));
      const read = receipts.has(m.id);
      const brief = m.text.length > 40 ? m.text.slice(0, 40) + "…" : m.text;
      return msg("pendingRow", shortSid(m.from), m.to, min, read, brief, m.id);
    });
  process.stdout.write(
    msg("pendingHeader") + "\n" + lines.join("\n") + msg("pendingHint", CLI_PATH) + "\n"
  );
}

// 主线程同步休眠（不占 CPU），wait 的轮询间隔用
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// CLI: blocking poll for a reply. The session that just sent a message runs
// `wait <its own short id>`; every 3s it checks unread messages addressed to it,
// prints full text + marks receipts on arrival and exits; on timeout prints a
// hint and exits — unread messages are still delivered by the Stop hook at end
// of turn.
function cmdWait(sidArg, timeoutArg) {
  const prefix = String(sidArg || "");
  if (prefix.length < 4) {
    process.stdout.write(msg("waitUsage", CLI_PATH) + "\n");
    process.exitCode = 1;
    return;
  }
  const timeoutSec = Math.min(WAIT_MAX_SEC, Math.max(1, parseInt(timeoutArg, 10) || 60));
  // Short id -> full sid: receipts are booked by full sid; without resolution
  // deliver would not recognize them and would redeliver.
  const hits = new Map(); // sid -> latest ts
  for (const e of readJsonl(LOG_FILE)) {
    if (!e.sid || !String(e.sid).startsWith(prefix)) continue;
    const prev = hits.get(e.sid);
    if (!prev || e.ts > prev) hits.set(e.sid, e.ts);
  }
  let me = prefix;
  let warn = "";
  if (hits.size === 1) {
    me = [...hits.keys()][0];
  } else if (hits.size > 1) {
    me = [...hits.entries()].sort((a, b) => b[1] - a[1])[0][0];
    warn = msg("waitPrefixAmbiguous", hits.size);
  } else {
    warn = msg("waitSidUnresolved");
  }
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const unread = myUnread(me, Date.now());
    if (unread.length) {
      markRead(me, unread);
      process.stdout.write(
        warn +
          msg("waitReceived", CLI_PATH, unread.length, formatMessages(unread, Date.now()).join("\n")) +
          "\n"
      );
      return;
    }
    const remain = deadline - Date.now();
    if (remain <= 0) {
      process.stdout.write(warn + msg("waitTimeout", timeoutSec) + "\n");
      return;
    }
    sleepSync(Math.min(WAIT_POLL_MS, remain));
  }
}

// Stop / SessionStart hook: deliver unread messages.
// Stop uses {"decision":"block","reason":...} to wake an idle session to handle
// them immediately; receipts are persisted before waking so each message wakes
// exactly once.
function cmdDeliver(input) {
  const me = input.session_id ? String(input.session_id) : "";
  const event = String(input.hook_event_name || "Stop");
  const now = Date.now();
  const unread = myUnread(me, now);
  if (!unread.length) return;
  markRead(me, unread);
  const body = msg("deliverBody", unread.length, formatMessages(unread, now).join("\n"), CLI_PATH);
  if (event === "Stop") {
    process.stdout.write(JSON.stringify({ decision: "block", reason: body }));
  } else {
    process.stdout.write(body + "\n");
  }
}

// 近 WINDOW_MS 有活动的会话清单（sid、最近活动、在改文件），who 与 send 目标校验共用
function activeSessions(now) {
  const entries = readJsonl(LOG_FILE).filter((e) => e.sid && e.ts >= now - WINDOW_MS);
  const lastTs = new Map(); // sid -> 最近活动 ts
  const files = new Map();  // sid -> Map(file -> 最新 ts)
  for (const e of entries) {
    const prev = lastTs.get(e.sid);
    if (!prev || e.ts > prev) lastTs.set(e.sid, e.ts);
    if (e.kind !== "bash" && e.file) {
      if (!files.has(e.sid)) files.set(e.sid, new Map());
      const f = files.get(e.sid);
      const pf = f.get(e.file);
      if (!pf || e.ts > pf) f.set(e.file, e.ts);
    }
  }
  return [...lastTs.keys()].map((sid) => ({
    sid,
    lastTs: lastTs.get(sid),
    files: files.has(sid) ? [...files.get(sid).keys()].sort() : [],
  }));
}

// CLI: list active sessions (last 10 min) and their files-in-edit, for picking
// a recipient before sending.
function cmdWho() {
  const now = Date.now();
  const sessions = activeSessions(now).sort((a, b) => b.lastTs - a.lastTs);
  if (!sessions.length) {
    process.stdout.write(msg("whoEmpty") + "\n");
    return;
  }
  const lines = sessions.map(({ sid, lastTs, files }) => {
    const min = Math.max(1, Math.round((now - lastTs) / 60000));
    const idle = now - lastTs >= IDLE_WARN_MS ? msg("whoIdleNote") : "";
    return msg("whoRow", shortSid(sid), min, idle, files.length ? files.join(", ") : msg("whoBashOnly"));
  });
  process.stdout.write(
    msg("whoHeader") + "\n" + lines.join("\n") + msg("whoSendHint", CLI_PATH) + "\n"
  );
}

// ── v2 命令 ──

function cmdLog(input) {
  const sid = input.session_id ? String(input.session_id) : "";
  if (!sid) return;
  const tool = String(input.tool_name || "Edit");
  const ti = input.tool_input || {};
  const now = Date.now();
  let entry = null;
  if (tool === "Bash") {
    const cmd = String(ti.command || "").slice(0, CMD_MAX);
    if (cmd) entry = { kind: "bash", sid, ts: now, cmd };
  } else {
    const file = ti.file_path || ti.notebook_path;
    if (file) {
      entry = { kind: "edit", sid, ts: now, tool, file: toRepoRelative(file, input.cwd || process.cwd()) };
    }
  }
  if (!entry) return;
  appendTrimmed(LOG_FILE, entry);
}

function cmdInject(input) {
  const me = input.session_id ? String(input.session_id) : "";
  const now = Date.now();
  const out = [];

  // The AI does not know its own sid: whenever we emit a report, include this
  // session's short id (used for replies, claiming pending messages, noticing
  // misdelivery); stay silent when there is nothing to report.
  const withIdentity = (blocks) =>
    blocks.length ? [msg("injectIdentity", shortSid(me)), ...blocks] : blocks;

  // Unread messages first; injecting counts as reading them (receipts persisted)
  const unread = myUnread(me, now);
  if (unread.length) {
    markRead(me, unread);
    out.push(msg("injectUnread", unread.length, formatMessages(unread, now).join("\n")));
  }

  const cutoff = now - WINDOW_MS;
  const latest = new Map();
  for (const e of readJsonl(LOG_FILE)) {
    if (e.kind === "bash" || !e.sid || !e.file || e.ts < cutoff) continue;
    if (me && e.sid === me) continue;
    const key = e.sid + "\t" + e.file;
    const prev = latest.get(key);
    if (!prev || e.ts > prev.ts) latest.set(key, e);
  }
  if (latest.size > 0) {
    const lines = [...latest.values()]
      .sort((a, b) => a.ts - b.ts)
      .map((e) => {
        const min = Math.max(1, Math.round((now - e.ts) / 60000));
        return msg("injectFilesRow", shortSid(e.sid), min, e.tool, e.file);
      });
    out.push(msg("injectFilesIntro") + "\n" + lines.join("\n"));
  }
  if (out.length) process.stdout.write(withIdentity(out).join("\n\n"));
}

function cmdGuardEdit(input) {
  const me = input.session_id ? String(input.session_id) : "";
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  if (!me || !file) return;
  const rel = toRepoRelative(file, input.cwd || process.cwd());
  const now = Date.now();
  const entries = readJsonl(LOG_FILE);

  // Hit sessions: edited this file within EDIT_MS (excluding self) and had
  // activity within ALIVE_MS.
  const hitTs = new Map(); // sid -> latest ts of editing this file
  for (const e of entries) {
    if (e.kind !== "bash" && e.sid !== me && e.file === rel && e.ts >= now - EDIT_MS) {
      const prev = hitTs.get(e.sid);
      if (!prev || e.ts > prev) hitTs.set(e.sid, e.ts);
    }
  }
  const lines = [];
  for (const [sid, ts] of hitTs) {
    if (!isAlive(entries, sid, now, ALIVE_MS)) continue;
    const min = Math.max(1, Math.round((now - ts) / 60000));
    lines.push(msg("guardEditRow", shortSid(sid), min));
  }
  if (!lines.length) return;
  emitWarning(msg("guardEditWarning", rel, lines.join("\n")));
}

function cmdGuardCommit(input) {
  const me = input.session_id ? String(input.session_id) : "";
  const cmd = input.tool_input && input.tool_input.command ? String(input.tool_input.command) : "";
  if (!me || !cmd) return;
  if (!GIT_MUTATION_RE.test(cmd)) return; // not a git mutation: zero disturbance
  const now = Date.now();
  const entries = readJsonl(LOG_FILE);

  // add/commit activity of other sessions within COMMIT_MS (latest per session)
  const recent = new Map(); // sid -> ts
  for (const e of entries) {
    if (e.kind !== "bash" || e.sid === me) continue;
    if (e.ts < now - COMMIT_MS) continue;
    if (!GIT_STAGE_COMMIT_RE.test(String(e.cmd || ""))) continue;
    const prev = recent.get(e.sid);
    if (!prev || e.ts > prev) recent.set(e.sid, e.ts);
  }
  if (!recent.size) return;
  const lines = [...recent.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([sid, ts]) => msg("guardCommitRow", shortSid(sid), Math.max(1, Math.round((now - ts) / 60000))));
  emitWarning(msg("guardCommitWarning", lines.join("\n")));
}

try {
  const input = JSON.parse(readStdin() || "{}");
  const c = process.argv[2];
  if (c === "log") cmdLog(input);
  else if (c === "inject") cmdInject(input);
  else if (c === "guard-edit") cmdGuardEdit(input);
  else if (c === "guard-commit") cmdGuardCommit(input);
  else if (c === "stamp-send") cmdStampSend(input);
  else if (c === "send") cmdSendCli(process.argv[3], process.argv[4]);
  else if (c === "deliver") cmdDeliver(input);
  else if (c === "who") cmdWho();
  else if (c === "pending") cmdPending(process.argv[3]);
  else if (c === "wait") cmdWait(process.argv[3], process.argv[4]);
  else if (c === "lock") cmdLockCli(process.argv[3], false);
  else if (c === "unlock") cmdLockCli(process.argv[3], true);
  else if (c === "unattend") {
    const sub = process.argv[3];
    if (sub === "reg") cmdUnattendReg(process.argv[4]);
    else if (sub === "done") cmdUnattendDone(process.argv[4]);
    else if (sub === "list") cmdUnattendList();
    else {
      process.stdout.write(msg("unattendUsage", CLI_PATH) + "\n");
      process.exitCode = 1;
    }
  }
} catch {
  // 任何内部错误静默退出，绝不阻断用户流程
}
