import { asArray, asObject, asString, clampInt, uniqueStrings } from "./utils.js";

const DEFAULT_IDENTITY = {
  enabled: true,
  scope: "dm-only",
  mode: "rewrite",
  strictAgentMapping: false,
  deriveFromBindings: true,
  agentAccounts: {},
  agentSenderIds: {}
};

const DEFAULT_TEAMROOM = {
  enabled: true,
  channel: "feishu",
  dedupWindowSize: 500,
  relayCompact: true,
  stickyOutput: {
    enabled: false,
    mode: "rewrite",
    scope: "dm-only",
    ttlSeconds: 900,
    seedMode: "all-members-on-external"
  },
  rooms: []
};

const DEFAULT_ROOM = {
  enabled: true,
  memberAgents: [],
  agentAccounts: {},
  forwardMode: "mentions-or-all",
  includeSourceAgent: false,
  syncAgentMessages: true,
  protocol: {
    enabled: false,
    mainAgentId: "main",
    mirrorToMain: "signals-only",
    signalPrefix: "[task]",
    injectRelayGuide: true,
    maxTasks: 200,
    smartTask: {
      enabled: false,
      command: "openclaw",
      timeoutSeconds: 120,
      cooldownSeconds: 20,
      createWhenNoActive: true,
      updateWhenActive: true,
      dryRun: false
    },
    taskMemory: {
      enabled: false,
      outputDir: "",
      fileMode: "daily",
      fileName: "teamroom-task-memory.md",
      summarizeByMain: true,
      summaryAgentId: "",
      command: "openclaw",
      timeoutSeconds: 120,
      dryRun: false
    }
  },
  maxTurnsPerCycle: 3,
  cycleTtlSeconds: 900,
  outgoingEchoWindowSeconds: 120,
  mentionAliases: {},
  autopilot: {
    enabled: false,
    trigger: "mentions-only",
    maxDispatchPerCycle: null,
    command: "openclaw",
    timeoutSeconds: 120,
    dryRun: false,
    extraPrompt: ""
  }
};

const DEFAULT_COMMAND = {
  enabled: true,
  name: "teamroom",
  requireAuth: false
};

function normalizeIdentityConfig(rawIdentity, cfg) {
  const incoming = { ...DEFAULT_IDENTITY, ...asObject(rawIdentity) };
  const mode = asString(incoming.mode).toLowerCase();
  const scope = asString(incoming.scope).toLowerCase();

  const fromBindings = {};
  if (incoming.deriveFromBindings !== false) {
    for (const entry of asArray(cfg?.bindings)) {
      const record = asObject(entry);
      const agentId = asString(record.agentId);
      const match = asObject(record.match);
      const channel = asString(match.channel).toLowerCase();
      const accountId = asString(match.accountId);
      if (!agentId || !accountId || channel !== "feishu") continue;
      if (!fromBindings[agentId]) fromBindings[agentId] = accountId;
    }
  }

  const explicit = {};
  for (const [agentIdRaw, accountIdRaw] of Object.entries(asObject(incoming.agentAccounts))) {
    const agentId = asString(agentIdRaw);
    const accountId = asString(accountIdRaw);
    if (!agentId || !accountId) continue;
    explicit[agentId] = accountId;
  }

  const agentToAccount = { ...fromBindings, ...explicit };
  const accountToAgent = {};
  for (const [agentId, accountId] of Object.entries(agentToAccount)) {
    if (!accountToAgent[accountId]) accountToAgent[accountId] = agentId;
  }

  const agentToSenderId = {};
  for (const [agentIdRaw, senderIdRaw] of Object.entries(asObject(incoming.agentSenderIds))) {
    const agentId = asString(agentIdRaw);
    const senderId = asString(senderIdRaw);
    if (!agentId || !senderId) continue;
    agentToSenderId[agentId] = senderId;
  }

  const senderIdToAgent = {};
  for (const [agentId, senderId] of Object.entries(agentToSenderId)) {
    if (!senderIdToAgent[senderId]) senderIdToAgent[senderId] = agentId;
  }

  return {
    enabled: incoming.enabled !== false,
    scope: scope === "all-feishu" ? "all-feishu" : "dm-only",
    mode:
      mode === "block" ? "block" : mode === "rewrite-and-log" ? "rewrite-and-log" : "rewrite",
    strictAgentMapping: incoming.strictAgentMapping === true,
    deriveFromBindings: incoming.deriveFromBindings !== false,
    agentToAccount,
    accountToAgent,
    agentToSenderId,
    senderIdToAgent
  };
}

function normalizeRoomConfig(rawRoom, globalTeamroom, identity) {
  const merged = {
    ...DEFAULT_ROOM,
    ...asObject(rawRoom),
    protocol: {
      ...DEFAULT_ROOM.protocol,
      ...asObject(asObject(rawRoom).protocol),
      smartTask: {
        ...DEFAULT_ROOM.protocol.smartTask,
        ...asObject(asObject(asObject(rawRoom).protocol).smartTask)
      },
      taskMemory: {
        ...DEFAULT_ROOM.protocol.taskMemory,
        ...asObject(asObject(asObject(rawRoom).protocol).taskMemory)
      }
    },
    autopilot: {
      ...DEFAULT_ROOM.autopilot,
      ...asObject(asObject(rawRoom).autopilot)
    }
  };

  const id = asString(merged.id);
  if (!id) return null;

  const memberAgents = uniqueStrings(merged.memberAgents);
  const perRoomAccounts = {};
  for (const [agentIdRaw, accountIdRaw] of Object.entries(asObject(merged.agentAccounts))) {
    const agentId = asString(agentIdRaw);
    const accountId = asString(accountIdRaw);
    if (!agentId || !accountId) continue;
    perRoomAccounts[agentId] = accountId;
  }

  const mentionAliases = {};
  const configuredAliases = asObject(merged.mentionAliases);
  for (const agentId of memberAgents) {
    const aliases = uniqueStrings([
      `@${agentId}`,
      ...(asArray(configuredAliases[agentId]) ?? [])
    ]);
    if (aliases.length > 0) mentionAliases[agentId] = aliases;
  }

  const autopilotTrigger = asString(merged.autopilot.trigger).toLowerCase();
  const forwardMode = asString(merged.forwardMode).toLowerCase();
  const protocolMirror = asString(merged.protocol.mirrorToMain).toLowerCase();
  const mainAgentId = asString(merged.protocol.mainAgentId);
  const smartTaskRaw = asObject(merged.protocol.smartTask);
  const taskMemoryRaw = asObject(merged.protocol.taskMemory);
  const taskMemoryMode = asString(taskMemoryRaw.fileMode).toLowerCase();
  const defaultMainAgent = memberAgents.includes("main") ? "main" : memberAgents[0] || "main";

  return {
    id,
    channel: asString(merged.channel || globalTeamroom.channel || "feishu").toLowerCase() || "feishu",
    enabled: merged.enabled !== false,
    memberAgents,
    agentAccounts: perRoomAccounts,
    forwardMode:
      forwardMode === "mentions-only" || forwardMode === "all-members"
        ? forwardMode
        : "mentions-or-all",
    includeSourceAgent: merged.includeSourceAgent === true,
    syncAgentMessages: merged.syncAgentMessages !== false,
    protocol: {
      enabled: merged.protocol.enabled === true,
      mainAgentId: mainAgentId || defaultMainAgent,
      mirrorToMain:
        protocolMirror === "all-agent-messages" || protocolMirror === "off"
          ? protocolMirror
          : "signals-only",
      signalPrefix: asString(merged.protocol.signalPrefix) || "[task]",
      injectRelayGuide: merged.protocol.injectRelayGuide !== false,
      maxTasks: clampInt(merged.protocol.maxTasks, 200, 10, 2000),
      smartTask: {
        enabled: smartTaskRaw.enabled === true,
        command: asString(smartTaskRaw.command) || "openclaw",
        timeoutSeconds: clampInt(smartTaskRaw.timeoutSeconds, 120, 5, 900),
        cooldownSeconds: clampInt(smartTaskRaw.cooldownSeconds, 20, 1, 300),
        createWhenNoActive: smartTaskRaw.createWhenNoActive !== false,
        updateWhenActive: smartTaskRaw.updateWhenActive !== false,
        dryRun: smartTaskRaw.dryRun === true
      },
      taskMemory: {
        enabled: taskMemoryRaw.enabled === true,
        outputDir: asString(taskMemoryRaw.outputDir),
        fileMode: taskMemoryMode === "single" ? "single" : "daily",
        fileName: asString(taskMemoryRaw.fileName) || "teamroom-task-memory.md",
        summarizeByMain: taskMemoryRaw.summarizeByMain !== false,
        summaryAgentId: asString(taskMemoryRaw.summaryAgentId),
        command: asString(taskMemoryRaw.command) || "openclaw",
        timeoutSeconds: clampInt(taskMemoryRaw.timeoutSeconds, 120, 5, 900),
        dryRun: taskMemoryRaw.dryRun === true
      }
    },
    maxTurnsPerCycle: clampInt(merged.maxTurnsPerCycle, DEFAULT_ROOM.maxTurnsPerCycle, 1, 20),
    cycleTtlSeconds: clampInt(merged.cycleTtlSeconds, DEFAULT_ROOM.cycleTtlSeconds, 30, 86400),
    outgoingEchoWindowSeconds: clampInt(
      merged.outgoingEchoWindowSeconds,
      DEFAULT_ROOM.outgoingEchoWindowSeconds,
      10,
      3600
    ),
    mentionAliases,
    autopilot: {
      enabled: merged.autopilot.enabled === true,
      trigger:
        autopilotTrigger === "mentions-or-all" ? "mentions-or-all" : "mentions-only",
      maxDispatchPerCycle:
        merged.autopilot.maxDispatchPerCycle == null
          ? null
          : clampInt(merged.autopilot.maxDispatchPerCycle, merged.maxTurnsPerCycle ?? 3, 1, 20),
      command: asString(merged.autopilot.command) || "openclaw",
      timeoutSeconds: clampInt(merged.autopilot.timeoutSeconds, 120, 5, 900),
      dryRun: merged.autopilot.dryRun === true,
      extraPrompt: asString(merged.autopilot.extraPrompt)
    },
    resolveAccountForAgent(agentId) {
      return (
        perRoomAccounts[agentId] ||
        identity.agentToAccount[agentId] ||
        ""
      );
    }
  };
}

export function normalizePluginConfig(rawConfig, cfg) {
  const root = asObject(rawConfig);
  const identity = normalizeIdentityConfig(
    { ...DEFAULT_IDENTITY, ...asObject(root.identity) },
    cfg
  );

  const teamroot = { ...DEFAULT_TEAMROOM, ...asObject(root.teamroom) };
  const dedupWindowSize = clampInt(teamroot.dedupWindowSize, 500, 10, 5000);
  const stickyRaw = {
    ...DEFAULT_TEAMROOM.stickyOutput,
    ...asObject(teamroot.stickyOutput)
  };
  const stickyMode = asString(stickyRaw.mode).toLowerCase();
  const stickyScope = asString(stickyRaw.scope).toLowerCase();
  const stickySeedMode = asString(stickyRaw.seedMode).toLowerCase();
  const rooms = [];
  const roomsById = {};
  for (const room of asArray(teamroot.rooms)) {
    const normalized = normalizeRoomConfig(room, teamroot, identity);
    if (!normalized || !normalized.id || roomsById[normalized.id]) continue;
    rooms.push(normalized);
    roomsById[normalized.id] = normalized;
  }

  const commandRaw = { ...DEFAULT_COMMAND, ...asObject(root.command) };
  return {
    identity,
    teamroom: {
      enabled: teamroot.enabled !== false,
      channel: asString(teamroot.channel).toLowerCase() || "feishu",
      dedupWindowSize,
      relayCompact: teamroot.relayCompact !== false,
      stickyOutput: {
        enabled: stickyRaw.enabled === true,
        mode: stickyMode === "block" ? "block" : "rewrite",
        scope: stickyScope === "all-non-room" ? "all-non-room" : "dm-only",
        ttlSeconds: clampInt(stickyRaw.ttlSeconds, 900, 30, 86400),
        seedMode:
          stickySeedMode === "forward-targets"
            ? "forward-targets"
            : "all-members-on-external"
      },
      rooms,
      roomsById
    },
    command: {
      enabled: commandRaw.enabled !== false,
      name: asString(commandRaw.name) || "teamroom",
      requireAuth: commandRaw.requireAuth === true
    }
  };
}
