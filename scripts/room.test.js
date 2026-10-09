// claude-room v3 test suite: node --test scripts/room.test.js
// ROOM_DIR points at temp dirs so the suite never touches real .claude/room data.
// All ported assertions pin ROOM_LANG=zh (they match the Chinese catalog); the
// i18n/state-dir additions at the bottom exercise the en catalog and dir resolution.
const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOM_JS = path.join(__dirname, "room.js");

function newRoom() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-test-"));
  return dir;
}

function run(args, { stdin, roomDir }) {
  return execFileSync("node", [ROOM_JS, ...args], {
    input: stdin ? JSON.stringify(stdin) : "",
    env: { ...process.env, ROOM_DIR: roomDir, ROOM_LANG: "zh" },
  }).toString();
}

function lines(roomDir, name) {
  const p = path.join(roomDir, name);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const SID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SID_B = "bbbbbbbb-1111-2222-3333-444444444444";

// ── stamp-send: the PreToolUse hook intercepts room.js send and writes with the authoritative session_id ──
test("stamp-send: hook intercepts send and writes the mailbox with the hook's authoritative session_id as from", () => {
  const dir = newRoom();
  run(
    ["stamp-send"],
    {
      roomDir: dir,
      stdin: {
        hook_event_name: "PreToolUse",
        session_id: SID_A,
        tool_name: "Bash",
        tool_input: {
          command: 'node .claude/room/room.js send bbbbbb "这个文件我来改"',
        },
      },
    }
  );
  const msgs = lines(dir, "mailbox.jsonl");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].from, SID_A);
  assert.equal(msgs[0].to, "bbbbbb");
  assert.equal(msgs[0].text, "这个文件我来改");
  assert.ok(msgs[0].id);
  assert.ok(msgs[0].ts > 0);
});

test("stamp-send: non-send commands write nothing to the mailbox", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: "git add src/foo.ts" },
    },
  });
  assert.equal(lines(dir, "mailbox.jsonl").length, 0);
});

// ── CLI send: if the hook wrote the same message within the last 5s, dedup; otherwise refuse ──
test("send: hook just wrote the same message, CLI does not duplicate and prints confirmation", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send bbbbbb "hi"' },
    },
  });
  const out = run(["send", "bbbbbb", "hi"], { roomDir: dir });
  assert.match(out, /已发送|sent/i);
  assert.equal(lines(dir, "mailbox.jsonl").length, 1);
});

test("send: CLI refuses on stamp miss (prevents sender misattribution; the old global latest-entry fallback is gone)", () => {
  const dir = newRoom();
  // Recent log activity from another session (the old fallback would wrongly take it as from)
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 1000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  let err = null;
  try {
    run(["send", "bbbbbb", "hello"], { roomDir: dir });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应非零退出");
  assert.match(String(err.stdout || "") + String(err.stderr || ""), /发送失败/);
  assert.equal(lines(dir, "mailbox.jsonl").length, 0); // 绝不落盘
});

test("stamp-send: accepts the quoted script path form node \"…/room.js\" send, including paths with spaces (pitfall hit in practice)", () => {
  const dir = newRoom();
  run(
    ["stamp-send"],
    {
      roomDir: dir,
      stdin: {
        session_id: SID_A,
        tool_input: {
          command: 'node "C:/Users/example/projects/my app/.claude/room/room.js" send bbbbbb "带引号路径"',
        },
      },
    }
  );
  const msgs = lines(dir, "mailbox.jsonl");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].from, SID_A);
  assert.equal(msgs[0].text, "带引号路径");
});

test("send: success output echoes this session's short id so the sender can verify attribution", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send bbbbbb "hi"' },
    },
  });
  const out = run(["send", "bbbbbb", "hi"], { roomDir: dir });
  assert.match(out, /本会话 aaaaaa/);
});

test("send: when the target session is active, echoes the files it is editing so the sender can verify the recipient", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_B, ts: Date.now() - 30000, tool: "Edit", file: "src/b.ts" }) + "\n"
  );
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send bbbbbb "看一眼"' },
    },
  });
  const out = run(["send", "bbbbbb", "看一眼"], { roomDir: dir });
  assert.match(out, /对方在改：[^]*src\/b\.ts/);
  assert.doesNotMatch(out, /闲置/); // 半分钟前还在动，不打扰
});

test("send: target within the 10-min window but idle for over 3 min → hint that it is likely idle and needs manual activation", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_B, ts: Date.now() - 4 * 60000, tool: "Edit", file: "src/b.ts" }) + "\n"
  );
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send bbbbbb "看一眼"' },
    },
  });
  const out = run(["send", "bbbbbb", "看一眼"], { roomDir: dir });
  assert.match(out, /对方在改：[^]*src\/b\.ts/); // 身份回显仍有
  assert.match(out, /已 \d+ 分钟无活动[^]*可能已闲置/);
  assert.match(out, /发条消息激活/);
});

test("send: target inactive for the last 10 min → treat as offline notice, do not block waiting", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send cccccc "给C的"' },
    },
  });
  const out = run(["send", "cccccc", "给C的"], { roomDir: dir });
  assert.match(out, /不活跃/);
  assert.match(out, /离线通知/);
  assert.match(out, /勿干等/);
});

test("send: short-id prefix matching multiple active sessions reports ambiguity (prevents prefix-collision misdelivery)", () => {
  const dir = newRoom();
  // SID_B 与 SID_C 前 6 位不同，构造共享前缀：用 log 写两个共享 6 位前缀的 sid
  const P = "bbbbbb";
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: P + "-1111", ts: Date.now() - 30000, tool: "Edit", file: "src/b1.ts" }) + "\n" +
    JSON.stringify({ kind: "edit", sid: P + "-2222", ts: Date.now() - 30000, tool: "Edit", file: "src/b2.ts" }) + "\n"
  );
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send bbbbbb "可能错投"' },
    },
  });
  const out = run(["send", "bbbbbb", "可能错投"], { roomDir: dir });
  assert.match(out, /多个活跃会话/);
});

// ── pending: read receipts of peer-to-peer messages (sender distinguishes "not seen" from "seen, no reply") ──
test("pending: lists read/unread status of peer-to-peer messages from the last hour with both parties", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: 'node .claude/room/room.js send bbbbbb "已读的"' } },
  });
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: 'node .claude/room/room.js send cccccc "未读的"' } },
  });
  // SID_B 收下第一条（落回执）
  run(["deliver"], { roomDir: dir, stdin: { hook_event_name: "Stop", session_id: SID_B } });
  const out = run(["pending"], { roomDir: dir });
  assert.match(out, /aaaaaa → bbbbbb[^]*已读/);
  assert.match(out, /aaaaaa → cccccc[^]*未读/);
});

test("pending: view full text by message id (for when the list text is truncated)", () => {
  const dir = newRoom();
  const long = "很长的协调内容".repeat(20);
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: `node .claude/room/room.js send bbbbbb "${long}"` } },
  });
  const id = lines(dir, "mailbox.jsonl")[0].id;
  const out = run(["pending", id], { roomDir: dir });
  assert.ok(out.includes(long)); // 全文不截断
});

test("send: to supports the literal all for broadcast", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send all "暂停 profit 模块"' },
    },
  });
  assert.equal(lines(dir, "mailbox.jsonl")[0].to, "all");
});

test("send: text with escaped double quotes is not truncated, quotes are restored, and the CLI does not duplicate (bug hit in practice)", () => {
  const dir = newRoom();
  const text = '收到请回 "好" 然后结束';
  const cmd = 'node .claude/room/room.js send bbbbbb "收到请回 \\"好\\" 然后结束"';
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: cmd } },
  });
  const out = run(["send", "bbbbbb", text], { roomDir: dir });
  assert.match(out, /已发送/);
  const msgs = lines(dir, "mailbox.jsonl");
  assert.equal(msgs.length, 1); // 不截断也不重复
  assert.equal(msgs[0].text, text);
});

// ── deliver: Stop hook wake-up + receipt-based dedup ──
test("deliver(Stop): unread messages addressed to me → decision:block + reason, and a receipt is persisted", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send bbbbbbbb "先停一下"' },
    },
  });
  const out = run(["deliver"], {
    roomDir: dir,
    stdin: { hook_event_name: "Stop", session_id: SID_B },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /先停一下/);
  assert.match(parsed.reason, /aaaaaa/); // 显示发送方短 id
  assert.match(parsed.reason, /发给 bbbbbbbb/); // 显示目标，接收方可核对是发给我的
  const receipts = lines(dir, "receipts.jsonl");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].sid, SID_B);
});

test("deliver(Stop): messages already receipted do not wake again (prevents loops)", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send bbbbbbbb "x"' },
    },
  });
  run(["deliver"], { roomDir: dir, stdin: { hook_event_name: "Stop", session_id: SID_B } });
  const out2 = run(["deliver"], { roomDir: dir, stdin: { hook_event_name: "Stop", session_id: SID_B } });
  assert.equal(out2.trim(), "");
  assert.equal(lines(dir, "receipts.jsonl").length, 1);
});

test("deliver(Stop): broadcast messages do not wake the sender itself", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send all "广播"' },
    },
  });
  const out = run(["deliver"], { roomDir: dir, stdin: { hook_event_name: "Stop", session_id: SID_A } });
  assert.equal(out.trim(), "");
});

test("deliver(Stop): broadcast messages wake non-senders", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send all "广播"' },
    },
  });
  const out = run(["deliver"], { roomDir: dir, stdin: { hook_event_name: "Stop", session_id: SID_B } });
  assert.equal(JSON.parse(out).decision, "block");
});

test("deliver(Stop): peer-to-peer messages are not delivered to unrelated sessions", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: {
      session_id: SID_A,
      tool_input: { command: 'node .claude/room/room.js send cccccc "给C的"' },
    },
  });
  const out = run(["deliver"], { roomDir: dir, stdin: { hook_event_name: "Stop", session_id: SID_B } });
  assert.equal(out.trim(), "");
});

test("deliver(Stop): multiple unread messages are merged into one wake-up", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: 'node .claude/room/room.js send bbbbbb "msg1"' } },
  });
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: 'node .claude/room/room.js send bbbbbb "msg2"' } },
  });
  const out = run(["deliver"], { roomDir: dir, stdin: { hook_event_name: "Stop", session_id: SID_B } });
  const reason = JSON.parse(out).reason;
  assert.match(reason, /msg1/);
  assert.match(reason, /msg2/);
  assert.equal(lines(dir, "receipts.jsonl").length, 2);
});

test("deliver(SessionStart): backlogged messages are delivered as plain text (not block JSON)", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: 'node .claude/room/room.js send bbbbbb "离线消息"' } },
  });
  const out = run(["deliver"], {
    roomDir: dir,
    stdin: { hook_event_name: "SessionStart", session_id: SID_B },
  });
  assert.match(out, /离线消息/);
  assert.throws(() => JSON.parse(out)); // 不是 JSON，是 plain context
  assert.equal(lines(dir, "receipts.jsonl").length, 1);
});

// ── inject: UserPromptSubmit pins unread messages at the top ──
test("inject: unread messages appear at the top of the report", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 60000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: 'node .claude/room/room.js send bbbbbb "看一眼"' } },
  });
  const out = run(["inject"], { roomDir: dir, stdin: { session_id: SID_B } });
  assert.match(out, /本会话短 id：bbbbbb/); // AI 认领自己身份
  assert.match(out, /看一眼/);
  assert.match(out, /src\/a\.ts/); // 原有通报内容仍在
  assert.equal(lines(dir, "receipts.jsonl").length, 1); // 注入即视为已读
});

test("inject: no unread but peer edits → still attaches this session's short id; nothing at all → no output", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 60000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  const out = run(["inject"], { roomDir: dir, stdin: { session_id: SID_B } });
  assert.match(out, /本会话短 id：bbbbbb/);
  // 无任何事：静默
  const dir2 = newRoom();
  const quiet = run(["inject"], { roomDir: dir2, stdin: { session_id: SID_B } });
  assert.equal(quiet.trim(), "");
});

// ── lock/unlock: deploy mutex (adjudication in the PreToolUse stamp hook, CLI only echoes) ──
test("lock: first acquire succeeds, the lock file records the hook's authoritative sid, and the CLI echoes the holder", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 30000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  const hookOut = run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: "node .claude/room/room.js lock deploy" } },
  });
  assert.equal(hookOut.trim(), ""); // 放行：无输出
  const lock = JSON.parse(fs.readFileSync(path.join(dir, "lock-deploy.json"), "utf8"));
  assert.equal(lock.sid, SID_A);
  const out = run(["lock", "deploy"], { roomDir: dir });
  assert.match(out, /aaaaaa/);
});

test("lock: held by an active peer → hook denies with the holder shown, the command is blocked", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 30000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: "node .claude/room/room.js lock deploy" } },
  });
  const out = run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_B, tool_input: { command: "node .claude/room/room.js lock deploy" } },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, "deny");
  assert.match(parsed.reason, /aaaaaa/); // 提示持有者短 id
  assert.match(parsed.reason, /deploy/);
  // 锁未被夺走
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "lock-deploy.json"), "utf8")).sid, SID_A);
});

test("lock: held by a peer inactive for over 30 min (stale lock) → taken over", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 40 * 60000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  fs.writeFileSync(path.join(dir, "lock-deploy.json"), JSON.stringify({ sid: SID_A, ts: Date.now() - 40 * 60000 }));
  const out = run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_B, tool_input: { command: "node .claude/room/room.js lock deploy" } },
  });
  assert.equal(out.trim(), ""); // 放行
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "lock-deploy.json"), "utf8")).sid, SID_B);
});

test("unlock: holder releases successfully; release by others is denied", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 30000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  fs.writeFileSync(path.join(dir, "lock-deploy.json"), JSON.stringify({ sid: SID_A, ts: Date.now() }));
  const denied = run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_B, tool_input: { command: "node .claude/room/room.js unlock deploy" } },
  });
  assert.equal(JSON.parse(denied).decision, "deny");
  const ok = run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: "node .claude/room/room.js unlock deploy" } },
  });
  assert.equal(ok.trim(), "");
  assert.ok(!fs.existsSync(path.join(dir, "lock-deploy.json")));
  const out = run(["unlock", "deploy"], { roomDir: dir });
  assert.match(out, /已释放|无锁/);
});

test("who: sessions within the 10-min window but idle for over 3 min are flagged as possibly idle", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 5 * 60000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  const out = run(["who"], { roomDir: dir });
  assert.match(out, /aaaaaa/);
  assert.match(out, /可能已闲置/);
});
test("who: lists active sessions' short ids, last activity, and files being edited", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 30000, tool: "Edit", file: "src/a.ts" }) + "\n" +
      JSON.stringify({ kind: "bash", sid: SID_A, ts: Date.now() - 10000, cmd: "git status" }) + "\n"
  );
  const out = run(["who"], { roomDir: dir });
  assert.match(out, /aaaaaa/);
  assert.match(out, /src\/a\.ts/);
});

// ── retention: receipts are trimmed too, otherwise receipts.jsonl grows unbounded ──
test("receipts: over 512KB with entries older than 24h → delivery triggers trimming (no unbounded growth)", () => {
  const dir = newRoom();
  // 制造 >512KB 的旧回执（25 小时前）
  const oldTs = Date.now() - 25 * 60 * 60 * 1000;
  const pad = "x".repeat(1024);
  let oldReceipts = [];
  for (let i = 0; i < 600; i++) oldReceipts.push({ id: "old-" + i + "-" + pad, sid: "deadbeef", ts: oldTs });
  fs.writeFileSync(path.join(dir, "receipts.jsonl"), oldReceipts.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const sizeBefore = fs.statSync(path.join(dir, "receipts.jsonl")).size;
  assert.ok(sizeBefore > 512 * 1024, "前置：旧回执已超阈值");
  // 一条投给 SID_B 的未读消息，inject 触发 markRead
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: 'node .claude/room/room.js send bbbbbb "修剪测试"' } },
  });
  run(["inject"], { roomDir: dir, stdin: { session_id: SID_B } });
  const after = lines(dir, "receipts.jsonl");
  assert.ok(after.every((r) => r.ts > oldTs + 60 * 60 * 1000), "旧回执应被修剪");
  assert.ok(after.some((r) => r.sid === SID_B), "新回执保留");
  const sizeAfter = fs.statSync(path.join(dir, "receipts.jsonl")).size;
  assert.ok(sizeAfter < 1024 * 1024 && sizeAfter < sizeBefore, "体积应显著缩小");
});

test("who: sessions with no activity in the last 10 min are not listed", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "edit", sid: SID_A, ts: Date.now() - 20 * 60000, tool: "Edit", file: "src/a.ts" }) + "\n"
  );
  const out = run(["who"], { roomDir: dir });
  assert.doesNotMatch(out, /aaaaaa/);
});

// ── wait: blocking poll for a reply after sending (every 3s) — reaches idle sessions that miss instant wake-ups ──

test("wait: preset unread message → returns full text immediately, short id resolved to full sid for the receipt", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "bash", sid: SID_A, ts: Date.now(), cmd: "echo hi" }) + "\n"
  );
  fs.appendFileSync(
    path.join(dir, "mailbox.jsonl"),
    JSON.stringify({ id: "m-wait-1", from: SID_B, to: "aaaaaa", ts: Date.now(), text: "这是回信内容" }) + "\n"
  );
  const out = run(["wait", "aaaaaa", "5"], { roomDir: dir });
  assert.match(out, /这是回信内容/);
  assert.match(out, /bbbbbb/); // 带发送方短 id 便于回信
  const receipts = lines(dir, "receipts.jsonl");
  assert.ok(receipts.some((r) => r.id === "m-wait-1" && r.sid === SID_A), "回执须以完整 sid 落账，防 Stop deliver 重复投递");
});

test("wait: already-receipted messages are not returned → timeout exit", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "bash", sid: SID_A, ts: Date.now(), cmd: "echo hi" }) + "\n"
  );
  fs.appendFileSync(
    path.join(dir, "mailbox.jsonl"),
    JSON.stringify({ id: "m-wait-2", from: SID_B, to: "aaaaaa", ts: Date.now(), text: "已读过的" }) + "\n"
  );
  fs.appendFileSync(
    path.join(dir, "receipts.jsonl"),
    JSON.stringify({ id: "m-wait-2", sid: SID_A, ts: Date.now() }) + "\n"
  );
  const out = run(["wait", "aaaaaa", "1"], { roomDir: dir });
  assert.match(out, /无新消息/);
  assert.doesNotMatch(out, /已读过的/);
});

test("wait: broadcast messages are also returned while waiting", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "bash", sid: SID_A, ts: Date.now(), cmd: "echo hi" }) + "\n"
  );
  fs.appendFileSync(
    path.join(dir, "mailbox.jsonl"),
    JSON.stringify({ id: "m-wait-3", from: SID_B, to: "all", ts: Date.now(), text: "全员注意" }) + "\n"
  );
  const out = run(["wait", "aaaaaa", "3"], { roomDir: dir });
  assert.match(out, /全员注意/);
});

test("wait: peer-to-peer messages are not misdelivered to unrelated sessions → timeout", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ kind: "bash", sid: SID_A, ts: Date.now(), cmd: "echo hi" }) + "\n"
  );
  fs.appendFileSync(
    path.join(dir, "mailbox.jsonl"),
    JSON.stringify({ id: "m-wait-4", from: SID_B, to: "cccccc", ts: Date.now(), text: "给C的" }) + "\n"
  );
  const out = run(["wait", "aaaaaa", "1"], { roomDir: dir });
  assert.match(out, /无新消息/);
  assert.doesNotMatch(out, /给C的/);
});

test("wait: warns when the log cannot resolve the full sid (receipt may not be recognized by deliver)", () => {
  const dir = newRoom();
  fs.appendFileSync(
    path.join(dir, "mailbox.jsonl"),
    JSON.stringify({ id: "m-wait-5", from: SID_B, to: "aaaaaa", ts: Date.now(), text: "仍能收到" }) + "\n"
  );
  const out = run(["wait", "aaaaaa", "3"], { roomDir: dir });
  assert.match(out, /仍能收到/);
  assert.match(out, /解析不到.*完整 session_id/);
});

test("wait: missing args print usage and exit 1", () => {
  const dir = newRoom();
  let code = 0;
  try {
    execFileSync("node", [ROOM_JS, "wait"], {
      input: "",
      env: { ...process.env, ROOM_DIR: dir, ROOM_LANG: "zh" },
    });
  } catch (e) {
    code = e.status;
    assert.match(String(e.stdout), /用法/);
  }
  assert.notEqual(code, 0);
});

// ── stamp tolerates || / && suffixes (real incident: a `|| echo SEND_FAILED` suffix once made the stamp miss,
//    misdiagnosed as "send timeout / hit a parallel room.js edit") ──

test("stamp-send: tolerates a || phrase suffix after the message quotes (incident original: timeout 20 … || echo SEND_FAILED)", () => {
  const dir = newRoom();
  run(
    ["stamp-send"],
    {
      roomDir: dir,
      stdin: {
        session_id: SID_A,
        tool_name: "Bash",
        tool_input: {
          command: 'timeout 20 node .claude/room/room.js send bbbbbb "先不发：前端未动" || echo SEND_FAILED',
        },
      },
    }
  );
  const msgs = lines(dir, "mailbox.jsonl");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].from, SID_A);
  assert.equal(msgs[0].to, "bbbbbb");
  assert.equal(msgs[0].text, "先不发：前端未动"); // 后缀不得混入消息文本
});

test("stamp-send: tolerates a && phrase suffix", () => {
  const dir = newRoom();
  run(
    ["stamp-send"],
    {
      roomDir: dir,
      stdin: {
        session_id: SID_A,
        tool_name: "Bash",
        tool_input: {
          command: 'node .claude/room/room.js send bbbbbb "看一眼" && echo sent',
        },
      },
    }
  );
  const msgs = lines(dir, "mailbox.jsonl");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, "看一眼");
});

test("stamp-send: a suffix containing quotes is still rejected (prevents suffix content being swallowed into the message text)", () => {
  const dir = newRoom();
  run(
    ["stamp-send"],
    {
      roomDir: dir,
      stdin: {
        session_id: SID_A,
        tool_name: "Bash",
        tool_input: {
          command: 'node .claude/room/room.js send bbbbbb "内容" || echo "done"',
        },
      },
    }
  );
  assert.equal(lines(dir, "mailbox.jsonl").length, 0);
});

test("stamp-send: pipe/redirection suffixes (| > 2>) are not tolerated, still not persisted", () => {
  const dir = newRoom();
  for (const suffix of ["| jq .", "> /dev/null"]) {
    run(
      ["stamp-send"],
      {
        roomDir: dir,
        stdin: {
          session_id: SID_A,
          tool_name: "Bash",
          tool_input: { command: `node .claude/room/room.js send bbbbbb "内容" ${suffix}` },
        },
      }
    );
  }
  assert.equal(lines(dir, "mailbox.jsonl").length, 0);
});

test("send: the stamp-miss message must state this is an instant rejection, not a timeout/hang (prevents re-misdiagnosis)", () => {
  const dir = newRoom();
  let err = null;
  try {
    run(["send", "bbbbbb", "hello"], { roomDir: dir });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应非零退出");
  const out = String(err.stdout || "") + String(err.stderr || "");
  assert.match(out, /未检测到 PreToolUse stamp/);
  assert.match(out, /不是超时|秒级拒绝/);
});

// ── unattend: unattended queue (reg/done stamped by the hook with the authoritative sid, CLI echoes the queue) ──

test("unattend reg: hook intercepts and writes with the authoritative sid, CLI confirms and echoes the queue", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: "node .claude/room/room.js unattend reg 1" } },
  });
  const entries = lines(dir, "unattend.jsonl");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "reg");
  assert.equal(entries[0].seq, 1);
  assert.equal(entries[0].sid, SID_A);
  const out = run(["unattend", "reg", "1"], { roomDir: dir });
  assert.match(out, /已注册序号 1/);
  assert.match(out, /本会话 aaaaaa/);
  assert.match(out, /下一个应执行：序号 1/);
  assert.equal(lines(dir, "unattend.jsonl").length, 1); // CLI 不重复写入
});

test("unattend reg: CLI refuses on stamp miss (same anti-misattribution as send)", () => {
  const dir = newRoom();
  let err = null;
  try {
    run(["unattend", "reg", "2"], { roomDir: dir });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应非零退出");
  assert.match(String(err.stdout || ""), /注册失败/);
  assert.equal(lines(dir, "unattend.jsonl").length, 0);
});

test("unattend: multiple seqs queue, list shows ascending order, done points to the next", () => {
  const dir = newRoom();
  for (const [sid, seq] of [[SID_A, 2], [SID_B, 1]]) {
    run(["stamp-send"], {
      roomDir: dir,
      stdin: { session_id: sid, tool_input: { command: `node .claude/room/room.js unattend reg ${seq}` } },
    });
  }
  let out = run(["unattend", "list"], { roomDir: dir });
  assert.match(out, /下一个应执行：序号 1（会话 bbbbbb）/);
  assert.match(out, /⏳ 等待中/);
  // 序号 1 完成（stamp + CLI）
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_B, tool_input: { command: "node .claude/room/room.js unattend done 1" } },
  });
  out = run(["unattend", "done", "1"], { roomDir: dir });
  assert.match(out, /序号 1 已标记完成/);
  assert.match(out, /下一个：序号 2（会话 aaaaaa）/);
  assert.match(out, /send aaaaaa "轮到你了（序号 2）/); // 直接给出唤醒命令
  out = run(["unattend", "list"], { roomDir: dir });
  assert.match(out, /下一个应执行：序号 2（会话 aaaaaa）/);
  assert.match(out, /序号 1：会话 bbbbbb ✅ 已完成/);
});

test("unattend: duplicate reg produces no duplicate entries, the queue still advances correctly", () => {
  const dir = newRoom();
  for (const cmd of ["unattend reg 1", "unattend reg 1"]) {
    run(["stamp-send"], {
      roomDir: dir,
      stdin: { session_id: SID_A, tool_input: { command: `node .claude/room/room.js ${cmd}` } },
    });
  }
  const out = run(["unattend", "list"], { roomDir: dir });
  assert.equal((out.match(/序号 1：/g) || []).length, 1); // 聚合后只显示一行
});

test("unattend: done after everything is completed says the queue is empty", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: "node .claude/room/room.js unattend reg 1" } },
  });
  run(["unattend", "reg", "1"], { roomDir: dir });
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: "node .claude/room/room.js unattend done 1" } },
  });
  const out = run(["unattend", "done", "1"], { roomDir: dir });
  assert.match(out, /队列已全部完成/);
});

test("unattend: queue status echoes the unattend lock holder (executing)", () => {
  const dir = newRoom();
  run(["stamp-send"], {
    roomDir: dir,
    stdin: { session_id: SID_A, tool_input: { command: "node .claude/room/room.js unattend reg 1" } },
  });
  fs.writeFileSync(path.join(dir, "lock-unattend.json"), JSON.stringify({ sid: SID_B, ts: Date.now() }));
  const out = run(["unattend", "list"], { roomDir: dir });
  assert.match(out, /unattend 锁：会话 bbbbbb 持有（执行中）/);
});

test("unattend: invalid seq prints usage and exits 1", () => {
  const dir = newRoom();
  let code = 0;
  try {
    run(["unattend", "reg", "abc"], { roomDir: dir });
  } catch (e) {
    code = e.status;
    assert.match(String(e.stdout), /用法/);
  }
  assert.notEqual(code, 0);
});

// ── i18n / state-dir additions ──

test("i18n: default language is English (no Chinese characters in output)", () => {
  const out = execFileSync("node", [ROOM_JS, "who"], {
    env: { ...process.env, ROOM_DIR: newRoom(), ROOM_LANG: "" },
    encoding: "utf8",
  });
  assert.ok(out.includes("[room] No active sessions"));
  assert.ok(!/[\u4e00-\u9fff]/.test(out), "en output must not contain Chinese");
});

test("i18n: ROOM_LANG=zh switches output to Chinese", () => {
  const out = execFileSync("node", [ROOM_JS, "who"], {
    env: { ...process.env, ROOM_DIR: newRoom(), ROOM_LANG: "zh" },
    encoding: "utf8",
  });
  assert.ok(out.includes("无活跃会话"));
});

test("i18n: en and zh catalogs have identical key sets", () => {
  const { catalogs } = require("./messages");
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.zh).sort());
});

test("state dir: CLAUDE_PROJECT_DIR env wins over cwd", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proj-"));
  fs.mkdirSync(path.join(proj, ".claude", "room"), { recursive: true });
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-cwd-"));
  fs.mkdirSync(path.join(cwdDir, ".claude"), { recursive: true }); // cwd fallback stays viable
  // Pre-seed a broadcast for SID_B in proj's mailbox only
  fs.appendFileSync(
    path.join(proj, ".claude", "room", "mailbox.jsonl"),
    JSON.stringify({ id: "probe1", from: SID_A, to: "bbbbbb", ts: Date.now(), text: "probe-project-dir" }) + "\n"
  );
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj, ROOM_LANG: "en" };
  delete env.ROOM_DIR; // must not let the test-injection var shadow the resolution under test
  const out = execFileSync("node", [ROOM_JS, "deliver"], {
    env,
    cwd: cwdDir,
    input: JSON.stringify({ hook_event_name: "Stop", session_id: SID_B }),
    encoding: "utf8",
  });
  assert.ok(out.includes("probe-project-dir"), "deliver must read the mailbox under CLAUDE_PROJECT_DIR");
  assert.ok(
    fs.existsSync(path.join(proj, ".claude", "room", "receipts.jsonl")),
    "the receipt must be persisted under CLAUDE_PROJECT_DIR"
  );
  assert.ok(
    !fs.existsSync(path.join(cwdDir, ".claude", "room")),
    "state must not leak into the cwd fallback dir"
  );
});

test("state dir: cwd fallback when CLAUDE_PROJECT_DIR absent", () => {
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-cwd2-"));
  fs.mkdirSync(path.join(cwdDir, ".claude", "room"), { recursive: true });
  fs.appendFileSync(
    path.join(cwdDir, ".claude", "room", "mailbox.jsonl"),
    JSON.stringify({ id: "probe2", from: SID_A, to: "bbbbbb", ts: Date.now(), text: "probe-cwd-fallback" }) + "\n"
  );
  const env = { ...process.env, ROOM_LANG: "en" };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.ROOM_DIR;
  const out = execFileSync("node", [ROOM_JS, "deliver"], {
    env,
    cwd: cwdDir,
    input: JSON.stringify({ hook_event_name: "Stop", session_id: SID_B }),
    encoding: "utf8",
  });
  assert.ok(out.includes("probe-cwd-fallback"), "deliver must fall back to <cwd>/.claude/room");
});

test("hints: stamp-miss output embeds the real script path (CLI_PATH), not the old .claude/room path", () => {
  let failed = false;
  let stdout = "";
  try {
    stdout = execFileSync("node", [ROOM_JS, "send", "zzzzzz", "x"], {
      env: { ...process.env, ROOM_DIR: newRoom(), ROOM_LANG: "" },
      encoding: "utf8",
    });
  } catch (e) {
    failed = true;
    stdout = String(e.stdout || "");
  }
  assert.ok(failed, "stamp miss must exit non-zero");
  const expect = 'node "' + __dirname.replace(/\\/g, "/") + '/room.js" send';
  assert.ok(stdout.includes(expect), `hint should embed the real script path, got: ${stdout.slice(0, 200)}`);
  assert.ok(!/\.claude\/room\/room\.js/.test(stdout), "must not hardcode the old .claude/room path");
});
