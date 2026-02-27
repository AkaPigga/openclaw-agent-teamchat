# agent-teamchat 插件 v3

多 agent 群聊协作插件。核心能力：身份规范化、群聊上下文共享、任务看板、自动调度。

## 一、核心原理

### 消息流

```
飞书群消息到达
  → message_received：写入 messages.jsonl 缓存
  → before_agent_start：读缓存 → prependContext 注入 system prompt
  → agent 处理（上下文已在 system prompt 里，不污染对话历史）
  → before_message_write / message_sending：agent 回复写缓存 → 发飞书群
```

**关键设计**：上下文通过 `before_agent_start` hook 的 `prependContext` 注入，而不是 system event。这意味着：
- 任何 channel（飞书/webchat/dashboard）触发的 agent 都能收到群聊上下文
- 上下文在 system prompt 里，不会出现在对话历史中
- watermark 在 agent 实际读取时才推进（`markAllAsRead` 在 `beforeAgentStart` 里调用）

### 数据存储

```
~/.openclaw/plugin-data/agent-teamchat/rooms/<roomId>/
├── messages.jsonl      # 消息缓存（append-only）
├── watermarks.json     # 各 agent 已读水位 {lastReadId, lastReadTs}
└── tasks/
    ├── active/         # 活跃任务（每个 taskId 一个 json）
    ├── history/        # 已关闭任务
    └── board.json      # 看板摘要
```

### 上下文注入格式

agent 收到的 system prompt 前缀：

```
以下是最新的群聊记录，可作为参考：
[teamroom-context room=<roomId> unread=<n>]
[HH:MM sender] 消息内容
...
[/teamroom-context]

[task-board]
T-0227-1 | status=in_progress | builder: in_progress(实现中) | main: ack
[/task-board]
```

---

## 二、功能模块

### 1. 身份规范化（before_tool_call）

agent 调用 `message` 工具时，自动将 `accountId` 改写为该 agent 对应的飞书机器人账号。

配置：`identity.agentAccounts` 或从 `bindings` 自动推导（`deriveFromBindings=true`）。

### 2. 群聊消息缓存（MessageCache）

- 所有群消息写入 `messages.jsonl`
- 过滤系统注入块（`<relevant-memories>` / `[UNTRUSTED DATA`）
- 外部消息用复合 id（`msg:roomId:ts:hash`），不用飞书原始 `om_xxx`，避免 watermark 污染
- 自动清理：10% 概率触发，删除所有 agent 都已读的旧消息

### 3. 任务看板（TaskBoard v3 slots 模式）

每个 agent 独立槽位，整体状态自动推导：

| 条件 | 整体状态 |
|------|---------|
| 所有槽位 done/review_ok | done |
| 任一槽位 blocked | blocked |
| 任一槽位 in_progress | in_progress |
| 所有槽位 ack | ack |
| 无槽位 | create |

旧格式（无 slots）自动 migration。

任务信号格式：
```
[task] id=<taskId> status=<ack|in_progress|blocked|done|review_ok|rework> note=<一句话>
```

### 4. 消息转发（Forward）

`forwardMode` 控制转发目标：
- `mentions-only`：只转发给被 @mention 的 agent
- `mentions-or-all`：有 mention 只转发给被 mention 的，无 mention 转发给所有成员
- `all-members`：始终转发给所有成员

mention 识别通过 `mentionAliases` 配置，支持中文别名。

### 5. Autopilot 自动调度

**Phase 3 后**：autopilot 只处理**非 mention** 消息，mention 场景走原生路由 + `before_agent_start` 注入。

- `trigger=mentions-or-all`：无 mention 消息自动 dispatch 给所有成员
- 支持 `dryRun` 模式（只记录不执行）
- dispatch 后把 agent 回复发回飞书群

### 6. 协议信号（Protocol）

解析群消息里的 `[task]` 信号，同步到 TaskBoard，并可镜像给 main（带 `[mirror-only]` 前缀）。

---

## 三、配置说明

### 最小配置

```json
{
  "identity": {
    "enabled": true,
    "deriveFromBindings": true
  },
  "teamroom": {
    "enabled": true,
    "rooms": [
      {
        "id": "oc_xxx",
        "memberAgents": ["main", "researcher", "builder"],
        "forwardMode": "mentions-or-all",
        "protocol": {
          "enabled": true,
          "signalPrefix": "[task]"
        }
      }
    ]
  },
  "command": { "enabled": true, "name": "teamroom" }
}
```

### 关键配置项

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `identity.mode` | `rewrite` | `rewrite`/`block`/`rewrite-and-log` |
| `identity.agentSenderIds` | `{}` | `agentId -> ou_xxx`，用于识别 bot 发言来源 |
| `teamroom.contextMaxMessages` | `50` | 注入上下文最大消息条数 |
| `teamroom.contextMaxChars` | `8000` | 注入上下文最大字符数 |
| `rooms[].maxTurnsPerCycle` | `3` | 每轮最大发言次数 |
| `rooms[].cycleTtlSeconds` | `900` | 轮次状态过期时间 |
| `rooms[].autopilot.enabled` | `false` | 是否启用自动调度 |
| `rooms[].autopilot.trigger` | `mentions-only` | `mentions-only`/`mentions-or-all` |
| `rooms[].protocol.mirrorToMain` | `signals-only` | `off`/`signals-only`/`all-agent-messages` |

---

## 四、命令手册

| 命令 | 说明 |
|------|------|
| `/teamroom status` | 查看 room 状态、dispatch 计数、缓存统计 |
| `/teamroom tasks [roomId\|all]` | 查看任务看板 |
| `/teamroom task create <id> [owner=<agentId>] [note=<text>]` | 创建任务 |
| `/teamroom task update <id> <status> [note=<text>]` | 更新任务状态 |
| `/teamroom reset <roomId\|all>` | 重置 room cycle |
| `/teamroom reset-watermark [roomId\|all]` | 重置已读水位到当前时间（gateway restart 后用） |

任务状态值：`create` / `ack` / `in_progress` / `blocked` / `done` / `review_ok` / `rework`

---

## 五、任务生命周期

```
main 创建任务
  /teamroom task create T-0227-1 owner=builder note=实现XXX
  → [task] id=T-0227-1 status=ack note=已派发给builder

builder 收到后
  → [task] id=T-0227-1 status=in_progress note=开始执行
  → [task] id=T-0227-1 status=done note=完成

main 验收
  → [task] id=T-0227-1 status=review_ok note=验收通过
```

---

## 六、常见问题

**Q：gateway restart 后旧消息重复出现？**
执行 `/teamroom reset-watermark` 重置水位。

**Q：上下文里时间戳显示不对？**
v3 已修复，显示本地时间（Asia/Shanghai）。

**Q：webchat/dashboard 里对话能同步到群聊吗？**
能。`before_agent_start` 不限 channel，任何触发方式都会注入群聊上下文。但 webchat 里的对话内容本身不会写入群聊缓存（只有飞书群消息才写缓存）。

**Q：relevant-memories 出现在群聊上下文里？**
v3 已修复，`appendMessage` 自动过滤系统注入块。

---

## 七、开发与测试

```bash
cd /Users/finley/.openclaw/workspace/plugins/agent-teamchat
node --test test/*.test.js
```

当前测试：43 个，覆盖身份规范化、消息转发、轮次限制、autopilot、TaskBoard v3、MessageCache。

---

## 八、已删除功能（v3）

- **SmartTask**：LLM 自动判断任务，已全删（runtime.js/config.js/openclaw.json）
- **relay/mirror/echo 机制**：v2 Phase2 已全删，改为纯缓存驱动
- **enqueueRoomEventToAgent**：v3 改用 `before_agent_start` + `prependContext`，system event 注入方式已废弃
