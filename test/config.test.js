import test from "node:test";
import assert from "node:assert/strict";
import { normalizePluginConfig } from "../src/config.js";

test("normalizePluginConfig derives feishu agent->account mapping from bindings", () => {
  const cfg = {
    bindings: [
      { agentId: "main", match: { channel: "feishu", accountId: "main-bot" } },
      { agentId: "researcher", match: { channel: "feishu", accountId: "research-bot" } },
      { agentId: "builder", match: { channel: "feishu", accountId: "builder-bot" } }
    ]
  };
  const normalized = normalizePluginConfig({}, cfg);
  assert.equal(normalized.identity.agentToAccount.main, "main-bot");
  assert.equal(normalized.identity.agentToAccount.researcher, "research-bot");
  assert.equal(normalized.identity.accountToAgent["builder-bot"], "builder");
});

test("normalizePluginConfig keeps room defaults and clamps limits", () => {
  const normalized = normalizePluginConfig(
    {
      teamroom: {
        rooms: [
          {
            id: "oc_test",
            maxTurnsPerCycle: 999,
            cycleTtlSeconds: 1,
            outgoingEchoWindowSeconds: 9999
          }
        ]
      }
    },
    { bindings: [] }
  );
  const room = normalized.teamroom.roomsById.oc_test;
  assert.equal(room.maxTurnsPerCycle, 20);
  assert.equal(room.cycleTtlSeconds, 30);
  assert.equal(room.outgoingEchoWindowSeconds, 3600);
});

test("normalizePluginConfig command.requireAuth defaults to false and supports true", () => {
  const normalizedDefault = normalizePluginConfig({}, { bindings: [] });
  assert.equal(normalizedDefault.command.requireAuth, false);

  const normalizedStrict = normalizePluginConfig(
    {
      command: {
        requireAuth: true
      }
    },
    { bindings: [] }
  );
  assert.equal(normalizedStrict.command.requireAuth, true);
});

test("normalizePluginConfig keeps identity.agentSenderIds mappings", () => {
  const normalized = normalizePluginConfig(
    {
      identity: {
        agentSenderIds: {
          main: "ou_main_sender",
          researcher: "ou_research_sender"
        }
      }
    },
    { bindings: [] }
  );
  assert.equal(normalized.identity.agentToSenderId.main, "ou_main_sender");
  assert.equal(normalized.identity.senderIdToAgent.ou_research_sender, "researcher");
});

test("normalizePluginConfig stickyOutput keeps defaults and normalizes values", () => {
  const normalizedDefault = normalizePluginConfig({}, { bindings: [] });
  assert.equal(normalizedDefault.teamroom.stickyOutput.enabled, false);
  assert.equal(normalizedDefault.teamroom.stickyOutput.mode, "rewrite");
  assert.equal(normalizedDefault.teamroom.stickyOutput.scope, "dm-only");
  assert.equal(normalizedDefault.teamroom.stickyOutput.seedMode, "all-members-on-external");

  const normalizedCustom = normalizePluginConfig(
    {
      teamroom: {
        stickyOutput: {
          enabled: true,
          mode: "block",
          scope: "all-non-room",
          ttlSeconds: 9,
          seedMode: "forward-targets"
        }
      }
    },
    { bindings: [] }
  );
  assert.equal(normalizedCustom.teamroom.stickyOutput.enabled, true);
  assert.equal(normalizedCustom.teamroom.stickyOutput.mode, "block");
  assert.equal(normalizedCustom.teamroom.stickyOutput.scope, "all-non-room");
  assert.equal(normalizedCustom.teamroom.stickyOutput.ttlSeconds, 30);
  assert.equal(normalizedCustom.teamroom.stickyOutput.seedMode, "forward-targets");
});

test("normalizePluginConfig room protocol keeps defaults and normalizes values", () => {
  const normalizedDefault = normalizePluginConfig(
    {
      teamroom: {
        rooms: [{ id: "oc_test", memberAgents: ["main", "researcher"] }]
      }
    },
    { bindings: [] }
  );
  const defaultProtocol = normalizedDefault.teamroom.roomsById.oc_test.protocol;
  assert.equal(defaultProtocol.enabled, false);
  assert.equal(defaultProtocol.mainAgentId, "main");
  assert.equal(defaultProtocol.mirrorToMain, "signals-only");
  assert.equal(defaultProtocol.signalPrefix, "[task]");
  assert.equal(defaultProtocol.injectRelayGuide, true);
  assert.equal(defaultProtocol.maxTasks, 200);

  const normalizedCustom = normalizePluginConfig(
    {
      teamroom: {
        rooms: [
          {
            id: "oc_test",
            memberAgents: ["researcher", "builder"],
            protocol: {
              enabled: true,
              mainAgentId: "researcher",
              mirrorToMain: "all-agent-messages",
              signalPrefix: "[work]",
              injectRelayGuide: false,
              maxTasks: 5
            }
          }
        ]
      }
    },
    { bindings: [] }
  );
  const customProtocol = normalizedCustom.teamroom.roomsById.oc_test.protocol;
  assert.equal(customProtocol.enabled, true);
  assert.equal(customProtocol.mainAgentId, "researcher");
  assert.equal(customProtocol.mirrorToMain, "all-agent-messages");
  assert.equal(customProtocol.signalPrefix, "[work]");
  assert.equal(customProtocol.injectRelayGuide, false);
  assert.equal(customProtocol.maxTasks, 10);
});

test("normalizePluginConfig room protocol taskMemory keeps defaults and custom values", () => {
  const normalizedDefault = normalizePluginConfig(
    {
      teamroom: {
        rooms: [{ id: "oc_test", memberAgents: ["main", "researcher"] }]
      }
    },
    { bindings: [] }
  );
  const defaultTaskMemory = normalizedDefault.teamroom.roomsById.oc_test.protocol.taskMemory;
  assert.equal(defaultTaskMemory.enabled, false);
  assert.equal(defaultTaskMemory.outputDir, "");
  assert.equal(defaultTaskMemory.fileMode, "daily");
  assert.equal(defaultTaskMemory.fileName, "teamroom-task-memory.md");
  assert.equal(defaultTaskMemory.summarizeByMain, true);
  assert.equal(defaultTaskMemory.summaryAgentId, "");
  assert.equal(defaultTaskMemory.command, "openclaw");
  assert.equal(defaultTaskMemory.timeoutSeconds, 120);
  assert.equal(defaultTaskMemory.dryRun, false);

  const normalizedCustom = normalizePluginConfig(
    {
      teamroom: {
        rooms: [
          {
            id: "oc_test",
            memberAgents: ["main", "researcher"],
            protocol: {
              taskMemory: {
                enabled: true,
                outputDir: "/tmp/teamroom-memory",
                fileMode: "single",
                fileName: "room-memory.md",
                summarizeByMain: false,
                summaryAgentId: "researcher",
                command: "oc",
                timeoutSeconds: 999,
                dryRun: true
              }
            }
          }
        ]
      }
    },
    { bindings: [] }
  );
  const customTaskMemory = normalizedCustom.teamroom.roomsById.oc_test.protocol.taskMemory;
  assert.equal(customTaskMemory.enabled, true);
  assert.equal(customTaskMemory.outputDir, "/tmp/teamroom-memory");
  assert.equal(customTaskMemory.fileMode, "single");
  assert.equal(customTaskMemory.fileName, "room-memory.md");
  assert.equal(customTaskMemory.summarizeByMain, false);
  assert.equal(customTaskMemory.summaryAgentId, "researcher");
  assert.equal(customTaskMemory.command, "oc");
  assert.equal(customTaskMemory.timeoutSeconds, 900);
  assert.equal(customTaskMemory.dryRun, true);
});
