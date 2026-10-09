# claude-room

一个零依赖的 Claude Code 插件：让在**同一工作区**并行工作的多个 Claude Code
会话互相看见、互相通信、互相避让。没有守护进程、没有服务端口、没有额外安装
步骤——只有 hooks 和 `.claude/room/` 下的几个 JSON 文件。

如果你开过两三个 Claude Code 窗口改同一个仓库，一定见过这三种经典事故：

- **静默互踩文件** —— 窗口 A 重构 `src/foo.ts`，窗口 B 基于旧版本重写同一个
  文件。双方都不知道对方存在，后一次写入悄悄覆盖前一次。
- **提交卷入别人的半成品** —— 窗口 B 执行 `git add -A && git commit`，把 A
  改到一半的代码一起带进提交，历史记录从此失真。
- **无法通信** —— 你本人成了消息总线。A 做完了共享部分的重构，你得手动走到
  窗口 B 敲一句"A 完成了，你继续"，双向来回，每次都这样。

claude-room 把并行会话变成队友：文件变更广播、编辑冲突软提示、提交防混入守
卫、可唤醒闲置会话的跨会话消息、部署级互斥锁、按序号排队的无人值守队列。

> 完整设计取舍见 [DESIGN.md](DESIGN.md)（英文）。

## 工作原理

六个 hook 命令承担全部工作（接线见 [`hooks/hooks.json`](hooks/hooks.json)）：

| Hook | 事件 | 命令 | 作用 |
|---|---|---|---|
| log | PostToolUse（Edit/Write/MultiEdit/NotebookEdit/Bash） | `room.js log` | 把本会话的文件编辑和 Bash 命令（作为心跳）追加到 `log.jsonl` |
| guard-edit | PreToolUse（Edit/Write/MultiEdit/NotebookEdit） | `room.js guard-edit` | 近 10 分钟内有活跃同伴会话编辑过同一文件时软提示（additionalContext） |
| guard-commit | PreToolUse（Bash） | `room.js guard-commit` | 你要执行 git 写操作而同伴 3 分钟内刚 add/commit 过时软提示 |
| stamp-send | PreToolUse（Bash） | `room.js stamp-send` | 拦截 `send` / `lock` / `unlock` / `unattend reg\|done` 命令，在命令真正执行前用 hook 的权威 `session_id` 盖戳落盘 |
| deliver | Stop + SessionStart | `room.js deliver` | 投递未读消息；Stop 事件用 `decision: block` 立即唤醒闲置会话 |
| inject | UserPromptSubmit | `room.js inject` | 在你的下一条提示前展示其他会话近 10 分钟的文件变更和你的未读消息 |

状态就是项目 `.claude/room/` 目录下的普通 JSONL——一份只追加的活动日志、一
份信箱、一份已读回执、一份无人值守队列，外加每个锁一个小 JSON 文件。

文件变更广播：

```
 会话 A                          .claude/room/log.jsonl         会话 B
    │                                │                             │
    │ Edit src/api/user.ts           │                             │
    │── PostToolUse: log ───────────▶ append {sid:A, file, ts}     │
    │                                │                             │
    │                                │   UserPromptSubmit: inject  │
    │                                │   （B 的下一条提示）          │
    │                                │──▶ "[room] 会话 a1b2c3      │
    │                                │     2 分钟前编辑了           │
    │                                │     src/api/user.ts"        │
    │                                │                             │
    │                                │◀── B 的 PreToolUse:         │
    │                                │    guard-edit——B 若接着改   │
    │                                │    同一文件同样会收到提示    │
```

消息与闲置唤醒：

```
 会话 A                     mailbox.jsonl / receipts       会话 B（闲置，回合已结束）
    │                                │                             │
    │ Bash: room.js send b2c3d4 "…   │                             │
    │  └ PreToolUse: stamp-send ─────▶ append {from:A, to:B, text} │
    │  └ CLI send 回显：             │                             │
    │    "已发送（你是 a1b2c3）"      │                             │
    │                                │                             │
    │ Bash: room.js wait a1b2c3 120  │        Stop hook: deliver   │
    │  （阻塞，每 3 秒轮询）           │──▶ 发现 B 的未读消息 ──┐     │
    │                                │    先落已读回执        │     │
    │                                │    decision: block ────┼──▶ B 被唤醒，
    │                                │                       │     看到消息，
    │                                │    B 回复：           │     开始处理
    │                                │◀── send a1b2c3 "完成"  │     │
    │ wait 看到回复 ─────────────────│                             │
    │  打印全文、记回执、退出          │                             │
```

## 安装

marketplace 方式（推荐）：

```
/plugin marketplace add sk66666/claude-room
/plugin install claude-room@claude-room-marketplace
```

或克隆后本地试用：

```
git clone https://github.com/sk66666/claude-room.git
claude --plugin-dir ./claude-room
```

然后把状态目录加进**你使用插件的那个项目**的 `.gitignore`，避免协调数据混
进提交：

```
.claude/room/
```

## 三分钟上手（两个窗口）

1. 在同一个项目里开两个 Claude Code 窗口，插件均已启用。
2. **窗口 A**：让 Claude 改任意文件，比如"在 src/a.ts 顶部加一条注释"。
   编辑完成后，`log` hook 记录在案。
3. 切到**窗口 B**，随便问一句，哪怕只是"最近有什么变动？"。下一条提示时
   `inject` hook 会打出 `[room]` 块："会话 a1b2c3 一分钟前编辑了 src/a.ts"。
4. 在**窗口 B** 让 Claude 改同一个文件：`guard-edit` hook 注入软提示——有另
   一个活跃会话刚动过它。
5. **窗口 A**：让 Claude 用 B 的 `[room]` 块里显示的短 id 发消息（`who` 可列
   出所有短 id）：`node ".../room.js" send b2c3d4 "你好"`。回合末尾用
   `node ".../room.js" wait a1b2c3 120` 等回信，并相应调大该次 Bash 的超时。
6. 第 3 步后一直闲置的窗口 B 被 `deliver` hook 唤醒，看到消息，用
   `send a1b2c3 "…"` 回复——A 的 `wait` 当场打印出回信。

## 命令

所有命令形如 `node <room.js> <cmd>`；路径请从上下文中任一 `[room]` 提示里
复制（路径由运行时生成，可能带空格）。

| 命令 | 使用时机 |
|---|---|
| `node <room.js> who` | 点名前先列出活跃会话（短 id + 正在编辑的文件） |
| `node <room.js> send <shortId\|all> "文本"` | 单发或广播消息。必须是命令的最后一段；允许 `\|\| echo x` / `&& echo x` 不带引号的后缀 |
| `node <room.js> wait <你的短id> [秒]` | 阻塞等回信（每 3 秒轮询，默认 60 秒，上限 300 秒）。需相应调大 Bash 超时 |
| `node <room.js> pending [msgId]` | 最近一小时点对点消息的已读回执——区分"还没看"与"看了没回" |
| `node <room.js> lock\|unlock <名称>` | 跨会话互斥锁（如 `deploy`）。必须是命令末段；由 hook 裁决 |
| `node <room.js> unattend reg\|done\|list [seq]` | 注册 / 标记完成 / 列出按序号串行执行的无人值守队列 |

## 配置

无需任何配置。识别两个环境变量：

- `ROOM_LANG` —— `zh` 或 `en`（默认 `en`）。切换所有运行时文案（`[room]`
  提示、警告、命令输出）为中文。
- `ROOM_DIR` —— 覆盖状态目录，主要用于测试。默认按优先级解析为：
  `ROOM_DIR` → `$CLAUDE_PROJECT_DIR/.claude/room` → `<cwd>/.claude/room` →
  脚本所在目录（只读兜底）。

时间与体积窗口（不可配置，按实践调校）：

| 常量 | 取值 | 含义 |
|---|---|---|
| 日志保留 | 24 小时 | 超过体积上限时修剪 24 小时前的旧条目 |
| inject 窗口 | 10 分钟 | `inject` 回看的同伴文件变更范围 |
| 编辑冲突窗口 | 10 分钟 | 同伴对同一文件的编辑持续触发 `guard-edit` 的时长 |
| 活跃心跳 | 5 分钟 | 会话在该窗口内有任何记录才算"活跃" |
| 提交窗口 | 3 分钟 | 触发 `guard-commit` 的同伴 add/commit 活动范围 |
| 日志体积上限 | 512 KB | 超限时重写修剪 24 小时以上旧条目 |
| 残留锁接管 | 30 分钟 | 持有者超过此时长无活动，锁可被自动接管 |
| `wait` 轮询 | 3 秒 / 60 秒 / 300 秒 | 轮询间隔 / 默认超时 / 硬上限 |

## 从手工安装迁移

**重要：** 如果你此前在项目的 `.claude/settings.json`（或
`settings.local.json`）里手工接过同款 hooks，插件的 hooks 会**与之并存双
跑**——每个 hook 触发两次，`[room]` 块里的消息重复注入、警告出现两遍、信
箱条目翻倍。

启用插件前，先移除手工接线：

1. 打开项目的 `.claude/settings.json`（和 `.claude/settings.local.json`）。
2. 删掉整个 `hooks` 对象（或其中命令里调用 `room.js` 的条目）。
3. 在 settings 里全文搜索 `room.js`，确认没有残留引用。
4. 启用/安装插件，重启会话，确认每个 `[room]` 块只出现一次。

其他注册了这些 hook 命令的插件或 skill 同理——每个事件 claude-room 只能有一
份接线。

## 常见问题

**消息什么时候真正送达？**
在**收件会话的下一个回合结束**（Stop hook）或下次会话启动时，以先到者为
准。收件方正处在长回合中时，投递会等待。`send` 本身绝不阻塞对方；`wait` 只
是发信方自己在等回信。

**为什么 CLI 不知道自己的会话 id？**
`room.js send` 只是 Bash 工具的子进程，没有可靠途径得知自己是哪个 Claude
会话派生的。因此所有带身份的写入都必须经过 PreToolUse hook——它的输入携带
权威 `session_id`；CLI 只负责回显与去重（"盖戳模式"，见
[DESIGN.md](DESIGN.md)）。盖戳未命中一律拒绝，绝不猜。

**支持远程 / 多机吗？**
不支持。协调状态放在同一文件系统的同一个目录里，不同机器（或同一仓库的不
同克隆）上的会话互相看不见。仅限同机同一工作区。

**有服务端、端口或守护进程要照顾吗？**
没有。一切都是短命进程操作普通文件，理由见 [DESIGN.md](DESIGN.md)。

**hook 被禁用或出错会怎样？**
优雅降级：内部错误一律静默吞掉，绝不打断你的流程；最坏情况只是 `[room]`
块没出现。

## 许可证

[MIT](LICENSE)
