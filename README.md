# agent-teamchat

OpenClaw 多 Agent 群聊协作插件。让多个 agent 共享同一个飞书群聊上下文，支持任务看板、消息缓存、身份隔离。

## 功能

- **群聊上下文注入**：每次 agent 被触发时，自动把未读群消息注入 system prompt（`beforeAgentStart` + `prependContext`），agent 无需手动读取
- **消息缓存**：所有群消息缓存到本地 `messages.jsonl`，watermark 追踪每个 agent 的已读位置
- **身份隔离**：多个 bot 账号（main-bot / builder-bot / research-bot）映射到对应 agent，发消息时自动切换身份
- **Task 看板（slots 模式）**：每个 agent 独立槽位，通过 `[task]` 信号维护任务状态，整体状态自动推导
- **Turn limit**：每个 cycle 最多 3 轮 agent 互发，防止死循环

## Agent 触发机制

插件**不会自动触发** agent。agent 要叫另一个 agent，必须两步走：

1. 发群消息（`message` 工具）
2. 手动调用 `sessions_send` 精准触发对方

```
// 叫 main
sessions_send(sessionKey="agent:main:feishu:group:<roomId>", message="...")

// 叫 builder
sessions_send(sessionKey="agent:builder:feishu:group:<roomId>", message="...")

// 叫 researcher
sessions_send(sessionKey="agent:researcher:feishu:group:<roomId>", message="...")
```

> ⚠️ 群里写 @xxx 不等于触发对方，必须同时调用 `sessions_send`，否则对方收不到。

## ⚠️ 风险提示

### mentionedDispatch（已关闭）

插件支持 `autopilot.mentionedDispatch` 配置项：agent 在群里 @mention 另一个 agent 时，插件自动 dispatch 目标 agent。

**当前配置：`mentionedDispatch: false`（已关闭）**

关闭原因：
- 与手动 `sessions_send` 叠加触发，导致目标 agent 被触发两次，群里出现重复回复
- `openclaw agent` 命令不支持 `--session` 参数，dispatch 路由依赖 gateway 自动选择最近活跃 session，行为不完全可预测
- 两步走方案（发群 + sessions_send）更可控，出问题更容易排查

如需开启，在 `openclaw.json` 中设置：
```json
"autopilot": {
  "mentionedDispatch": true
}
```
开启后，agent @mention 时**不要再手动 sessions_send**，否则会双重触发。

## Task 信号格式

```
[task] id=T-0227-1 status=ack note=已收到，开始执行
[task] id=T-0227-1 status=in_progress note=正在实现
[task] id=T-0227-1 status=done note=完成，43/43测试通过
```

状态：`ack` → `in_progress` → `done` / `blocked` / `review_ok` / `rework`

## 安装

```bash
# 复制到 OpenClaw plugins 目录
cp -r agent-teamchat ~/.openclaw/workspace/plugins/

# 在 openclaw.json 中启用
```

## 配置示例

```json
{
  "plugins": {
    "entries": {
      "agent-teamchat": {
        "teamroom": {
          "enabled": true,
          "channel": "feishu",
          "rooms": [
            {
              "id": "oc_xxx",
              "enabled": true,
              "memberAgents": ["main", "builder", "researcher"],
              "agentAccounts": {
                "main": "main-bot",
                "builder": "builder-bot",
                "researcher": "research-bot"
              }
            }
          ]
        }
      }
    }
  }
}
```

## 群内命令

- `/teamroom status` — 查看协作状态
- `/teamroom tasks` — 查看任务看板
- `/teamroom reset <roomId>` — 重置 turn limit

## 测试

```bash
node --test test/*.test.js
```

43 个测试用例，覆盖消息缓存、任务看板、配置解析、上下文注入。
