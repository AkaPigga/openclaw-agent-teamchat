import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizePluginConfig } from "../src/config.js";
import { TeamChatState } from "../src/state.js";
import { createTeamChatRuntime } from "../src/runtime.js";

function makeApi(config, pluginConfigOverride = {}, options = {}) {
  const enqueued = [];
  const commandRuns = [];
  const logs = { info: [], warn: [], debug: [] };
  const routeResolver =
    typeof options.routeResolver === "function"
      ? options.routeResolver
      : ({ channel, accountId, peer }) => ({
          agentId: `agent:${accountId || "unknown"}`,
          sessionKey: `${channel}:${accountId || "none"}:${peer.kind}:${peer.id}`
        });

  const api = {
    config,
    pluginConfig: pluginConfigOverride,
    logger: {
      info: (msg) => logs.info.push(String(msg)),
      warn: (msg) => logs.warn.push(String(msg)),
      debug: (msg) => logs.debug.push(String(msg))
    },
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: (params) => routeResolver(params)
        }
      },
      system: {
        enqueueSystemEvent: (text, opts) => {
          enqueued.push({ text, opts });
        },
        runCommandWithTimeout: async (argv) => {
          commandRuns.push(argv.slice());
          if (options.commandRunner) return options.commandRunner(argv);
          return { stdout: "", stderr: "", code: 0, signal: null, killed: false };
        }
      }
    }
  };

  const normalized = normalizePluginConfig(pluginConfigOverride, config);
  const state = new TeamChatState({ persistence: false });
  const runtime = createTeamChatRuntime(api, normalized, state);

  return { api, runtime, state, normalized, enqueued, commandRuns, logs };
}

const baseConfig = {
  bindings: [
    { agentId: "main", match: { channel: "feishu", accountId: "main-bot" } },
    { agentId: "researcher", match: { channel: "feishu", accountId: "research-bot" } },
    { agentId: "builder", match: { channel: "feishu", accountId: "builder-bot" } }
  ]
};

test("before_tool_call rewrites dm accountId with identity mode=rewrite", () => {
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: true, scope: "dm-only", mode: "rewrite" },
    teamroom: { enabled: false }
  });

  const result = runtime.beforeToolCall(
    {
      toolName: "message",
      params: {
        action: "send",
        target: "user:ou_user_1",
        message: "hello"
      }
    },
    { agentId: "researcher", toolName: "message", sessionKey: "x" }
  );

  assert.equal(result?.params?.accountId, "research-bot");
});

test("before_tool_call normalizes feishu-prefixed dm target", () => {
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: true, scope: "dm-only", mode: "rewrite" },
    teamroom: { enabled: false }
  });

  const result = runtime.beforeToolCall(
    {
      toolName: "message",
      params: {
        action: "send",
        target: "feishu:user:ou_user_1",
        message: "hello"
      }
    },
    { agentId: "researcher", toolName: "message", sessionKey: "x" }
  );

  assert.equal(result?.params?.target, "user:ou_user_1");
  assert.equal(result?.params?.accountId, "research-bot");
});

test("before_tool_call normalizes feishu-prefixed group target without dm identity rewrite", () => {
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: true, scope: "dm-only", mode: "rewrite" },
    teamroom: { enabled: false }
  });

  const result = runtime.beforeToolCall(
    {
      toolName: "message",
      params: {
        action: "send",
        target: "feishu:oc_75bb8eb2cb0c150da669ec40656730c4",
        message: "hello"
      }
    },
    { agentId: "researcher", toolName: "message", sessionKey: "x" }
  );

  assert.equal(result?.params?.target, "chat:oc_75bb8eb2cb0c150da669ec40656730c4");
  assert.equal(result?.params?.accountId, undefined);
});

test("before_tool_call does not enforce dm-only identity on group target", () => {
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: true, scope: "dm-only", mode: "rewrite" },
    teamroom: { enabled: false }
  });

  const result = runtime.beforeToolCall(
    {
      toolName: "message",
      params: {
        action: "send",
        target: "oc_75bb8eb2cb0c150da669ec40656730c4",
        message: "hello group"
      }
    },
    { agentId: "researcher", toolName: "message", sessionKey: "x" }
  );
  assert.equal(result, undefined);
});

test("before_tool_call blocks mismatch when identity mode=block", () => {
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: true, scope: "all-feishu", mode: "block" },
    teamroom: { enabled: false }
  });

  const result = runtime.beforeToolCall(
    {
      toolName: "message",
      params: {
        action: "send",
        target: "user:ou_user_1",
        accountId: "main-bot",
        message: "hello"
      }
    },
    { agentId: "researcher", toolName: "message", sessionKey: "x" }
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason ?? "", /mismatch/i);
});

test("sticky_output rewrites dm reply to active room (all-members seed on external message)", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: true, scope: "dm-only", mode: "rewrite" },
    teamroom: {
      enabled: true,
      stickyOutput: {
        enabled: true,
        mode: "rewrite",
        scope: "dm-only",
        seedMode: "all-members-on-external",
        ttlSeconds: 900
      },
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher", "builder"],
          forwardMode: "mentions-or-all"
        }
      ]
    }
  });

  await runtime.messageReceived(
    {
      from: "feishu:ou_user_1",
      content: "请 @main 协调这件事",
      timestamp: Date.now(),
      metadata: { messageId: "msg-sticky-seed-1", senderName: "Finley", senderId: "ou_user_1" }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  const result = runtime.beforeToolCall(
    {
      toolName: "message",
      params: {
        action: "send",
        target: "user:ou_private_1",
        message: "我私聊回你"
      }
    },
    { agentId: "researcher", toolName: "message", sessionKey: "x" }
  );

  assert.equal(result?.params?.target, `chat:${roomId}`);
  assert.equal(result?.params?.accountId, "research-bot");
});

test("sticky_output can block dm reply when mode=block", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      stickyOutput: {
        enabled: true,
        mode: "block",
        scope: "dm-only",
        seedMode: "all-members-on-external",
        ttlSeconds: 900
      },
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher", "builder"],
          forwardMode: "mentions-or-all"
        }
      ]
    }
  });

  await runtime.messageReceived(
    {
      from: "feishu:ou_user_1",
      content: "请大家讨论一下",
      timestamp: Date.now(),
      metadata: { messageId: "msg-sticky-seed-2", senderName: "Finley", senderId: "ou_user_1" }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  const result = runtime.beforeToolCall(
    {
      toolName: "message",
      params: {
        action: "send",
        target: "user:ou_private_1",
        message: "我私聊回你"
      }
    },
    { agentId: "builder", toolName: "message", sessionKey: "x" }
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason ?? "", /sticky-output/i);
});

test("room turn limiter blocks after configured max turns and resets on inbound external message", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      rooms: [{ id: roomId, memberAgents: ["main", "researcher"], maxTurnsPerCycle: 2 }]
    }
  });

  const payload = {
    toolName: "message",
    params: { action: "send", target: roomId, message: "group reply" }
  };
  const ctx = { agentId: "main", toolName: "message", sessionKey: "main" };

  assert.equal(runtime.beforeToolCall(payload, ctx), undefined);
  assert.equal(runtime.beforeToolCall(payload, ctx), undefined);
  const blocked = runtime.beforeToolCall(payload, ctx);
  assert.equal(blocked?.block, true);

  await runtime.messageReceived(
    {
      from: "feishu:ou_user_1",
      content: "new user input",
      timestamp: Date.now(),
      metadata: { messageId: "m-user-1", senderName: "Finley" }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  assert.equal(runtime.beforeToolCall(payload, ctx), undefined);
});

test("message_received forwards room transcript to mentioned agent only when forwardMode=mentions-or-all", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher", "builder"],
          forwardMode: "mentions-or-all",
          includeSourceAgent: false,
          mentionAliases: {
            researcher: ["@researcher", "researcher"]
          }
        }
      ]
    }
  });

  await runtime.messageReceived(
    {
      from: "feishu:ou_user_1",
      content: "请 @researcher 看看这个问题",
      timestamp: Date.now(),
      metadata: {
        messageId: "msg-mention-1",
        senderName: "Finley",
        senderId: "ou_user_1"
      }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  // beforeAgentStart injects context — verify researcher gets unread messages
  const result = runtime.beforeAgentStart({}, { agentId: "researcher", sessionKey: `feishu:research-bot:chat:${roomId}` });
  assert.ok(result?.prependContext, "researcher should get prependContext");
  assert.match(result.prependContext, /\[teamroom-context room=/);
});

test("message_received does not infer source agent from receiver account for external user message", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher"],
          forwardMode: "mentions-or-all",
          includeSourceAgent: false
        }
      ]
    }
  });

  await runtime.messageReceived(
    {
      from: "feishu:ou_user_external",
      content: "请大家都看看这个问题",
      timestamp: Date.now(),
      metadata: {
        messageId: "msg-ext-user-1",
        senderName: "Finley",
        senderId: "ou_user_external"
      }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  // Both main and researcher should get context via beforeAgentStart
  const mainResult = runtime.beforeAgentStart({}, { agentId: "main", sessionKey: `feishu:main-bot:chat:${roomId}` });
  const researcherResult = runtime.beforeAgentStart({}, { agentId: "researcher", sessionKey: `feishu:research-bot:chat:${roomId}` });
  assert.ok(mainResult?.prependContext, "main should get prependContext");
  assert.ok(researcherResult?.prependContext, "researcher should get prependContext");
  assert.match(mainResult.prependContext, /\[teamroom-context room=/);
});

test("message_received blocks unsafe relay route to non-group main session", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime, enqueued, logs } = makeApi(
    baseConfig,
    {
      identity: { enabled: false },
      teamroom: {
        enabled: true,
        rooms: [
          {
            id: roomId,
            memberAgents: ["builder"],
            forwardMode: "mentions-only",
            mentionAliases: {
              builder: ["@builder"]
            }
          }
        ]
      }
    },
    {
      routeResolver: ({ channel, accountId, peer }) => {
        if (accountId === "builder-bot") {
          return {
            agentId: "builder",
            sessionKey: "agent:builder:main"
          };
        }
        return {
          agentId: "builder",
          sessionKey: `${channel}:${accountId || "none"}:${peer.kind}:${peer.id}`
        };
      }
    }
  );

  await runtime.messageReceived(
    {
      from: "feishu:ou_user_1",
      content: "请 @builder 看一下",
      timestamp: Date.now(),
      metadata: {
        messageId: "msg-unsafe-route-1",
        senderName: "Finley",
        senderId: "ou_user_1"
      }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  assert.equal(enqueued.length, 0);
  // beforeAgentStart should not inject context into non-group session (agent:builder:main has no oc_ roomId)
  const result = runtime.beforeAgentStart({}, { agentId: "builder", sessionKey: "agent:builder:main" });
  assert.equal(result, undefined, "unsafe/non-group session should not get prependContext");
});

test("message_received can infer source agent via identity.agentSenderIds", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: {
      enabled: false,
      agentSenderIds: {
        main: "ou_main_bot_sender"
      }
    },
    teamroom: {
      enabled: true,
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher"],
          forwardMode: "mentions-or-all",
          includeSourceAgent: false
        }
      ]
    }
  });

  await runtime.messageReceived(
    {
      from: "feishu:ou_main_bot_sender",
      content: "这是机器人在群里的发言",
      timestamp: Date.now(),
      metadata: {
        messageId: "msg-main-bot-1",
        senderName: "龙虾秘书",
        senderId: "ou_main_bot_sender"
      }
    },
    {
      channelId: "feishu",
      accountId: "research-bot",
      conversationId: `chat:${roomId}`
    }
  );

  // researcher should get context (main is source agent, excluded)
  const result = runtime.beforeAgentStart({}, { agentId: "researcher", sessionKey: `feishu:research-bot:chat:${roomId}` });
  assert.ok(result?.prependContext, "researcher should get prependContext");
  assert.match(result.prependContext, /\[teamroom-context room=/);
});

test("protocol signals are mirrored to main and visible in tasks command", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime, enqueued } = makeApi(baseConfig, {
    identity: {
      enabled: false,
      agentSenderIds: {
        researcher: "ou_research_bot_sender"
      }
    },
    teamroom: {
      enabled: true,
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher", "builder"],
          forwardMode: "mentions-only",
          mentionAliases: {
            builder: ["@builder"]
          },
          protocol: {
            enabled: true,
            mainAgentId: "main",
            mirrorToMain: "signals-only",
            signalPrefix: "[task]"
          }
        }
      ]
    },
    command: { enabled: true, name: "teamroom" }
  });

  await runtime.messageReceived(
    {
      from: "feishu:ou_research_bot_sender",
      content: "请 @builder 接手\n[task] id=T-100 status=in_progress note=实现中",
      timestamp: Date.now(),
      metadata: {
        messageId: "msg-task-signal-1",
        senderName: "龙虾研究生",
        senderId: "ou_research_bot_sender"
      }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  // builder gets context via beforeAgentStart (mention → forward target)
  const builderResult = runtime.beforeAgentStart({}, { agentId: "builder", sessionKey: `feishu:builder-bot:chat:${roomId}` });
  assert.ok(builderResult?.prependContext, "builder should get prependContext");
  assert.match(builderResult.prependContext, /\[teamroom-context room=/);

  const tasks = runtime.commandHandler({ args: `tasks ${roomId}` });
  assert.match(tasks.text, /T-100/);
  assert.match(tasks.text, /status=in_progress/);
});



test("task command can create task by inferring room from conversation", () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher", "builder"],
          protocol: { enabled: true }
        }
      ]
    },
    command: { enabled: true, name: "teamroom" }
  });

  const created = runtime.commandHandler({
    args: "task create T-200 owner=researcher note=\"手动 创建\"",
    conversationId: `chat:${roomId}`,
    senderName: "Finley"
  });
  assert.match(created.text, /task updated/);
  assert.match(created.text, /task=T-200/);
  assert.match(created.text, /owner=researcher/);

  const tasks = runtime.commandHandler({ args: `tasks ${roomId}` });
  assert.match(tasks.text, /T-200/);
  assert.match(tasks.text, /status=create/);
  assert.match(tasks.text, /owner=researcher/);
  assert.match(tasks.text, /note=手动 创建/);
});

test("task command blocks creating a new active task when one is running", () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher", "builder"],
          protocol: { enabled: true }
        }
      ]
    },
    command: { enabled: true, name: "teamroom" }
  });

  runtime.commandHandler({
    args: "task create T-260 owner=researcher note=\"先启动任务\"",
    conversationId: `chat:${roomId}`,
    senderName: "Finley"
  });

  const conflict = runtime.commandHandler({
    args: "task create T-261 owner=builder note=\"尝试新任务\"",
    conversationId: `chat:${roomId}`,
    senderName: "Finley"
  });
  assert.match(conflict.text, /active task conflict/i);
  assert.match(conflict.text, /active=T-260/);
});

test("task command can update task status and note", () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher", "builder"],
          protocol: { enabled: true }
        }
      ]
    },
    command: { enabled: true, name: "teamroom" }
  });

  runtime.commandHandler({
    args: "task create T-201 owner=builder",
    conversationId: `chat:${roomId}`,
    senderName: "Finley"
  });
  const updated = runtime.commandHandler({
    args: "task update T-201 done 验收 通过",
    conversationId: `chat:${roomId}`,
    senderName: "Finley"
  });
  assert.match(updated.text, /task=T-201/);
  assert.match(updated.text, /status=done/);
  assert.match(updated.text, /closed=yes/);
  assert.match(updated.text, /note=验收 通过/);

  const tasks = runtime.commandHandler({ args: `tasks ${roomId}` });
  assert.match(tasks.text, /T-201/);
  assert.match(tasks.text, /active=none/);
  assert.match(tasks.text, /lastClosed=T-201:done/);
});

test("task command requires room hint when multiple rooms and no conversation room", () => {
  const roomA = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const roomB = "oc_75bb8eb2cb0c150da669ec4065673000";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      rooms: [
        { id: roomA, memberAgents: ["main"], protocol: { enabled: true } },
        { id: roomB, memberAgents: ["main"], protocol: { enabled: true } }
      ]
    },
    command: { enabled: true, name: "teamroom" }
  });

  const result = runtime.commandHandler({
    args: "task create T-202 owner=main",
    senderName: "Finley"
  });
  assert.match(result.text, /room is required/i);
});

test("autopilot dry-run records command attempts when no mention (mentions-or-all)", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime } = makeApi(baseConfig, {
    identity: { enabled: false },
    teamroom: {
      enabled: true,
      rooms: [
        {
          id: roomId,
          memberAgents: ["main", "researcher", "builder"],
          autopilot: {
            enabled: true,
            trigger: "mentions-or-all",
            dryRun: true
          }
        }
      ]
    },
    command: { enabled: true, name: "teamroom" }
  });

  await runtime.messageReceived(
    {
      from: "feishu:ou_user_1",
      content: "大家看一下这个问题",
      timestamp: Date.now(),
      metadata: { messageId: "msg-auto-1", senderName: "Finley", senderId: "ou_user_1" }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  const status = runtime.commandHandler({
    args: "status",
    commandBody: "/teamroom status",
    channel: "feishu",
    isAuthorizedSender: true
  });
  assert.match(status.text, /Recent autopilot/);
});

test("autopilot executes agent then message send when reply is not NO_REPLY (no mention)", async () => {
  const roomId = "oc_75bb8eb2cb0c150da669ec40656730c4";
  const { runtime, commandRuns } = makeApi(
    baseConfig,
    {
      identity: { enabled: false },
      teamroom: {
        enabled: true,
        rooms: [
          {
            id: roomId,
            memberAgents: ["builder"],
            protocol: {
              enabled: true,
              signalPrefix: "[task]"
            },
            autopilot: {
              enabled: true,
              trigger: "mentions-or-all",
              dryRun: false,
              timeoutSeconds: 30
            }
          }
        ]
      }
    },
    {
      commandRunner: (argv) => {
        if (argv[1] === "agent") {
          return {
            stdout: JSON.stringify({ payloads: [{ text: "收到，我来处理。" }] }),
            stderr: "",
            code: 0,
            signal: null,
            killed: false
          };
        }
        if (argv[1] === "message") {
          return { stdout: "ok", stderr: "", code: 0, signal: null, killed: false };
        }
        return { stdout: "", stderr: "", code: 1, signal: null, killed: false };
      }
    }
  );

  await runtime.messageReceived(
    {
      from: "feishu:ou_user_1",
      content: "请大家看一下",
      timestamp: Date.now(),
      metadata: { messageId: "msg-auto-run-1", senderName: "Finley", senderId: "ou_user_1" }
    },
    {
      channelId: "feishu",
      accountId: "main-bot",
      conversationId: `chat:${roomId}`
    }
  );

  assert.equal(commandRuns.length, 2);
  assert.equal(commandRuns[0][1], "agent");
  assert.match(commandRuns[0].join(" "), /\[task\] id=<task_id>/);
  assert.equal(commandRuns[1][1], "message");
  assert.equal(commandRuns[1][2], "send");
  assert.match(commandRuns[1].join(" "), /--account builder-bot/);
});



