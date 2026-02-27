import {
  asString,
  escapeRegExp,
  isLikelyGroupId,
  isMessageSendLikeAction,
  parseConversationId,
  parseMessageParams,
  textHash,
  toIso
} from "./utils.js";
import { MessageCache } from "./message-cache.js";
import { TaskBoard } from "./task-board.js";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync
} from "fs";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_TASK_MEMORY_DIR = join(homedir(), ".openclaw", "workspace", "memory");
const MEMORY_LOCK_STALE_MS = 10_000;
const MEMORY_LOCK_WAIT_MS = 25;
const MEMORY_LOCK_RETRIES = 40;

function normalizeFeishuTarget(rawValue) {
  const raw = asString(rawValue);
  if (!raw) return rawValue;
  const lowered = raw.toLowerCase();
  if (!lowered.startsWith("feishu:") && !lowered.startsWith("lark:")) return rawValue;

  const sep = raw.indexOf(":");
  const suffix = raw.slice(sep + 1).trim();
  if (!suffix) return rawValue;

  const lowerSuffix = suffix.toLowerCase();
  if (lowerSuffix.startsWith("user:")) return `user:${suffix.slice("user:".length).trim()}`;
  if (lowerSuffix.startsWith("open_id:")) return `user:${suffix.slice("open_id:".length).trim()}`;
  if (lowerSuffix.startsWith("chat:")) return `chat:${suffix.slice("chat:".length).trim()}`;
  if (lowerSuffix.startsWith("channel:")) return `chat:${suffix.slice("channel:".length).trim()}`;
  if (suffix.startsWith("ou_")) return `user:${suffix}`;
  if (suffix.startsWith("oc_")) return `chat:${suffix}`;
  return rawValue;
}

function normalizeMessageTargets(params) {
  const source = params && typeof params === "object" ? params : {};
  let changed = false;
  const out = { ...source };

  for (const key of ["target", "to", "channelId"]) {
    const normalized = normalizeFeishuTarget(out[key]);
    if (normalized !== out[key]) {
      out[key] = normalized;
      changed = true;
    }
  }

  if (Array.isArray(out.targets)) {
    const nextTargets = out.targets.map((value) => normalizeFeishuTarget(value));
    const listChanged = nextTargets.some((value, idx) => value !== out.targets[idx]);
    if (listChanged) {
      out.targets = nextTargets;
      changed = true;
    }
  }

  return changed ? out : source;
}

function rewriteMessageTargetToRoom(params, roomId) {
  const source = params && typeof params === "object" ? params : {};
  const roomTarget = `chat:${roomId}`;
  const out = { ...source, target: roomTarget };
  if (Object.prototype.hasOwnProperty.call(out, "to")) out.to = roomTarget;
  if (Object.prototype.hasOwnProperty.call(out, "channelId")) out.channelId = roomTarget;
  if (Array.isArray(out.targets)) out.targets = [roomTarget];
  return out;
}

function shouldEnforceStickyOutput(parsed, activeRoomId, stickyConfig) {
  if (!activeRoomId) return false;
  const likelyFeishu = parsed.likelyFeishu || parsed.channel === "feishu";
  if (!likelyFeishu) return false;

  if (stickyConfig.scope === "all-non-room") {
    // P1 fix: in all-non-room mode, never hijack explicit user DM targets.
    // If the agent explicitly specified a user: target, it intends to send
    // a private message. Only redirect room-targeted or untargeted messages.
    if (parsed.isDm && parsed.targets.length > 0) {
      const allExplicitUser = parsed.targets.every(
        (t) => t.kind === "user" && t.id
      );
      if (allExplicitUser) return false;
    }
    if (parsed.roomId) return parsed.roomId !== activeRoomId;
    return true;
  }
  // scope=dm-only: redirect DM replies to the active room (original behavior).
  // This is intentional — when sticky is active, agent replies should go to
  // the room context, not leak into private DMs.
  return parsed.isDm;
}

function resolveMentionedAgents(content, room) {
  const text = asString(content);
  if (!text) return [];
  const lower = text.toLowerCase();
  const out = [];
  for (const agentId of room.memberAgents) {
    const aliases = room.mentionAliases[agentId] ?? [];
    const matched = aliases.some((alias) => {
      const normalizedAlias = asString(alias);
      if (!normalizedAlias) return false;
      if (normalizedAlias.startsWith("@")) {
        return lower.includes(normalizedAlias.toLowerCase());
      }
      // P1 fix: use Unicode-aware word boundary detection for CJK mixed text.
      // Previous regex only matched a narrow set of separators, causing
      // "请builder帮忙" or "叫builder来" to fail. Now we use a broader
      // boundary pattern that includes CJK character ranges.
      const escaped = escapeRegExp(normalizedAlias);
      const pattern = new RegExp(
        `(?:^|[\\s，,。:：!！?？;；、""''()（）\\[\\]【】]|[\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff])${escaped}(?:$|[\\s，,。:：!！?？;；、""''()（）\\[\\]【】]|[\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff])`,
        "i"
      );
      return pattern.test(text);
    });
    if (matched) out.push(agentId);
  }
  return out;
}

function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const text = asString(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function sanitizeFilePart(input) {
  const text = asString(input).replace(/[^a-zA-Z0-9._-]/g, "_");
  return text || "task";
}

function withMemoryFileLock(lockPath, fn, api) {
  let lockFd = null;
  for (let i = 0; i < MEMORY_LOCK_RETRIES; i += 1) {
    try {
      lockFd = openSync(lockPath, "wx");
      break;
    } catch {
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > MEMORY_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
        }
      } catch {}
      sleepMs(MEMORY_LOCK_WAIT_MS);
    }
  }
  if (lockFd == null) {
    api.logger.warn(`[teamchat] task memory lock timeout: ${lockPath}`);
    return false;
  }
  try {
    fn();
    return true;
  } catch (err) {
    api.logger.warn(`[teamchat] task memory append failed: ${String(err)}`);
    return false;
  } finally {
    try {
      closeSync(lockFd);
    } catch {}
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}

function dayKey(ts) {
  const date = new Date(Number(ts) || Date.now());
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveTaskMemoryPath(room, ts) {
  const taskMemory = room.protocol.taskMemory;
  const outputDir = asString(taskMemory.outputDir) || DEFAULT_TASK_MEMORY_DIR;
  const fileName =
    taskMemory.fileMode === "single"
      ? asString(taskMemory.fileName) || "teamroom-task-memory.md"
      : `${dayKey(ts)}.md`;
  return {
    outputDir,
    filePath: join(outputDir, fileName),
    lockPath: join(outputDir, `.${sanitizeFilePart(fileName)}.lock`)
  };
}

function toPrettyTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toISOString();
  } catch {
    return "";
  }
}

function resolveForwardTargets(room, mentionedAgents, sourceAgent) {
  let targetAgents;
  if (room.forwardMode === "mentions-only") {
    targetAgents = mentionedAgents;
  } else if (room.forwardMode === "all-members") {
    targetAgents = room.memberAgents;
  } else {
    targetAgents = mentionedAgents.length > 0 ? mentionedAgents : room.memberAgents;
  }
  targetAgents = dedupe(targetAgents);
  if (!room.includeSourceAgent && sourceAgent) {
    targetAgents = targetAgents.filter((agentId) => agentId !== sourceAgent);
  }
  return targetAgents;
}

function resolveAutopilotTargets(room, mentionedAgents, sourceAgent) {
  const mentionList = dedupe(mentionedAgents);
  let targets = [];
  if (room.autopilot.trigger === "mentions-only") {
    targets = mentionList;
  } else {
    targets = mentionList.length > 0 ? mentionList : room.memberAgents;
  }
  if (!room.includeSourceAgent && sourceAgent) {
    targets = targets.filter((agentId) => agentId !== sourceAgent);
  }
  return dedupe(targets);
}

function extractRoomIdCandidate(rawValue, metadata) {
  const raw = asString(rawValue);
  if (!raw) return "";
  const parsed = parseConversationId(raw, metadata);
  if (isLikelyGroupId(parsed)) return parsed;
  const matched = raw.match(/oc_[a-zA-Z0-9]+/);
  return matched?.[0] || "";
}

function resolveOutgoingRoomId(event, ctx) {
  const directCandidates = [
    ctx?.conversationId,
    event?.to,
    event?.metadata?.to,
    event?.metadata?.originatingTo,
    event?.metadata?.chatId,
    event?.metadata?.conversationId,
    event?.metadata?.channelId
  ];
  for (const candidate of directCandidates) {
    const roomId = extractRoomIdCandidate(candidate, event?.metadata);
    if (roomId) return roomId;
  }

  const meta = event?.metadata;
  if (meta && typeof meta === "object") {
    for (const value of Object.values(meta)) {
      const roomId = extractRoomIdCandidate(value, event?.metadata);
      if (roomId) return roomId;
    }
  }
  return "";
}

function parseRoomIdFromSessionKey(sessionKey) {
  const text = asString(sessionKey);
  if (!text) return "";
  const matched = text.match(/oc_[a-zA-Z0-9]+/);
  return matched?.[0] || "";
}

function extractAssistantTextFromMessage(message) {
  const payload = message && typeof message === "object" ? message : {};
  if (asString(payload.role).toLowerCase() !== "assistant") return "";

  if (typeof payload.content === "string") {
    return payload.content.trim();
  }
  if (!Array.isArray(payload.content)) return "";

  const parts = [];
  for (const item of payload.content) {
    if (!item || typeof item !== "object") continue;
    if (asString(item.type).toLowerCase() !== "text") continue;
    const text = asString(item.text);
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

function normalizeRelayContent(rawText) {
  const text = asString(rawText);
  if (!text) return "";
  return text.replace(/^\s*(?:\[\[[^\]]+\]\]\s*)+/g, "").trim();
}

function buildRelaySystemEvent(params) {
  const sourceAgent = asString(params.sourceAgent) || "external";
  const tsIso = toIso(params.timestamp) || "";
  const content = asString(params.content);
  const sender = asString(params.sender) || "";
  const includeIntro = params.includeIntro !== false;
  if (params.relayCompact !== false) {
    return [
      "<teamroom-relay>",
      includeIntro ? "[群聊同步] 以下是当前群聊中的其他消息" : "",
      `[message src=${sourceAgent || "external"} at=${tsIso || "unknown"}]`,
      content,
      "</teamroom-relay>"
    ]
      .filter(Boolean)
      .join("\n");
  }
  const line0 = "<teamroom-relay>";
  const line1 = includeIntro ? "[群聊同步] 以下是当前群聊中的其他消息" : "";
  const line2 = `[message src=${sourceAgent || "external"} at=${tsIso || "unknown"}]`;
  const line3 = sender ? `[sender ${sender}]` : "";
  return [line0, line1, line2, line3, content, "</teamroom-relay>"].filter(Boolean).join("\n");
}

function extractJsonPayload(text) {
  const raw = asString(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    try {
      return JSON.parse(raw.slice(firstBrace));
    } catch {}
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    const candidate = lines.slice(i).join("\n");
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function extractReplyTextFromAgentOutput(stdout) {
  const parsed = extractJsonPayload(stdout);
  if (!parsed || !Array.isArray(parsed.payloads)) return "";
  for (const payload of parsed.payloads) {
    const text = asString(payload?.text);
    if (text) return text;
  }
  return "";
}

function isNoReply(text) {
  return /^no_reply$/i.test(asString(text));
}

function normalizeFeishuSenderId(value) {
  const raw = asString(value);
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered.startsWith("feishu:")) return raw.slice("feishu:".length).trim();
  if (lowered.startsWith("lark:")) return raw.slice("lark:".length).trim();
  return raw;
}

function normalizeTaskStatus(rawStatus) {
  const status = asString(rawStatus).toLowerCase();
  if (!status) return "";
  if (status === "create" || status === "created" || status === "new") return "create";
  if (status === "ack" || status === "accepted") return "ack";
  if (status === "in_progress" || status === "in-progress" || status === "doing") return "in_progress";
  if (status === "blocked" || status === "waiting") return "blocked";
  if (status === "done" || status === "completed" || status === "finished") return "done";
  if (status === "review_ok" || status === "review-ok" || status === "approved") return "review_ok";
  if (status === "rework" || status === "review_rework" || status === "rejected") return "rework";
  return status;
}

function normalizeSmartAction(value) {
  const action = asString(value).toLowerCase();
  if (!action) return "";
  if (action === "none" || action === "noop" || action === "skip") return "none";
  if (action === "create" || action === "start") return "create";
  if (action === "update" || action === "progress") return "update";
  if (action === "close" || action === "finish" || action === "complete") return "close";
  return "";
}

function generateAutoTaskId(roomId, ts) {
  const stamp = new Date(Number(ts) || Date.now())
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const roomTag = sanitizeFilePart(roomId).slice(-6).toUpperCase();
  return `AUTO-${roomTag}-${stamp}`;
}

function normalizeSmartTaskDecision(rawDecision, activeTask, roomId, ts) {
  const payload = rawDecision && typeof rawDecision === "object" ? rawDecision : {};
  const action = normalizeSmartAction(payload.action);
  if (!action) return null;
  if (action === "none") return { action: "none" };

  const normalizedStatus = normalizeTaskStatus(payload.status);
  const fallbackStatus = action === "create" ? "create" : action === "close" ? "review_ok" : "";
  const status = normalizedStatus || fallbackStatus;
  if (!status) return null;

  const taskIdRaw = asString(payload.taskId);
  const taskId =
    taskIdRaw ||
    (activeTask && (action === "update" || action === "close") ? activeTask.taskId : "") ||
    (action === "create" ? generateAutoTaskId(roomId, ts) : "");
  if (!taskId) return null;

  return {
    action,
    taskId,
    status,
    owner: asString(payload.owner),
    note: asString(payload.note)
  };
}

function parseTaskSignals(content, signalPrefix) {
  const text = asString(content);
  if (!text) return [];
  const marker = asString(signalPrefix) || "[task]";
  const prefixPattern = new RegExp(`^${escapeRegExp(marker)}\\s+(.+)$`, "i");
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = asString(rawLine);
    if (!line) continue;
    const match = line.match(prefixPattern);
    if (!match) continue;
    const body = match[1];
    const taskId = asString(body.match(/(?:^|\s)id=([^\s]+)/i)?.[1]);
    const status = normalizeTaskStatus(body.match(/(?:^|\s)status=([^\s]+)/i)?.[1]);
    const noteRaw = body.match(/(?:^|\s)note=(.+)$/i)?.[1] || "";
    const note = asString(noteRaw.replace(/^["']|["']$/g, ""));
    if (!taskId || !status) continue;
    out.push({ taskId, status, note });
  }
  return out;
}

function buildTaskSignalSystemEvent(params) {
  const taskId = asString(params.taskId);
  const status = asString(params.status) || "unknown";
  const note = asString(params.note);
  const sourceAgent = asString(params.sourceAgent) || "external";
  const tsIso = toIso(params.timestamp) || "";
  const includeIntro = params.includeIntro !== false;
  const noteText = note ? ` note=${note}` : "";
  return [
    "<teamroom-relay>",
    includeIntro ? "[群聊同步] 以下是当前群聊中的其他消息" : "",
    `[task id=${taskId || "unknown"} status=${status} by=${sourceAgent || "external"} at=${tsIso || "unknown"}${noteText}]`,
    "</teamroom-relay>"
  ]
    .filter(Boolean)
    .join("\n");
}

function buildProtocolGuide(room) {
  const marker = asString(room?.protocol?.signalPrefix) || "[task]";
  return `${marker} id=<task_id> status=<ack|in_progress|blocked|done|review_ok|rework> note=<short>`;
}

function splitCommandArgs(text) {
  const source = asString(text);
  if (!source) return [];
  const out = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      const token = asString(current);
      if (token) out.push(token);
      current = "";
      continue;
    }
    current += ch;
  }
  const last = asString(current);
  if (last) out.push(last);
  return out;
}

function normalizeManualTaskStatus(rawStatus) {
  const normalized = normalizeTaskStatus(rawStatus);
  if (!normalized) return "";
  if (normalized === "create") return "create";
  if (normalized === "ack") return "ack";
  if (normalized === "in_progress") return "in_progress";
  if (normalized === "blocked") return "blocked";
  if (normalized === "done") return "done";
  if (normalized === "review_ok") return "review_ok";
  if (normalized === "rework") return "rework";
  return "";
}

function parseTaskTail(tokens) {
  const parsed = {
    note: "",
    owner: "",
    roomId: ""
  };
  const freeText = [];
  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx <= 0) {
      freeText.push(token);
      continue;
    }
    const key = asString(token.slice(0, idx)).toLowerCase();
    const value = asString(token.slice(idx + 1));
    if (!key || !value) continue;
    if (key === "note") parsed.note = value;
    else if (key === "owner") parsed.owner = value;
    else if (key === "room" || key === "roomid") parsed.roomId = value;
    else freeText.push(token);
  }
  if (!parsed.note && freeText.length > 0) parsed.note = freeText.join(" ");
  return parsed;
}

function resolveCommandRoomId(pluginConfig, ctx, explicitRoomId) {
  const roomId = asString(explicitRoomId);
  if (roomId) {
    if (!pluginConfig.teamroom.roomsById[roomId]) return { error: `room not found: ${roomId}` };
    return { roomId };
  }

  const fromConversation = parseConversationId(ctx?.conversationId, ctx?.metadata);
  if (fromConversation && pluginConfig.teamroom.roomsById[fromConversation]) {
    return { roomId: fromConversation };
  }

  if (pluginConfig.teamroom.rooms.length === 1) {
    return { roomId: pluginConfig.teamroom.rooms[0].id };
  }

  return { error: "room is required. Use room=<roomId> or run this command in target group." };
}

function buildSmartTaskJudgePrompt(params) {
  const active = params.activeTask;
  const activeTaskText = active
    ? JSON.stringify(
        {
          taskId: active.taskId,
          status: active.status,
          owner: active.owner,
          lastActor: active.lastActor,
          lastNote: active.lastNote,
          updatedAt: toPrettyTime(active.updatedAt)
        },
        null,
        2
      )
    : "null";

  return [
    "你是协作团队的主控（main）。",
    "请只做任务状态判定，不要写解释。",
    "",
    `room_id: ${params.roomId}`,
    `sender: ${params.senderLabel}`,
    `source_agent: ${params.sourceAgent || "external"}`,
    `message_id: ${params.messageId}`,
    `timestamp: ${toPrettyTime(params.timestamp)}`,
    "",
    "当前 active task:",
    activeTaskText,
    "",
    "收到的新消息:",
    params.content,
    "",
    "判定规则：",
    "1. 若出现新的多人协作需求，且当前无 active task，返回 action=create。",
    "2. 若已有 active task 且状态应变化，返回 action=update 或 action=close。",
    "3. 若无状态变化，返回 action=none。",
    "4. close 时 status 只允许 done 或 review_ok。",
    "",
    "必须仅输出一段 JSON（不要 markdown，不要解释）：",
    '{"action":"none|create|update|close","taskId":"<id_or_empty>","status":"create|ack|in_progress|blocked|done|review_ok|rework","owner":"<agent_or_empty>","note":"<short_note_or_empty>"}'
  ].join("\n");
}

function buildTaskMemorySummaryPrompt(params) {
  const history = Array.isArray(params.task?.history) ? params.task.history : [];
  const historyText =
    history.length === 0
      ? "- (empty)"
      : history
          .slice(-12)
          .map(
            (item) =>
              `- ${toPrettyTime(item.at)} status=${item.status} actor=${item.actor || "unknown"}${item.note ? ` note=${item.note}` : ""}`
          )
          .join("\n");

  return [
    "你是 main，请把已结束的协作任务总结为可复用记忆。",
    "只输出一段 JSON，不要其他文字。",
    "",
    `room_id: ${params.roomId}`,
    `task_id: ${params.task?.taskId || "unknown"}`,
    `final_status: ${params.task?.status || "unknown"}`,
    `owner: ${params.task?.owner || "unknown"}`,
    "",
    "任务历史：",
    historyText,
    "",
    "输出 JSON：",
    '{"summary":"<one paragraph>","lessons":["<item1>","<item2>"],"nextActions":["<item_or_empty>"]}'
  ].join("\n");
}

function parseMemorySummary(text) {
  const payload = extractJsonPayload(text);
  if (!payload || typeof payload !== "object") {
    return {
      summary: asString(text),
      lessons: [],
      nextActions: []
    };
  }
  const lessons = Array.isArray(payload.lessons)
    ? payload.lessons.map((item) => asString(item)).filter(Boolean).slice(0, 5)
    : [];
  const nextActions = Array.isArray(payload.nextActions)
    ? payload.nextActions.map((item) => asString(item)).filter(Boolean).slice(0, 5)
    : [];
  return {
    summary: asString(payload.summary),
    lessons,
    nextActions
  };
}

function buildTaskMemoryEntry(params) {
  const summary = params.summary;
  const task = params.task;
  const lines = [
    `## [teamroom-task] ${toPrettyTime(params.closedAt || Date.now())}`,
    `- room: ${params.roomId}`,
    `- task: ${task.taskId}`,
    `- status: ${task.status}`,
    `- owner: ${task.owner || "unknown"}`,
    `- actor: ${task.lastActor || "unknown"}`,
    `- closed_by: ${params.triggerActor || "unknown"}`,
    `- note: ${task.lastNote || "-"}`,
    "",
    "### summary",
    summary.summary || "(empty)"
  ];
  if (summary.lessons.length > 0) {
    lines.push("");
    lines.push("### lessons");
    for (const item of summary.lessons) {
      lines.push(`- ${item}`);
    }
  }
  if (summary.nextActions.length > 0) {
    lines.push("");
    lines.push("### next_actions");
    for (const item of summary.nextActions) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

function buildAutopilotPrompt(params) {
  const protocolGuide = asString(params.protocolGuide);
  const lines = [
    "你被 TeamRoom 插件触发执行。",
    `room_id: ${params.roomId}`,
    `sender: ${params.sender}`,
    `message_id: ${params.messageId || "unknown"}`,
    "",
    "收到的群消息：",
    params.content,
    "",
    "执行规则：",
    "1. 你是团队成员，不是秘书，不要复述上下文。",
    "2. 只在你能提供增量价值时回复；否则输出 NO_REPLY。",
    "3. 回复尽量简洁（建议 <= 120 字）。",
    "4. 若需要其他 agent 协作，可在回复里明确 @agentId。"
  ];
  if (protocolGuide) {
    lines.push("5. 若任务状态有变化，请追加一行协作信号：");
    lines.push(`   ${protocolGuide}`);
  }
  if (params.extraPrompt) {
    lines.push("");
    lines.push("附加规则：");
    lines.push(params.extraPrompt);
  }
  return lines.join("\n");
}

async function runAutopilotDispatch(api, room, agentId, accountId, prompt) {
  const baseCommand = room.autopilot.command || "openclaw";
  const timeoutSeconds = room.autopilot.timeoutSeconds;
  const timeoutMs = Math.max(timeoutSeconds * 1000 + 5000, 10_000);

  const runArgv = [
    baseCommand,
    "agent",
    "--agent",
    agentId,
    "--message",
    prompt,
    "--timeout",
    String(timeoutSeconds),
    "--json"
  ];

  if (room.autopilot.dryRun) {
    api.logger.info(`[teamchat] autopilot dry-run: ${runArgv.join(" ")}`);
    return { ok: true, detail: "dry-run" };
  }

  let runResult;
  try {
    runResult = await api.runtime.system.runCommandWithTimeout(runArgv, { timeoutMs });
  } catch (err) {
    return { ok: false, detail: `agent run failed: ${String(err)}` };
  }
  if (runResult.code !== 0) {
    const stderr = asString(runResult.stderr);
    return {
      ok: false,
      detail: `agent run exit=${runResult.code}${stderr ? ` stderr=${stderr.slice(0, 180)}` : ""}`
    };
  }

  const replyText = asString(extractReplyTextFromAgentOutput(runResult.stdout));
  if (!replyText || isNoReply(replyText)) {
    return { ok: true, detail: "no-reply", replyText: "" };
  }

  const sendArgv = [
    baseCommand,
    "message",
    "send",
    "--channel",
    room.channel,
    "--target",
    room.id,
    "--message",
    replyText
  ];
  if (accountId) {
    sendArgv.push("--account", accountId);
  }
  const sendResult = await api.runtime.system.runCommandWithTimeout(sendArgv, { timeoutMs });
  if (sendResult.code !== 0) {
    const stderr = asString(sendResult.stderr);
    return {
      ok: false,
      detail: `message send exit=${sendResult.code}${stderr ? ` stderr=${stderr.slice(0, 180)}` : ""}`,
      replyText
    };
  }
  // Return replyText so caller can recordOutgoing for echo detection
  return { ok: true, detail: "sent", replyText };
}

export function createTeamChatRuntime(api, pluginConfig, state) {
  const smartTaskCooldownByRoom = new Map();
  const protocolGuideByTarget = new Map();
  const PROTOCOL_GUIDE_REMIND_MS = 30 * 60 * 1000;
  const relayIntroByTarget = new Map();
  const RELAY_INTRO_TTL_MS = 10 * 60 * 1000;

  // ─── v2: Initialize MessageCache and TaskBoard ───
  const messageCache = new MessageCache({
    logger: api.logger,
    maxMessages: 500,
    cleanupTtlSeconds: 3600,
    compactThreshold: 200
  });
  const taskBoard = new TaskBoard({
    logger: api.logger,
    maxActiveTasks: 10,
    roundTracking: true
  });

  function shouldIncludeRelayIntro(roomId, targetAgent, timestamp) {
    const key = `${asString(roomId) || "unknown"}:${asString(targetAgent) || "unknown"}`;
    const now = Number(timestamp) || Date.now();
    const last = relayIntroByTarget.get(key) || 0;
    if (now - last < RELAY_INTRO_TTL_MS) return false;
    relayIntroByTarget.set(key, now);
    return true;
  }

  function getProtocolStateSignature(room) {
    const active = state.getActiveTask(room.id);
    if (!active) return "none";
    return `${active.taskId}:${active.status}:${active.owner || ""}`;
  }

  function resolveRelayProtocolGuide(room, targetAgent, timestamp, hasTaskSignal) {
    if (!room.protocol.enabled || !room.protocol.injectRelayGuide) return "";
    const now = Number(timestamp) || Date.now();
    const key = `${room.id}:${asString(targetAgent) || "unknown"}`;
    const signature = getProtocolStateSignature(room);
    const previous = protocolGuideByTarget.get(key);
    const changed = !previous || previous.signature !== signature;
    const expired = !previous || now - previous.at > PROTOCOL_GUIDE_REMIND_MS;
    const shouldInject = hasTaskSignal || changed || expired;
    if (!shouldInject) return "";
    protocolGuideByTarget.set(key, { signature, at: now });
    return buildProtocolGuide(room);
  }

  function isSafeTeamroomSessionKey(sessionKey, room, targetAgent) {
    const key = asString(sessionKey).toLowerCase();
    if (!key) return false;
    const roomId = asString(room?.id).toLowerCase();
    if (!roomId) return false;
    if (!key.includes(":group:")) return false;
    if (!key.includes(roomId)) return false;
    if (key.startsWith("agent:")) {
      const expectedPrefix = `agent:${asString(targetAgent).toLowerCase()}:`;
      if (!key.startsWith(expectedPrefix)) return false;
    }
    return true;
  }

  function resolveAgentSessionKey(room, agentId) {
    const accountId = room.resolveAccountForAgent(agentId);
    const route = api.runtime.channel.routing.resolveAgentRoute({
      cfg: api.config,
      channel: room.channel,
      accountId: accountId || undefined,
      peer: { kind: "group", id: room.id }
    });
    const sessionKey = asString(route?.sessionKey);
    if (!isSafeTeamroomSessionKey(sessionKey, room, agentId)) {
      api.logger.warn(
        `[teamchat] blocked unsafe relay route: room=${room.id} agent=${agentId} account=${accountId || "unknown"} session=${sessionKey || "unknown"}`
      );
      return {
        accountId,
        sessionKey: ""
      };
    }
    return {
      accountId,
      sessionKey
    };
  }

  function enqueueRoomEventToAgent(room, agentId, text, contextKey) {
    if (!agentId || !text) return false;
    const { sessionKey } = resolveAgentSessionKey(room, agentId);
    if (!sessionKey) return false;
    api.runtime.system.enqueueSystemEvent(text, {
      sessionKey,
      contextKey
    });
    return true;
  }

  async function runAgentJsonText(baseCommand, agentId, prompt, timeoutSeconds, dryRun, tag) {
    const timeoutMs = Math.max(timeoutSeconds * 1000 + 5000, 10_000);
    const runArgv = [
      baseCommand,
      "agent",
      "--agent",
      agentId,
      "--message",
      prompt,
      "--timeout",
      String(timeoutSeconds),
      "--json"
    ];
    if (dryRun) {
      api.logger.info(`[teamchat] ${tag} dry-run: ${runArgv.join(" ")}`);
      return { ok: true, detail: "dry-run", text: "" };
    }

    let runResult;
    try {
      runResult = await api.runtime.system.runCommandWithTimeout(runArgv, { timeoutMs });
    } catch (err) {
      return { ok: false, detail: `agent run failed: ${String(err)}`, text: "" };
    }
    if (runResult.code !== 0) {
      const stderr = asString(runResult.stderr);
      return {
        ok: false,
        detail: `agent run exit=${runResult.code}${stderr ? ` stderr=${stderr.slice(0, 180)}` : ""}`,
        text: ""
      };
    }

    const text = asString(extractReplyTextFromAgentOutput(runResult.stdout));
    return { ok: true, detail: "ok", text };
  }

  async function maybeWriteTaskMemory(room, record, triggerActor, closedAt) {
    const taskMemory = room.protocol.taskMemory;
    if (!taskMemory.enabled || !record) return;

    const ts = Number(closedAt) || Date.now();
    const mainAgentId =
      asString(taskMemory.summaryAgentId) ||
      asString(room.protocol.mainAgentId) ||
      "main";
    const summaryPrompt = buildTaskMemorySummaryPrompt({
      roomId: room.id,
      task: record
    });
    let summary = {
      summary: `Task ${record.taskId} closed with status=${record.status}.`,
      lessons: [],
      nextActions: []
    };

    if (taskMemory.summarizeByMain) {
      const result = await runAgentJsonText(
        taskMemory.command || "openclaw",
        mainAgentId,
        summaryPrompt,
        taskMemory.timeoutSeconds,
        taskMemory.dryRun,
        "task-memory"
      );
      if (!result.ok) {
        api.logger.warn(`[teamchat] task memory summary failed: room=${room.id} task=${record.taskId} detail=${result.detail}`);
      } else if (result.text) {
        summary = parseMemorySummary(result.text);
      }
    }

    const { outputDir, filePath, lockPath } = resolveTaskMemoryPath(room, ts);
    const entry = buildTaskMemoryEntry({
      roomId: room.id,
      task: record,
      summary,
      triggerActor,
      closedAt: ts
    });

    if (taskMemory.dryRun) {
      api.logger.info(`[teamchat] task-memory dry-run append target=${filePath}`);
      return;
    }

    try {
      mkdirSync(outputDir, { recursive: true });
    } catch (err) {
      api.logger.warn(`[teamchat] task memory mkdir failed: ${String(err)}`);
      return;
    }

    withMemoryFileLock(
      lockPath,
      () => {
        appendFileSync(filePath, entry, "utf8");
      },
      api
    );
  }

  async function handleTaskSignalResult(room, result, triggerActor, timestamp) {
    if (!result?.ok) return;
    if (result.closed) {
      await maybeWriteTaskMemory(room, result.record, triggerActor, timestamp);
    }
  }

  async function maybeRunSmartTask(room, params) {
    const smart = room.protocol.smartTask;
    if (!room.protocol.enabled || !smart.enabled) return;
    if (params.sourceAgent && params.sourceAgent === room.protocol.mainAgentId) return;
    if (params.taskSignals && params.taskSignals.length > 0) return;

    const activeTask = state.getActiveTask(room.id);
    if (!activeTask && !smart.createWhenNoActive) return;
    if (activeTask && !smart.updateWhenActive) return;

    const cooldownKey = room.id;
    const lastRun = smartTaskCooldownByRoom.get(cooldownKey) || 0;
    const now = Number(params.timestamp) || Date.now();
    if (now - lastRun < smart.cooldownSeconds * 1000) return;
    smartTaskCooldownByRoom.set(cooldownKey, now);

    const mainAgentId = asString(room.protocol.mainAgentId) || "main";
    const prompt = buildSmartTaskJudgePrompt({
      roomId: room.id,
      senderLabel: params.senderLabel,
      sourceAgent: params.sourceAgent,
      messageId: params.messageId,
      timestamp: now,
      content: params.content,
      activeTask
    });

    const result = await runAgentJsonText(
      smart.command || "openclaw",
      mainAgentId,
      prompt,
      smart.timeoutSeconds,
      smart.dryRun,
      "smart-task"
    );
    if (!result.ok) {
      api.logger.warn(
        `[teamchat] smart task judge failed: room=${room.id} detail=${result.detail}`
      );
      return;
    }
    if (!result.text) return;

    const decision = normalizeSmartTaskDecision(
      extractJsonPayload(result.text),
      activeTask,
      room.id,
      now
    );
    if (!decision || decision.action === "none") return;

    const applied = state.applyTaskSignal(
      room.id,
      {
        taskId: decision.taskId,
        status: decision.status,
        note: decision.note,
        owner: decision.owner
      },
      `smart:${mainAgentId}`,
      now
    );
    if (!applied?.ok && applied?.reason === "active_conflict") {
      api.logger.warn(
        `[teamchat] smart task conflict room=${room.id} active=${applied.activeTaskId} incoming=${decision.taskId}`
      );
      return;
    }
    await handleTaskSignalResult(room, applied, `smart:${mainAgentId}`, now);
  }

  async function relayOutgoingAgentMessage(params) {
    const room = params.room;
    if (!room || !room.enabled) return;

    const sourceAgent = asString(params.sourceAgent);
    if (!sourceAgent || !room.memberAgents.includes(sourceAgent)) return;

    const content = normalizeRelayContent(params.content);
    if (!content) return;

    const accountId = asString(params.accountId);
    const timestamp = Number(params.timestamp) || Date.now();
    const senderId =
      asString(params.senderId) ||
      asString(pluginConfig.identity.agentToSenderId[sourceAgent]) ||
      accountId ||
      sourceAgent;
    const senderLabel = asString(params.senderLabel) || sourceAgent || accountId || "unknown";
    const messageId =
      asString(params.messageId) ||
      `outgoing:${room.id}:${sourceAgent}:${timestamp}:${textHash(content)}`;
    const contextPrefix = asString(params.contextPrefix) || "send";

    state.recordOutgoing(room.id, content, sourceAgent, timestamp);
    state.markProactiveRelay(room.id, content, timestamp);

    const mentionedAgents = resolveMentionedAgents(content, room);
    const taskSignals = room.protocol.enabled
      ? parseTaskSignals(content, room.protocol.signalPrefix)
      : [];
    for (const signal of taskSignals) {
      const result = state.applyTaskSignal(room.id, signal, sourceAgent, timestamp);
      if (!result?.ok && result?.reason === "active_conflict") {
        api.logger.warn(
          `[teamchat] ignored task signal id=${signal.taskId} in room=${room.id} because active task is ${result.activeTaskId}.`
        );
        continue;
      }
      await handleTaskSignalResult(room, result, sourceAgent, timestamp);
    }

    if (!room.syncAgentMessages) return;

    const forwardTargets = resolveForwardTargets(room, mentionedAgents, sourceAgent);
    for (const targetAgent of forwardTargets) {
      const targetAccount = room.resolveAccountForAgent(targetAgent) || accountId;
      const includeIntro = shouldIncludeRelayIntro(room.id, targetAgent, timestamp);
      const protocolGuide = resolveRelayProtocolGuide(
        room,
        targetAgent,
        timestamp,
        taskSignals.length > 0
      );
      const relayText = buildRelaySystemEvent({
        roomId: room.id,
        sender: senderLabel,
        senderId,
        sourceAgent,
        receiverAccount: targetAccount,
        messageId,
        timestamp,
        includeIntro,
        content,
        protocolGuide,
        relayCompact: pluginConfig.teamroom.relayCompact
      });

      // ─── v2: Enrich relay with cache context + task board ───
      const cacheCtx = messageCache.buildContextBlock(room.id, targetAgent, { maxMessages: 20 });
      const boardCtx = taskBoard.buildBoardContext(room.id, targetAgent);
      const enrichedRelay = [
        relayText,
        cacheCtx ? `\n${cacheCtx}` : "",
        boardCtx ? `\n${boardCtx}` : ""
      ].filter(Boolean).join("\n");

      enqueueRoomEventToAgent(
        room,
        targetAgent,
        enrichedRelay,
        `teamchat:${contextPrefix}:${room.id}:${messageId}:${targetAgent}`
      );

      // Mark as read after injecting context
      messageCache.markAllAsRead(room.id, targetAgent);
    }

    if (room.protocol.enabled && room.protocol.mainAgentId) {
      const mainAgentId = room.protocol.mainAgentId;
      const isMainSource = sourceAgent === mainAgentId;
      const mainForwarded = forwardTargets.includes(mainAgentId);
      const mirrorMode = room.protocol.mirrorToMain;
      const shouldMirrorAgentMessage =
        !isMainSource &&
        !mainForwarded &&
        mirrorMode === "all-agent-messages";
      if (shouldMirrorAgentMessage) {
        const includeIntro = shouldIncludeRelayIntro(room.id, mainAgentId, timestamp);
        const protocolGuide = resolveRelayProtocolGuide(
          room,
          mainAgentId,
          timestamp,
          taskSignals.length > 0
        );
        // P0 fix: mark mirror messages as informational to prevent main
        // from treating them as actionable and replying (which would cause
        // a relay amplification loop: agent reply → mirror → main reply → relay back).
        const mirrorText = buildRelaySystemEvent({
          roomId: room.id,
          sender: senderLabel,
          senderId,
          sourceAgent,
          receiverAccount: room.resolveAccountForAgent(mainAgentId) || accountId,
          messageId,
          timestamp,
          includeIntro: false,
          content: `[mirror-only 仅同步，无需回复]\n${content}`,
          protocolGuide,
          relayCompact: pluginConfig.teamroom.relayCompact
        });
        enqueueRoomEventToAgent(
          room,
          mainAgentId,
          mirrorText,
          `teamchat:${contextPrefix}-mirror:${room.id}:${messageId}:${mainAgentId}`
        );
      }
      if (!isMainSource && taskSignals.length > 0) {
        taskSignals.forEach((signal, index) => {
          const includeIntro = shouldIncludeRelayIntro(room.id, mainAgentId, timestamp);
          const signalText = buildTaskSignalSystemEvent({
            roomId: room.id,
            taskId: signal.taskId,
            status: signal.status,
            note: signal.note,
            sourceAgent,
            sender: senderLabel,
            messageId,
            timestamp,
            includeIntro
          });
          enqueueRoomEventToAgent(
            room,
            mainAgentId,
            signalText,
            `teamchat:${contextPrefix}-task:${room.id}:${messageId}:${index}`
          );
        });
      }
    }
  }

  function beforeToolCall(event, ctx) {
    if (asString(event.toolName) !== "message") return;
    const normalizedParams = normalizeMessageTargets(event.params);
    const normalizedTargetMutated = normalizedParams !== event.params;
    let parsed = parseMessageParams(normalizedParams);
    if (!isMessageSendLikeAction(parsed.action)) return;

    const agentId = asString(ctx.agentId);
    let nextParams = parsed.params;
    let mutated = normalizedTargetMutated;

    if (normalizedTargetMutated) {
      api.logger.info(`[teamchat] normalized feishu target format for agent=${agentId || "unknown"}.`);
    }

    if (pluginConfig.identity.enabled) {
      const expectedAccountId = pluginConfig.identity.agentToAccount[agentId] || "";
      const currentAccountId = asString(nextParams.accountId);
      const identityScope = pluginConfig.identity.scope;
      const shouldApplyIdentity =
        identityScope === "all-feishu"
          ? parsed.likelyFeishu || Boolean(currentAccountId)
          : parsed.isDm && parsed.likelyFeishu;

      if (shouldApplyIdentity) {
        if (!expectedAccountId) {
          if (pluginConfig.identity.strictAgentMapping) {
            return {
              block: true,
              blockReason: `[teamchat] Agent "${agentId}" has no mapped feishu accountId; blocked by strictAgentMapping.`
            };
          }
        } else if (pluginConfig.identity.mode === "block") {
          if (currentAccountId !== expectedAccountId) {
            return {
              block: true,
              blockReason: `[teamchat] message.accountId mismatch for agent "${agentId}": got "${currentAccountId || "(empty)"}", expected "${expectedAccountId}".`
            };
          }
        } else if (currentAccountId !== expectedAccountId) {
          nextParams = { ...nextParams, accountId: expectedAccountId };
          parsed = parseMessageParams(nextParams);
          mutated = true;
          if (pluginConfig.identity.mode === "rewrite-and-log") {
            api.logger.info(
              `[teamchat] rewrote message.accountId for agent=${agentId}: "${currentAccountId || "(empty)"}" -> "${expectedAccountId}"`
            );
          }
        }
      }
    }

    const now = Date.now();
    const stickyConfig = pluginConfig.teamroom.stickyOutput;
    if (stickyConfig.enabled) {
      const activeRoomId = state.resolveAgentRoom(agentId, now);
      if (shouldEnforceStickyOutput(parsed, activeRoomId, stickyConfig)) {
        if (stickyConfig.mode === "block") {
          return {
            block: true,
            blockReason: `[teamchat] sticky-output active for agent "${agentId}". Please reply in room ${activeRoomId} instead of private/other target.`
          };
        }
        nextParams = rewriteMessageTargetToRoom(nextParams, activeRoomId);
        parsed = parseMessageParams(nextParams);
        mutated = true;
        api.logger.info(
          `[teamchat] sticky-output rewrote target for agent=${agentId} to room=${activeRoomId}.`
        );
      }
    }

    const roomId = parsed.roomId;
    if (!pluginConfig.teamroom.enabled || !roomId) {
      return mutated ? { params: nextParams } : undefined;
    }

    const room = pluginConfig.teamroom.roomsById[roomId];
    if (!room || !room.enabled) {
      return mutated ? { params: nextParams } : undefined;
    }

    const turnResult = state.tryConsumeTurn(room.id, room, now);
    if (!turnResult.ok) {
      return {
        block: true,
        blockReason: `[teamchat] room ${room.id} reached turn limit (${turnResult.maxTurns}) for this cycle. Wait for new user input or run /${pluginConfig.command.name} reset ${room.id}.`
      };
    }

    const text = asString(nextParams.message) || asString(nextParams.text) || asString(nextParams.content);
    if (text) {
      state.recordOutgoing(room.id, text, agentId || "unknown", now);
    }
    return mutated ? { params: nextParams } : undefined;
  }

  async function messageSending(event, ctx) {
    if (!pluginConfig.teamroom.enabled) return;
    if (asString(ctx.channelId).toLowerCase() !== pluginConfig.teamroom.channel) return;

    const roomId = resolveOutgoingRoomId(event, ctx);
    if (!roomId || !isLikelyGroupId(roomId)) {
      api.logger.debug?.(
        `[teamchat] message_sending skip: unresolved room (to=${asString(event?.to) || "(empty)"})`
      );
      return;
    }

    const room = pluginConfig.teamroom.roomsById[roomId];
    if (!room || !room.enabled) return;

    const content = normalizeRelayContent(event.content);
    if (!content) return;

    const accountId = asString(ctx.accountId);
    const sourceAgent = pluginConfig.identity.accountToAgent[accountId] || "";
    if (!sourceAgent) {
      api.logger.warn(
        `[teamchat] message_sending skip relay: room=${room.id} account=${accountId || "(empty)"} has no mapped agent.`
      );
      return;
    }

    const timestamp = Date.now();
    const messageId =
      asString(event.metadata?.messageId) ||
      `outgoing:${room.id}:${sourceAgent}:${timestamp}:${textHash(content)}`;

    // ─── v2: Write agent outgoing message to cache ───
    messageCache.appendMessage(roomId, {
      id: messageId,
      ts: timestamp,
      sender: sourceAgent,
      senderId: pluginConfig.identity.agentToSenderId[sourceAgent] || accountId || sourceAgent,
      sourceAgent,
      content,
      mentions: resolveMentionedAgents(content, room),
      type: "message"
    });

    await relayOutgoingAgentMessage({
      room,
      sourceAgent,
      content,
      accountId,
      senderLabel: asString(event.metadata?.senderName) || sourceAgent || accountId || "unknown",
      messageId,
      timestamp,
      contextPrefix: "send"
    });
  }

  async function messageReceived(event, ctx) {
    if (!pluginConfig.teamroom.enabled) return;
    if (asString(ctx.channelId).toLowerCase() !== pluginConfig.teamroom.channel) return;

    const roomId = parseConversationId(ctx.conversationId, event.metadata);
    if (!roomId || !isLikelyGroupId(roomId)) return;

    const room = pluginConfig.teamroom.roomsById[roomId];
    if (!room || !room.enabled) return;

    const content = asString(event.content);
    if (!content) return;

    const messageId =
      asString(event.metadata?.messageId) ||
      `${asString(event.from)}:${event.timestamp || Date.now()}:${textHash(content)}`;
    if (state.hasSeenMessage(roomId, messageId)) return;
    state.markSeenMessage(roomId, messageId, pluginConfig.teamroom.dedupWindowSize);

    const timestamp = Number.isFinite(event.timestamp) ? Number(event.timestamp) : Date.now();
    const echoedAgent = state.detectOutgoingEcho(roomId, content, timestamp, room.outgoingEchoWindowSeconds);
    const proactiveEcho =
      echoedAgent && state.consumeProactiveRelayEcho(roomId, content, timestamp, room.outgoingEchoWindowSeconds);
    const senderId = normalizeFeishuSenderId(asString(event.metadata?.senderId) || asString(event.from));
    const mappedSourceAgent = pluginConfig.identity.senderIdToAgent[senderId] || "";
    const sourceAgent = echoedAgent || mappedSourceAgent || "";
    const senderLabel =
      asString(event.metadata?.senderName) ||
      asString(event.metadata?.senderId) ||
      asString(event.from) ||
      "unknown";

    if (!echoedAgent) {
      state.registerInboundExternal(roomId, room, timestamp);
    }

    // ─── v2: Write message to cache ───
    const mentionedAgents = resolveMentionedAgents(content, room);
    messageCache.appendMessage(roomId, {
      id: messageId,
      ts: timestamp,
      sender: senderLabel,
      senderId,
      sourceAgent,
      content,
      mentions: mentionedAgents,
      type: "message"
    });

    // Periodic cleanup
    if (Math.random() < 0.1) {
      messageCache.cleanup(roomId, room.memberAgents);
    }

    const taskSignals = room.protocol.enabled
      ? parseTaskSignals(content, room.protocol.signalPrefix)
      : [];
    for (const signal of taskSignals) {
      const result = state.applyTaskSignal(
        room.id,
        signal,
        sourceAgent || "external",
        timestamp
      );
      if (!result?.ok && result?.reason === "active_conflict") {
        api.logger.warn(
          `[teamchat] ignored task signal id=${signal.taskId} in room=${room.id} because active task is ${result.activeTaskId}.`
        );
        continue;
      }
      await handleTaskSignalResult(room, result, sourceAgent || "external", timestamp);

      // ─── v2: Sync task signal to TaskBoard ───
      const actor = sourceAgent || "external";
      const normalizedStatus = asString(signal.status).toLowerCase();
      if (normalizedStatus === "create" || normalizedStatus === "ack") {
        const existing = taskBoard.getTask(room.id, signal.taskId);
        if (!existing) {
          taskBoard.createTask(room.id, {
            taskId: signal.taskId,
            summary: asString(signal.note) || "",
            status: normalizedStatus,
            assignee: actor !== "external" ? actor : "",
            createdBy: actor,
            note: asString(signal.note)
          });
        } else {
          taskBoard.updateTask(room.id, {
            taskId: signal.taskId,
            status: normalizedStatus,
            actor,
            note: asString(signal.note)
          });
        }
      } else {
        taskBoard.updateTask(room.id, {
          taskId: signal.taskId,
          status: normalizedStatus,
          actor,
          note: asString(signal.note)
        });
      }

      // Write task update to message cache so other agents see it
      messageCache.appendMessage(roomId, {
        ts: timestamp,
        sender: actor,
        senderId,
        sourceAgent: actor,
        content: `[task] ${signal.taskId} → ${normalizedStatus}${signal.note ? ` (${signal.note})` : ""}`,
        mentions: [],
        type: "task_update"
      });
    }

    await maybeRunSmartTask(room, {
      sourceAgent,
      senderLabel,
      messageId,
      timestamp,
      content,
      taskSignals
    });

    // --- P0 fix: compute autopilot targets FIRST, then exclude them from relay ---
    // Autopilot dispatches the agent with the full message via `openclaw agent`,
    // which is a standalone invocation. If we also inject a relay system-event
    // into the same agent's existing session, the agent processes the same
    // external message twice (once from autopilot, once from relay).
    // Solution: autopilot-targeted agents are excluded from the relay forward list.
    const autopilotTargets =
      !echoedAgent && room.autopilot.enabled
        ? resolveAutopilotTargets(room, mentionedAgents, sourceAgent)
        : [];
    const autopilotTargetSet = new Set(autopilotTargets);

    if (!echoedAgent || (room.syncAgentMessages && !proactiveEcho)) {
      const forwardTargets = resolveForwardTargets(room, mentionedAgents, sourceAgent);
      if (pluginConfig.teamroom.stickyOutput.enabled) {
        const seedMode = pluginConfig.teamroom.stickyOutput.seedMode;
        const stickyTargets =
          !echoedAgent && seedMode === "all-members-on-external"
            ? room.memberAgents
            : forwardTargets;
        const ttlMs = pluginConfig.teamroom.stickyOutput.ttlSeconds * 1000;
        for (const targetAgent of dedupe(stickyTargets)) {
          state.bindAgentRoom(targetAgent, room.id, timestamp, ttlMs);
        }
      }
      for (const targetAgent of forwardTargets) {
        // P0 fix: skip relay for agents that will be dispatched by autopilot
        if (autopilotTargetSet.has(targetAgent)) {
          api.logger.info(
            `[teamchat] relay skip: agent=${targetAgent} will be dispatched by autopilot room=${room.id}`
          );
          continue;
        }
        const targetAccount = room.resolveAccountForAgent(targetAgent) || ctx.accountId;
        const includeIntro = shouldIncludeRelayIntro(room.id, targetAgent, timestamp);
        const protocolGuide = resolveRelayProtocolGuide(
          room,
          targetAgent,
          timestamp,
          taskSignals.length > 0
        );
        const relayText = buildRelaySystemEvent({
          roomId: room.id,
          sender: senderLabel,
          senderId,
          sourceAgent,
          receiverAccount: targetAccount,
          messageId,
          timestamp,
          includeIntro,
          content,
          protocolGuide,
          relayCompact: pluginConfig.teamroom.relayCompact
        });

        // ─── v2: Enrich relay with cache context + task board ───
        const cacheCtx2 = messageCache.buildContextBlock(room.id, targetAgent, { maxMessages: 20 });
        const boardCtx2 = taskBoard.buildBoardContext(room.id, targetAgent);
        const enrichedRelay2 = [
          relayText,
          cacheCtx2 ? `\n${cacheCtx2}` : "",
          boardCtx2 ? `\n${boardCtx2}` : ""
        ].filter(Boolean).join("\n");

        enqueueRoomEventToAgent(
          room,
          targetAgent,
          enrichedRelay2,
          `teamchat:${room.id}:${messageId}:${targetAgent}`
        );

        // Mark as read after injecting context
        messageCache.markAllAsRead(room.id, targetAgent);
      }

      if (room.protocol.enabled && room.protocol.mainAgentId) {
        const mainAgentId = room.protocol.mainAgentId;
        const isMainSource = sourceAgent && sourceAgent === mainAgentId;
        const mainForwarded = forwardTargets.includes(mainAgentId) && !autopilotTargetSet.has(mainAgentId);
        const mirrorMode = room.protocol.mirrorToMain;
        const shouldMirrorAgentMessage =
          !isMainSource &&
          !mainForwarded &&
          !autopilotTargetSet.has(mainAgentId) &&
          mirrorMode === "all-agent-messages" &&
          (Boolean(sourceAgent) || !echoedAgent);
        if (shouldMirrorAgentMessage) {
          const includeIntro = shouldIncludeRelayIntro(room.id, mainAgentId, timestamp);
          const protocolGuide = resolveRelayProtocolGuide(
            room,
            mainAgentId,
            timestamp,
            taskSignals.length > 0
          );
          // P0 fix: mark mirror messages as informational so main knows
          // this is a passive sync, not a message requiring a response.
          const mirrorText = buildRelaySystemEvent({
            roomId: room.id,
            sender: senderLabel,
            senderId,
            sourceAgent,
            receiverAccount: room.resolveAccountForAgent(mainAgentId) || ctx.accountId,
            messageId,
            timestamp,
            includeIntro: false,
            content: `[mirror-only 仅同步，无需回复]\n${content}`,
            protocolGuide,
            relayCompact: pluginConfig.teamroom.relayCompact
          });
          // ─── v2: Enrich mirror with cache context ───
          const mirrorCacheCtx = messageCache.buildContextBlock(room.id, mainAgentId, { maxMessages: 20 });
          const enrichedMirror = [
            mirrorText,
            mirrorCacheCtx ? `\n${mirrorCacheCtx}` : ""
          ].filter(Boolean).join("\n");

          enqueueRoomEventToAgent(
            room,
            mainAgentId,
            enrichedMirror,
            `teamchat:mirror:${room.id}:${messageId}:${mainAgentId}`
          );
          messageCache.markAllAsRead(room.id, mainAgentId);
        }
        if (!isMainSource && taskSignals.length > 0) {
          taskSignals.forEach((signal, index) => {
            const includeIntro = shouldIncludeRelayIntro(room.id, mainAgentId, timestamp);
            const signalText = buildTaskSignalSystemEvent({
              roomId: room.id,
              taskId: signal.taskId,
              status: signal.status,
              note: signal.note,
              sourceAgent,
              sender: senderLabel,
              messageId,
              timestamp,
              includeIntro
            });
            enqueueRoomEventToAgent(
              room,
              mainAgentId,
              signalText,
              `teamchat:task:${room.id}:${messageId}:${index}`
            );
          });
        }
      }
    }

    // --- Autopilot dispatch (after relay, only for non-echo external messages) ---
    if (autopilotTargets.length > 0) {
      const records = [];
      for (const targetAgent of autopilotTargets) {
        const dispatchBudget = state.tryConsumeDispatch(room.id, room, Date.now());
        if (!dispatchBudget.ok) {
          records.push({
            roomId: room.id,
            agentId: targetAgent,
            ok: false,
            detail: `dispatch limit reached (${dispatchBudget.maxDispatch})`
          });
          break;
        }
        const accountId = room.resolveAccountForAgent(targetAgent);

        // ─── v2: Build enriched prompt with cache context + task board ───
        const cacheContext = messageCache.buildContextBlock(room.id, targetAgent, { maxMessages: 30 });
        const boardContext = taskBoard.buildBoardContext(room.id, targetAgent);
        const prompt = buildAutopilotPrompt({
          roomId: room.id,
          sender: senderLabel,
          messageId,
          content,
          protocolGuide: room.protocol.enabled ? buildProtocolGuide(room) : "",
          extraPrompt: [
            cacheContext ? `\n最近群聊上下文：\n${cacheContext}` : "",
            boardContext ? `\n${boardContext}` : "",
            room.autopilot.extraPrompt || ""
          ].filter(Boolean).join("\n")
        });

        // Mark messages as read for this agent after building context
        messageCache.markAllAsRead(room.id, targetAgent);

        const result = await runAutopilotDispatch(api, room, targetAgent, accountId, prompt);
        records.push({
          roomId: room.id,
          agentId: targetAgent,
          ok: result.ok,
          detail: result.detail
        });
        // P0 fix: record the autopilot reply as outgoing so that when the
        // message arrives back via messageReceived, detectOutgoingEcho can
        // match it and prevent re-processing as a new external message.
        if (result.ok && result.replyText) {
          const normalizedReply = normalizeRelayContent(result.replyText);
          if (normalizedReply) {
            state.recordOutgoing(room.id, normalizedReply, targetAgent, Date.now());
          }
        }
      }
      state.setAutopilotRecords(records);
    }
  }

  function beforeMessageWrite(event, ctx) {
    if (!pluginConfig.teamroom.enabled) return;

    const agentId = asString(ctx?.agentId);
    if (!agentId) return;

    let content = extractAssistantTextFromMessage(event?.message);
    content = normalizeRelayContent(content);
    if (!content) return;

    const now = Date.now();
    const activeRoomId = state.resolveAgentRoom(agentId, now);
    const fallbackRoomId = parseRoomIdFromSessionKey(ctx?.sessionKey);
    const roomId = activeRoomId || fallbackRoomId;
    if (!roomId || !isLikelyGroupId(roomId)) return;

    const room = pluginConfig.teamroom.roomsById[roomId];
    if (!room || !room.enabled) return;
    if (!room.memberAgents.includes(agentId)) return;

    // Dedup: skip if this content was already relayed via beforeToolCall or messageSending
    if (state.hasRecentOutgoing(roomId, content, now, room.outgoingEchoWindowSeconds)) {
      api.logger.debug?.(
        `[teamchat] before_message_write skip: already relayed via send path room=${roomId} agent=${agentId}`
      );
      return;
    }

    const accountId = room.resolveAccountForAgent(agentId) || pluginConfig.identity.agentToAccount[agentId] || "";
    const messageId = `assistant:${room.id}:${agentId}:${now}:${textHash(content)}`;

    // ─── v2: Write agent assistant message to cache ───
    if (!messageCache.hasRecentMessage(roomId, content, agentId, 10000)) {
      messageCache.appendMessage(roomId, {
        id: messageId,
        ts: now,
        sender: agentId,
        senderId: pluginConfig.identity.agentToSenderId[agentId] || accountId || agentId,
        sourceAgent: agentId,
        content,
        mentions: resolveMentionedAgents(content, room),
        type: "message"
      });
    }

    api.logger.debug?.(
      `[teamchat] before_message_write relay: room=${room.id} agent=${agentId} session=${asString(ctx?.sessionKey) || "unknown"}`
    );
    void relayOutgoingAgentMessage({
      room,
      sourceAgent: agentId,
      content,
      accountId,
      senderLabel: agentId,
      messageId,
      timestamp: now,
      contextPrefix: "write"
    }).catch((err) => {
      api.logger.warn(`[teamchat] before_message_write relay failed: ${String(err)}`);
    });
  }

  function commandHandler(ctx) {
    const args = asString(ctx.args);
    const commandName = pluginConfig.command.name;
    if (!args || args === "status") {
      const report = state.snapshot(pluginConfig.teamroom.rooms);
      // v2: add cache and board status
      const cacheLines = [];
      for (const room of pluginConfig.teamroom.rooms) {
        cacheLines.push(messageCache.snapshot(room.id, room.memberAgents));
      }
      const cacheReport = cacheLines.filter(Boolean).join("\n");
      return {
        text: [
          report ? `[teamchat] status\n${report}` : `[teamchat] no rooms configured.`,
          cacheReport ? `\n[cache]\n${cacheReport}` : ""
        ].filter(Boolean).join("\n")
      };
    }

    const tokens = splitCommandArgs(args);
    const verbRaw = tokens[0] || "";
    const roomIdRaw = tokens[1] || "";
    const verb = asString(verbRaw).toLowerCase();
    const roomId = asString(roomIdRaw);
    if (verb === "task") {
      const action = asString(tokens[1]).toLowerCase();
      const taskId = asString(tokens[2]);
      const statusRaw = asString(tokens[3]);
      if (action !== "create" && action !== "update") {
        return {
          text: `[teamchat] unknown task action.\nUse /${commandName} task create <taskId> [owner=<agentId>] [note=<text>] [room=<roomId>] | /${commandName} task update <taskId> <status> [owner=<agentId>] [note=<text>] [room=<roomId>]`
        };
      }
      if (!taskId) {
        return { text: `[teamchat] taskId is required.` };
      }

      const tailStart = action === "create" ? 3 : 4;
      const tail = parseTaskTail(tokens.slice(tailStart));
      const resolvedRoom = resolveCommandRoomId(pluginConfig, ctx, tail.roomId);
      if (resolvedRoom.error) return { text: `[teamchat] ${resolvedRoom.error}` };
      const room = pluginConfig.teamroom.roomsById[resolvedRoom.roomId];
      if (!room || !room.enabled) {
        return { text: `[teamchat] room not available: ${resolvedRoom.roomId}` };
      }

      const actor =
        asString(ctx.senderName) ||
        asString(ctx.senderId) ||
        asString(ctx.userId) ||
        asString(ctx.agentId) ||
        "manual";
      const status =
        action === "create" ? "create" : normalizeManualTaskStatus(statusRaw);
      if (!status) {
        return {
          text: `[teamchat] invalid status: ${statusRaw || "(empty)"}.\nAllowed: create|ack|in_progress|blocked|done|review_ok|rework`
        };
      }

      const result = state.applyTaskSignal(
        room.id,
        {
          taskId,
          status,
          note: tail.note,
          owner: tail.owner
        },
        actor,
        Date.now()
      );
      if (!result?.ok) {
        if (result?.reason === "active_conflict") {
          return {
            text: `[teamchat] active task conflict in room=${room.id}. active=${result.activeTaskId}. Please update/close active task first.`
          };
        }
        return { text: `[teamchat] failed to update task.` };
      }
      const record = result.record;
      if (result.closed) {
        void maybeWriteTaskMemory(room, record, actor, Date.now());
      }
      return {
        text: `[teamchat] task updated room=${room.id} task=${record.taskId} status=${record.status} owner=${record.owner || "unknown"}${record.lastNote ? ` note=${record.lastNote}` : ""}${result.closed ? " closed=yes" : ""}`
      };
    }
    if (verb === "tasks") {
      if (roomId && roomId !== "all" && !pluginConfig.teamroom.roomsById[roomId]) {
        return { text: `[teamchat] room not found: ${roomId}` };
      }
      // v2: use TaskBoard alongside legacy state
      const legacyReport = state.taskSnapshot(
        pluginConfig.teamroom.rooms,
        roomId === "all" ? "" : roomId
      );
      const boardLines = [];
      const selectedRooms = roomId && roomId !== "all"
        ? pluginConfig.teamroom.rooms.filter((r) => r.id === roomId)
        : pluginConfig.teamroom.rooms;
      for (const room of selectedRooms) {
        boardLines.push(taskBoard.snapshot(room.id));
      }
      const boardReport = boardLines.filter(Boolean).join("\n");
      return {
        text: [
          legacyReport ? `[teamchat] tasks (legacy)\n${legacyReport}` : "",
          boardReport ? `[teamchat] tasks (v2 board)\n${boardReport}` : "[teamchat] no tasks."
        ].filter(Boolean).join("\n\n")
      };
    }
    if (verb === "reset") {
      if (!roomId || roomId === "all") {
        for (const room of pluginConfig.teamroom.rooms) {
          state.resetCycle(room.id);
        }
        return { text: `[teamchat] reset all room cycles.` };
      }
      if (!pluginConfig.teamroom.roomsById[roomId]) {
        return { text: `[teamchat] room not found: ${roomId}` };
      }
      state.resetCycle(roomId);
      return { text: `[teamchat] reset room cycle: ${roomId}` };
    }

    return {
      text: `[teamchat] unknown subcommand.\nUse /${commandName} status | /${commandName} tasks [roomId|all] | /${commandName} task create <taskId> [owner=<agentId>] [note=<text>] [room=<roomId>] | /${commandName} task update <taskId> <status> [owner=<agentId>] [note=<text>] [room=<roomId>] | /${commandName} reset <roomId|all>`
    };
  }

  return {
    beforeToolCall,
    beforeMessageWrite,
    messageSending,
    messageReceived,
    commandHandler
  };
}
