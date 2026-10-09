"use strict";
// Message catalogs. ROOM_LANG=zh switches to Chinese; default is English.
// Entries are functions so callers pass runtime values (ids, minutes, cli path).

const catalogs = {
  en: {
    // ── formatMessages shared ──
    toBroadcast: () => " (broadcast)",
    toDirect: (to) => ` (to ${to})`,
    msgLine: (from, to, min, text) => `- From session ${from}${to} (${min} min ago): ${text}`,
    // ── lock ──
    lockDenyRelease: (name, holder, lockFile) =>
      `[room] ⛔ Lock "${name}" is held by session ${holder}; only the holder may release it. If you are sure it is stale, ask the user to manually delete ${lockFile}`,
    lockDenyHeld: (name, holder, min, lockFile, cli) =>
      `[room] ⛔ Lock "${name}" is held by session ${holder} (active ${min} min ago, deploy in progress): the local workspace is shared and concurrent deploys trample each other. Wait for it to finish (auto-released), or negotiate via ${cli} send ${holder} "coordinate"; if it is truly stale (holder offline > 30 min and still denied), ask the user to manually delete ${lockFile}`,
    lockUsage: (cli) => `Usage: ${cli} lock|unlock <name>`,
    lockCliStillHeld: (name, holder) =>
      `Lock "${name}" is still held by session ${holder} (release should happen in the same hook-approved command)`,
    lockCliReleased: (name) => `✅ Lock "${name}" released (or was not held)`,
    lockCliNoRecord: (name, cli, action) =>
      `⚠ No lock record for "${name}" (hook not effective?) — check the command form: ${cli} ${action} ${name} Note: the lock/unlock command must be the final segment of your Bash command — no trailing suffixes.`,
    lockCliHolder: (name, holder, sec) => `🔒 Lock "${name}" holder: session ${holder} (confirmed ${sec}s ago)`,
    // ── unattend ──
    queueHeader: () => `[unattend] Queue status (execute in ascending seq order; only one session holds "lock unattend" at a time):`,
    queueRow: (seq, sid, done, regMin) =>
      `- Seq ${seq}: session ${sid} ${done ? "✅ done" : "⏳ waiting"}${regMin ? `, registered ${regMin} min ago` : ""}`,
    queueNext: (seq, sid) => `seq ${seq} (session ${sid})`,
    queueHeldBy: (sid) => `held by session ${sid} (executing)`,
    queueIdle: () => "idle",
    queueAllDone: () => "none (queue fully completed)",
    queueFooter: (nextDesc, lockDesc) => `\nNext to run: ${nextDesc}; unattend lock: ${lockDesc}`,
    queueEmpty: (cli) => `[unattend] Queue is empty. Usage: ${cli} unattend reg|done|list [seq]`,
    unattendUsage: (cli) => `Usage: ${cli} unattend reg|done|list [seq]`,
    unattendStampFailReg: (cli, seq) =>
      `Registration failed: no PreToolUse stamp detected (this is a hook-level instant rejection, NOT a timeout or hang). Retry verbatim in the standard form: ${cli} unattend reg ${seq}`,
    unattendStampFailDone: (cli, seq) =>
      `Mark-failed: no PreToolUse stamp detected (hook-level instant rejection). Retry verbatim in the standard form: ${cli} unattend done ${seq}`,
    unattendRegOk: (seq, sid) => `✅ Registered seq ${seq} (this session ${sid})`,
    unattendDoneOk: (seq, sid) => `✅ Seq ${seq} marked done (session ${sid})`,
    unattendNext: (seq, sid, cli) =>
      `Next: seq ${seq} (session ${sid}). Wake it: ${cli} send ${sid} "Your turn (seq ${seq}): lock unattend released; run unattend list to verify, then start"`,
    unattendAllDone: () => `Queue fully completed, no one to wake.`,
    // ── send ──
    sendUsage: (cli) => `Usage: ${cli} send <toSid|all> "message text"`,
    sendStampFail: (cli, to) =>
      `Send failed: no PreToolUse stamp detected (this is a hook-level instant rejection, NOT a timeout or hang, and unrelated to room.js being modified in parallel).\n` +
      `Common causes: a pipe/redirection or quoted suffix appended after the message, the message not at the end of the command, or a non-standard send form (unquoted \`\|\| xxx\` / \`&& xxx\` suffixes ARE supported).\n` +
      `Retry verbatim in the standard form: ${cli} send ${to} "<message text>"`,
    sendTargetFiles: (files) => `(peer is editing: ${files})`,
    filesJoin: () => ", ",
    sendTargetBashOnly: () => `(bash-only activity)`,
    sendTargetIdle: (min) =>
      `\n⚠ Peer inactive for ${min} min, likely idle: the message will only be delivered on its next turn (its Stop already passed, no instant wake). For urgent matters ask the user to type a message in that window to activate it`,
    sendTargetOffline: () =>
      `\n⚠ Target has been inactive for the last 10 min and is likely offline: this message becomes an offline notice (auto-seen on its next turn). Do NOT block waiting for a reply — handle coordination items yourself with a "hold off" decision and state the outcome in the message`,
    sendTargetAmbiguous: () =>
      `\n⚠ This short-id prefix matches multiple active sessions, possible misdelivery: resend with a longer prefix`,
    sendOk: (from, to, desc, text) => `Sent (this session ${from}) → ${to}${desc}: ${text}`,
    sendWaitHint: (cli, from) => `Wait for reply: ${cli} wait ${from} [timeoutSec] (blocking poll every 3s, default 60s)`,
    // ── pending ──
    pendingNotFound: (id) => `No peer-to-peer message with id prefix ${id} found (lookback window is 1 hour)`,
    pendingNone: () => `[room] No peer-to-peer messages in the last hour`,
    pendingHeader: () => `[room] Peer-to-peer message receipts, last hour (recognize yours by content to see whether it was read):`,
    pendingRow: (from, to, min, read, brief, id) =>
      `- ${from} → ${to} (sent ${min} min ago, ${read ? "read" : `unread, waiting ${min} min`}) [${id}]: ${brief}`,
    pendingFull: (from, to, min, read, text) =>
      `- ${from} → ${to} (sent ${min} min ago, ${read ? "read" : `unread, waiting ${min} min`}): ${text}`,
    pendingHint: (cli) => `\nFull text: ${cli} pending <messageId>`,
    // ── wait ──
    waitUsage: (cli) => `Usage: ${cli} wait <yourShortId> [timeoutSec=60, max 300]`,
    waitPrefixAmbiguous: (n) => `⚠ Prefix matched ${n} sessions; using the most recently active one — use a longer prefix next time\n`,
    waitSidUnresolved: () =>
      `⚠ Could not resolve your full session_id from the log: receipts may not be recognized by deliver; the message may be redelivered once at end of turn\n`,
    waitReceived: (cli, n, lines) =>
      `[room] wait: received ${n} new message(s) (marked read):\n${lines}\nTo reply: ${cli} send <peerShortId> "reply text"`,
    waitTimeout: (sec) =>
      `[room] wait: no new message after ${sec}s. Run wait again to keep waiting, or continue your work — the Stop hook still delivers unread messages at end of turn`,
    // ── deliver ──
    deliverBody: (n, lines, cli) =>
      `[room] You have ${n} message(s) from other parallel sessions (marked read):\n${lines}\nPlease read and handle; to reply run ${cli} send <peerShortId> "reply text".`,
    // ── who ──
    whoEmpty: () => `[room] No active sessions in the last 10 minutes`,
    whoHeader: () => `[room] Active sessions (last 10 minutes):`,
    whoRow: (sid, min, idle, files) => `- Session ${sid} (active ${min} min ago${idle}) editing: ${files}`,
    whoIdleNote: () => ", possibly idle (messages cannot wake it instantly)",
    whoBashOnly: () => "(bash-only activity)",
    whoSendHint: (cli) => `\nSend to a session: ${cli} send <shortId> "message text"`,
    // ── inject ──
    injectIdentity: (sid) => `[room] This session's short id: ${sid}`,
    injectUnread: (n, lines) => `[room] You have ${n} unread message(s) (marked read):\n${lines}`,
    injectFilesIntro: () =>
      `[room] Files modified by other parallel sessions in the last 10 minutes (these are LEGITIMATE peer changes — do NOT treat them as bugs to revert, "fix", or overwrite without communication; if your task touches these files, first state in your reply how your changes differ from theirs):`,
    injectFilesRow: (sid, min, tool, file) => `- Session ${sid} (${min} min ago) ${tool} ${file}`,
    // ── guard-edit ──
    guardEditWarning: (rel, lines) =>
      `[room] File ${rel} is being edited by another parallel session (these are LEGITIMATE peer changes):\n${lines}\nConfirm the peer's intent before editing to avoid clobbering their work; if you must edit, explain how your changes differ in your reply first.`,
    guardEditRow: (sid, min) => `- Session ${sid} (${min} min ago) is editing this file`,
    // ── guard-commit ──
    guardCommitWarning: (lines) =>
      `[room] A parallel session recently ran git add/commit:\n${lines}\nUse only \`git add <your specific files>\` (never \`git add -A\`), and run \`git status\` before committing so another session's changes do not leak into your commit.`,
    guardCommitRow: (sid, min) => `- Session ${sid} (${min} min ago) ran git add/commit`,
  },
  zh: {
    toBroadcast: () => "（广播）",
    toDirect: (to) => `（发给 ${to}）`,
    msgLine: (from, to, min, text) => `- 来自会话 ${from}${to}（${min} 分钟前）：${text}`,
    lockDenyRelease: (name, holder, lockFile) =>
      `[room] ⛔ ${name} 锁由会话 ${holder} 持有，禁止他人释放；如确认是残留锁，请用户手动删除 ${lockFile}`,
    lockDenyHeld: (name, holder, min, lockFile, cli) =>
      `[room] ⛔ ${name} 锁由会话 ${holder} 持有（其 ${min} 分钟前有活动，正在部署中）：本地工作区共享，并发部署会互相踩。等它完成后自动释放，或 ${cli} send ${holder} "协调"；确认是残留锁（持有者已离线超 30 分钟仍拒）请用户手动删除 ${lockFile}`,
    lockUsage: (cli) => `用法: ${cli} lock|unlock <name>`,
    lockCliStillHeld: (name, holder) => `${name} 锁仍由会话 ${holder} 持有（释放应在 hook 放行的同一条命令里完成）`,
    lockCliReleased: (name) => `✅ ${name} 锁已释放（或本无锁）`,
    lockCliNoRecord: (name, cli, action) => `⚠ ${name} 无锁记录（hook 未生效？）——请确认命令形式：${cli} ${action} ${name} 注意：lock/unlock 必须是整条命令的末尾段，后面不能追加任何后缀。`,
    lockCliHolder: (name, holder, sec) => `🔒 ${name} 锁当前持有者：会话 ${holder}（${sec} 秒前确认）`,
    queueHeader: () => `[unattend] 队列状态（按序号升序执行，同一时刻仅一人持 lock unattend 执行）：`,
    queueRow: (seq, sid, done, regMin) => `- 序号 ${seq}：会话 ${sid} ${done ? "✅ 已完成" : "⏳ 等待中"}${regMin ? `，注册于 ${regMin} 分钟前` : ""}`,
    queueNext: (seq, sid) => `序号 ${seq}（会话 ${sid}）`,
    queueHeldBy: (sid) => `会话 ${sid} 持有（执行中）`,
    queueIdle: () => "空闲",
    queueAllDone: () => "无（队列已全部完成）",
    queueFooter: (nextDesc, lockDesc) => `\n下一个应执行：${nextDesc}；unattend 锁：${lockDesc}`,
    queueEmpty: (cli) => `[unattend] 队列为空。用法: ${cli} unattend reg|done|list [序号]`,
    unattendUsage: (cli) => `用法: ${cli} unattend reg|done|list [序号]`,
    unattendStampFailReg: (cli, seq) => `注册失败：未检测到 PreToolUse stamp（这是 hook 秒级拒绝，不是超时/卡死）。请用标准形式原样重试：${cli} unattend reg ${seq}`,
    unattendStampFailDone: (cli, seq) => `标记失败：未检测到 PreToolUse stamp（hook 秒级拒绝）。请用标准形式原样重试：${cli} unattend done ${seq}`,
    unattendRegOk: (seq, sid) => `✅ 已注册序号 ${seq}（本会话 ${sid}）`,
    unattendDoneOk: (seq, sid) => `✅ 序号 ${seq} 已标记完成（会话 ${sid}）`,
    unattendNext: (seq, sid, cli) => `下一个：序号 ${seq}（会话 ${sid}）。唤醒它：${cli} send ${sid} "轮到你了（序号 ${seq}）：lock unattend 已释放，请 unattend list 核对后开始执行"`,
    unattendAllDone: () => `队列已全部完成，无需唤醒。`,
    sendUsage: (cli) => `用法: ${cli} send <toSid|all> "消息内容"`,
    sendStampFail: (cli, to) =>
      `发送失败：未检测到 PreToolUse stamp（这是 hook 秒级拒绝，不是超时/卡死，与 room.js 是否被并行修改无关）。\n` +
      `常见原因：命令末尾追加了管道/重定向或含引号的后缀、消息整体不在命令末尾、或 send 拼写形式不标准（\`\|\| xxx\`/\`&& xxx\` 无引号后缀已兼容）。\n` +
      `请用标准形式原样重试：${cli} send ${to} "<消息内容>"`,
    sendTargetFiles: (files) => `（对方在改：${files}）`,
    filesJoin: () => "、",
    sendTargetBashOnly: () => `（仅 bash 活动）`,
    sendTargetIdle: (min) => `\n⚠ 对方已 ${min} 分钟无活动，可能已闲置：消息要等它下次回合才能送达（其 Stop 已错过，无法即时唤醒）；急事请用户在对方窗口发条消息激活`,
    sendTargetOffline: () => `\n⚠ 目标会话近 10 分钟不活跃，大概率已离线：本条消息转为离线通知（对方下次回合自动看到），勿干等回信——协调类事项按『先不发』自行处理，并在消息里写明处理结果`,
    sendTargetAmbiguous: () => `\n⚠ 该短 id 前缀命中多个活跃会话，可能错投：请用更长的 id 前缀重发`,
    sendOk: (from, to, desc, text) => `已发送（本会话 ${from}）→ ${to}${desc}：${text}`,
    sendWaitHint: (cli, from) => `等回信：${cli} wait ${from} [超时秒]（阻塞轮询每 3s 一查，默认 60s）`,
    pendingNotFound: (id) => `未找到 id 前缀为 ${id} 的点对点消息（仅回看近 1 小时）`,
    pendingNone: () => `[room] 近 1 小时无点对点消息`,
    pendingHeader: () => `[room] 近 1 小时点对点消息回执状态（按内容认出你发的那条，看对方读了没）：`,
    pendingRow: (from, to, min, read, brief, id) =>
      `- ${from} → ${to}（${min} 分钟前发出，${read ? "已读" : `未读，已等待 ${min} 分钟`}）[${id}]：${brief}`,
    pendingFull: (from, to, min, read, text) => `- ${from} → ${to}（${min} 分钟前发出，${read ? "已读" : `未读，已等待 ${min} 分钟`}）：${text}`,
    pendingHint: (cli) => `\n查看全文：${cli} pending <消息id>`,
    waitUsage: (cli) => `用法: ${cli} wait <你的短id> [超时秒=60，上限300]`,
    waitPrefixAmbiguous: (n) => `⚠ 前缀命中 ${n} 个会话，已取最近活跃者，请下次用更长前缀\n`,
    waitSidUnresolved: () => `⚠ log 中解析不到你的完整 session_id：回执可能不被 deliver 识别，该消息在回合结束时或被重复投递一次\n`,
    waitReceived: (cli, n, lines) => `[room] wait：收到 ${n} 条新消息（已标记已读）：\n${lines}\n如需回应：${cli} send <对方短id> "回复内容"`,
    waitTimeout: (sec) => `[room] wait：等待 ${sec} 秒无新消息。可再次运行 wait 继续等，或先做手头的事——回合结束时 Stop hook 仍会投递未读消息`,
    deliverBody: (n, lines, cli) => `[room] 你收到 ${n} 条来自其他并行会话的消息（已标记已读）：\n${lines}\n请阅读并处理；如需回应，运行 ${cli} send <对方短id> "回复内容"。`,
    whoEmpty: () => `[room] 近 10 分钟无活跃会话`,
    whoHeader: () => `[room] 活跃会话（近 10 分钟）：`,
    whoRow: (sid, min, idle, files) => `- 会话 ${sid}（${min} 分钟前有活动${idle}）在改：${files}`,
    whoIdleNote: () => "，可能已闲置（消息无法即时唤醒）",
    whoBashOnly: () => "（仅 bash 活动）",
    whoSendHint: (cli) => `\n点名发消息：${cli} send <短id> "消息内容"`,
    injectIdentity: (sid) => `[room] 本会话短 id：${sid}`,
    injectUnread: (n, lines) => `[room] 你有 ${n} 条未读消息（已标记已读）：\n${lines}`,
    injectFilesIntro: () =>
      `[room] 其他并行会话最近 10 分钟修改过的文件（这些是同事的正当修改，禁止当作 bug 回滚、'修复'或在未沟通下覆盖；若你的任务涉及这些文件，先在回复中说明你的改动意图与它们的差异）：`,
    injectFilesRow: (sid, min, tool, file) => `- 会话 ${sid}（${min} 分钟前）${tool} ${file}`,
    guardEditWarning: (rel, lines) => `[room] 文件 ${rel} 正被其他并行会话同时编辑（这是同事的正当修改）：\n${lines}\n请先确认对方意图，避免覆盖其工作；若确需修改，先在回复中说明你的改动与对方的差异。`,
    guardEditRow: (sid, min) => `- 会话 ${sid}（${min} 分钟前）正在编辑该文件`,
    guardCommitWarning: (lines) =>
      `[room] 有并行会话近期在执行 git 暂存/提交：\n${lines}\n请仅 \`git add <本次具体文件>\`（勿用 \`git add -A\`），提交前先 \`git status\` 核对暂存内容，避免把其他会话的改动混入你的提交。`,
    guardCommitRow: (sid, min) => `- 会话 ${sid}（${min} 分钟前）执行了 git add/commit`,
  },
};

function lang() {
  return String(process.env.ROOM_LANG || "").toLowerCase() === "zh" ? "zh" : "en";
}

function msg(key, ...args) {
  const cat = catalogs[lang()] || catalogs.en;
  const entry = cat[key] || catalogs.en[key];
  if (typeof entry !== "function") return `[room] (missing message: ${key})`;
  return entry(...args);
}

module.exports = { msg, catalogs };
