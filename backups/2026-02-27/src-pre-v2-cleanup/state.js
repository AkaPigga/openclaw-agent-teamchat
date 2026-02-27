import { asString, textHash } from "./utils.js";
import {
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const DATA_DIR = join(homedir(), ".openclaw", "plugin-data", "agent-teamchat");
const CYCLES_PATH = join(DATA_DIR, "cycles.json");
const TASKS_ROOT = join(DATA_DIR, "tasks");
const LOCKS_DIR = join(DATA_DIR, ".locks");
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 25;
const LOCK_RETRIES = 40;

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function logWarn(logger, message) {
  if (logger && typeof logger.warn === "function") {
    logger.warn(message);
  }
}

function withFileLock(lockName, fn, logger) {
  const safeName = sanitizeFilePart(lockName || "lock");
  const lockPath = join(LOCKS_DIR, `${safeName}.lock`);
  try {
    mkdirSync(LOCKS_DIR, { recursive: true });
  } catch (err) {
    logWarn(logger, `[teamchat] cannot create lock dir: ${String(err)}`);
  }

  let lockFd = null;
  for (let i = 0; i < LOCK_RETRIES; i += 1) {
    try {
      lockFd = openSync(lockPath, "wx");
      break;
    } catch {
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
        }
      } catch {}
      sleepMs(LOCK_WAIT_MS);
    }
  }
  if (lockFd == null) {
    logWarn(logger, `[teamchat] lock timeout: ${lockPath}`);
    return false;
  }

  try {
    fn();
    return true;
  } catch (err) {
    logWarn(logger, `[teamchat] locked write failed (${safeName}): ${String(err)}`);
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

function loadJson(filePath, fallback, logger) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch (err) {
    logWarn(logger, `[teamchat] load json failed: ${filePath} err=${String(err)}`);
  }
  return fallback;
}

function writeJsonAtomic(filePath, data, logger) {
  const dir = dirname(filePath);
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
    renameSync(temp, filePath);
    return true;
  } catch (err) {
    logWarn(logger, `[teamchat] write json failed: ${filePath} err=${String(err)}`);
    try {
      rmSync(temp, { force: true });
    } catch {}
    return false;
  }
}

function sanitizeFilePart(input) {
  const text = asString(input).replace(/[^a-zA-Z0-9._-]/g, "_");
  return text || "task";
}

function tsKey(ts) {
  const iso = new Date(Number(ts) || Date.now()).toISOString();
  return iso.replace(/[:.]/g, "-");
}

function roomDir(roomId) {
  return join(TASKS_ROOT, roomId);
}

function roomActivePath(roomId) {
  return join(roomDir(roomId), "active.json");
}

function roomHistoryDir(roomId) {
  return join(roomDir(roomId), "history");
}

function isTerminalStatus(status) {
  const normalized = asString(status).toLowerCase();
  return normalized === "done" || normalized === "review_ok";
}

function pruneSeen(entry, maxSize) {
  while (entry.order.length > maxSize) {
    const oldest = entry.order.shift();
    if (oldest) entry.set.delete(oldest);
  }
}

function pruneOutgoing(list, ttlMs, now) {
  if (list.length === 0) return;
  const cutoff = now - ttlMs;
  let idx = 0;
  while (idx < list.length && list[idx].ts < cutoff) idx += 1;
  if (idx > 0) list.splice(0, idx);
}

function normalizeLoadedTask(record) {
  const taskId = asString(record?.taskId);
  const status = asString(record?.status).toLowerCase();
  if (!taskId || !status) return null;
  const createdAt = Number(record?.createdAt) || Date.now();
  const updatedAt = Number(record?.updatedAt) || createdAt;
  const historyRaw = Array.isArray(record?.history) ? record.history : [];
  const history = historyRaw
    .map((item) => ({
      status: asString(item?.status).toLowerCase(),
      actor: asString(item?.actor) || "unknown",
      note: asString(item?.note),
      at: Number(item?.at) || updatedAt
    }))
    .filter((item) => item.status);
  return {
    taskId,
    status,
    owner: asString(record?.owner),
    lastActor: asString(record?.lastActor) || "unknown",
    lastNote: asString(record?.lastNote),
    createdAt,
    updatedAt,
    closedAt: Number(record?.closedAt) || 0,
    history
  };
}

export class TeamChatState {
  constructor(options = {}) {
    this.persistence = options.persistence !== false;
    this.logger = options.logger || null;
    this.cycles = new Map();
    this.seenByRoom = new Map();
    this.outgoingByRoom = new Map();
    this.proactiveRelayByRoom = new Map();
    this.agentRoomContext = new Map();
    this.activeTaskByRoom = new Map();
    this.lastClosedTaskByRoom = new Map();
    this.closedCountByRoom = new Map();
    this.lastAutopilot = [];
    if (this.persistence) {
      this.loadPersistedCycles();
      this.loadPersistedTasks();
    }
  }

  loadPersistedCycles() {
    const saved = loadJson(CYCLES_PATH, {}, this.logger);
    for (const [roomId, data] of Object.entries(saved)) {
      this.cycles.set(roomId, {
        turnsUsed: data.turnsUsed ?? 0,
        dispatchCount: data.dispatchCount ?? 0,
        maxTurns: 0,
        maxDispatch: 0,
        ttlMs: 0,
        createdAt: data.createdAt ?? Date.now(),
        lastInboundAt: data.lastInboundAt ?? 0,
        lastActivityAt: data.lastActivityAt ?? 0
      });
    }
  }

  persistCycles() {
    if (!this.persistence) return;
    withFileLock(
      "cycles",
      () => {
        const data = {};
        for (const [roomId, cycle] of this.cycles.entries()) {
          data[roomId] = {
            turnsUsed: cycle.turnsUsed,
            dispatchCount: cycle.dispatchCount,
            createdAt: cycle.createdAt,
            lastInboundAt: cycle.lastInboundAt,
            lastActivityAt: cycle.lastActivityAt
          };
        }
        writeJsonAtomic(CYCLES_PATH, data, this.logger);
      },
      this.logger
    );
  }

  loadPersistedTasks() {
    if (!existsSync(TASKS_ROOT)) return;
    let roomEntries = [];
    try {
      roomEntries = readdirSync(TASKS_ROOT, { withFileTypes: true });
    } catch {
      roomEntries = [];
    }
    for (const entry of roomEntries) {
      if (!entry.isDirectory()) continue;
      const roomId = entry.name;
      const activeRaw = loadJson(roomActivePath(roomId), null, this.logger);
      const active = normalizeLoadedTask(activeRaw);
      if (active && !active.closedAt) {
        this.activeTaskByRoom.set(roomId, active);
      }

      const histDir = roomHistoryDir(roomId);
      if (!existsSync(histDir)) continue;
      let files = [];
      try {
        files = readdirSync(histDir).filter((name) => name.endsWith(".json")).sort();
      } catch {
        files = [];
      }
      if (files.length === 0) continue;
      this.closedCountByRoom.set(roomId, files.length);
      const last = loadJson(join(histDir, files[files.length - 1]), null, this.logger);
      const lastClosed = normalizeLoadedTask(last);
      if (lastClosed) this.lastClosedTaskByRoom.set(roomId, lastClosed);
    }
  }

  persistActiveTask(roomId, task) {
    if (!this.persistence) return;
    const activePath = roomActivePath(roomId);
    withFileLock(
      `task-active-${roomId}`,
      () => {
        if (!task) {
          try {
            rmSync(activePath, { force: true });
          } catch (err) {
            logWarn(this.logger, `[teamchat] remove active task failed: ${activePath} err=${String(err)}`);
          }
          return;
        }
        writeJsonAtomic(activePath, task, this.logger);
      },
      this.logger
    );
  }

  archiveTask(roomId, task) {
    this.closedCountByRoom.set(roomId, (this.closedCountByRoom.get(roomId) || 0) + 1);
    this.lastClosedTaskByRoom.set(roomId, task);
    if (!this.persistence) return;
    withFileLock(
      `task-history-${roomId}`,
      () => {
        const dir = roomHistoryDir(roomId);
        const file = `${tsKey(task.closedAt || Date.now())}-${sanitizeFilePart(task.taskId)}.json`;
        writeJsonAtomic(join(dir, file), task, this.logger);
      },
      this.logger
    );
  }

  getHistoryCount(roomId) {
    if (!this.persistence) return this.closedCountByRoom.get(roomId) || 0;
    const dir = roomHistoryDir(roomId);
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  getActiveTask(roomId) {
    return this.activeTaskByRoom.get(roomId) || null;
  }

  hasSeenMessage(roomId, key) {
    const room = this.seenByRoom.get(roomId);
    if (!room) return false;
    return room.set.has(key);
  }

  markSeenMessage(roomId, key, maxSize) {
    if (!roomId || !key) return;
    let room = this.seenByRoom.get(roomId);
    if (!room) {
      room = { set: new Set(), order: [] };
      this.seenByRoom.set(roomId, room);
    }
    if (room.set.has(key)) return;
    room.set.add(key);
    room.order.push(key);
    pruneSeen(room, maxSize);
  }

  getCycle(roomId, roomConfig, now) {
    const ttlMs = roomConfig.cycleTtlSeconds * 1000;
    const maxTurns = roomConfig.maxTurnsPerCycle;
    const maxDispatch = roomConfig.autopilot.maxDispatchPerCycle ?? maxTurns;
    const existing = this.cycles.get(roomId);
    if (!existing || now - existing.createdAt > ttlMs) {
      const created = {
        turnsUsed: 0,
        dispatchCount: 0,
        maxTurns,
        maxDispatch,
        ttlMs,
        createdAt: now,
        lastInboundAt: 0,
        lastActivityAt: now
      };
      this.cycles.set(roomId, created);
      return created;
    }
    existing.maxTurns = maxTurns;
    existing.maxDispatch = maxDispatch;
    existing.ttlMs = ttlMs;
    return existing;
  }

  registerInboundExternal(roomId, roomConfig, now) {
    const cycle = this.getCycle(roomId, roomConfig, now);
    // P2 fix: debounce cycle reset. If the last inbound external message
    // was less than 5 seconds ago, don't reset turnsUsed/dispatchCount.
    // This prevents rapid-fire user messages (e.g. 5 messages in 10s)
    // from granting 5 × maxTurns worth of agent replies.
    const DEBOUNCE_MS = 5000;
    const shouldReset = !cycle.lastInboundAt || (now - cycle.lastInboundAt >= DEBOUNCE_MS);
    if (shouldReset) {
      cycle.turnsUsed = 0;
      cycle.dispatchCount = 0;
    }
    cycle.lastInboundAt = now;
    cycle.lastActivityAt = now;
    this.persistCycles();
    return cycle;
  }

  tryConsumeTurn(roomId, roomConfig, now) {
    const cycle = this.getCycle(roomId, roomConfig, now);
    if (cycle.turnsUsed >= cycle.maxTurns) {
      return {
        ok: false,
        turnsUsed: cycle.turnsUsed,
        maxTurns: cycle.maxTurns
      };
    }
    cycle.turnsUsed += 1;
    cycle.lastActivityAt = now;
    this.persistCycles();
    return {
      ok: true,
      turnsUsed: cycle.turnsUsed,
      maxTurns: cycle.maxTurns
    };
  }

  tryConsumeDispatch(roomId, roomConfig, now) {
    const cycle = this.getCycle(roomId, roomConfig, now);
    if (cycle.dispatchCount >= cycle.maxDispatch) {
      return {
        ok: false,
        dispatchCount: cycle.dispatchCount,
        maxDispatch: cycle.maxDispatch
      };
    }
    cycle.dispatchCount += 1;
    cycle.lastActivityAt = now;
    this.persistCycles();
    return {
      ok: true,
      dispatchCount: cycle.dispatchCount,
      maxDispatch: cycle.maxDispatch
    };
  }

  resetCycle(roomId) {
    this.cycles.delete(roomId);
    this.persistCycles();
  }

  recordOutgoing(roomId, text, agentId, now) {
    if (!roomId || !text) return;
    const entry = {
      hash: textHash(text),
      text,
      agentId,
      ts: now
    };
    let list = this.outgoingByRoom.get(roomId);
    if (!list) {
      list = [];
      this.outgoingByRoom.set(roomId, list);
    }
    list.push(entry);
  }

  hasRecentOutgoing(roomId, text, now, windowSeconds) {
    const list = this.outgoingByRoom.get(roomId);
    if (!list || list.length === 0) return false;
    const ttlMs = Math.max(1000, (windowSeconds || 30) * 1000);
    const hash = textHash(text);
    return list.some((item) => item.hash === hash && now - item.ts < ttlMs);
  }

  detectOutgoingEcho(roomId, text, now, windowSeconds) {
    const list = this.outgoingByRoom.get(roomId);
    if (!list || list.length === 0) return null;
    const ttlMs = Math.max(1000, windowSeconds * 1000);
    pruneOutgoing(list, ttlMs, now);
    const hash = textHash(text);
    const idx = list.findIndex((item) => item.hash === hash);
    if (idx < 0) return null;
    const match = list[idx];
    list.splice(idx, 1);
    return match.agentId || null;
  }

  markProactiveRelay(roomId, text, now) {
    if (!roomId || !text) return;
    const entry = {
      hash: textHash(text),
      ts: now
    };
    let list = this.proactiveRelayByRoom.get(roomId);
    if (!list) {
      list = [];
      this.proactiveRelayByRoom.set(roomId, list);
    }
    list.push(entry);
  }

  consumeProactiveRelayEcho(roomId, text, now, windowSeconds) {
    const list = this.proactiveRelayByRoom.get(roomId);
    if (!list || list.length === 0) return false;
    const ttlMs = Math.max(1000, windowSeconds * 1000);
    pruneOutgoing(list, ttlMs, now);
    const hash = textHash(text);
    const idx = list.findIndex((item) => item.hash === hash);
    if (idx < 0) return false;
    list.splice(idx, 1);
    return true;
  }

  setAutopilotRecords(records) {
    this.lastAutopilot = Array.isArray(records) ? records.slice() : [];
  }

  bindAgentRoom(agentId, roomId, now, ttlMs) {
    if (!agentId || !roomId) return;
    const ttl = Math.max(30_000, Number(ttlMs) || 900_000);
    this.agentRoomContext.set(agentId, {
      roomId,
      expiresAt: now + ttl,
      updatedAt: now
    });
  }

  resolveAgentRoom(agentId, now) {
    if (!agentId) return "";
    const entry = this.agentRoomContext.get(agentId);
    if (!entry) return "";
    if (now > entry.expiresAt) {
      this.agentRoomContext.delete(agentId);
      return "";
    }
    return entry.roomId || "";
  }

  clearAgentRoom(agentId) {
    if (!agentId) return;
    this.agentRoomContext.delete(agentId);
  }

  applyTaskSignal(roomId, signal, actor, now) {
    const taskId = asString(signal?.taskId);
    const status = asString(signal?.status).toLowerCase();
    const note = asString(signal?.note);
    const owner = asString(signal?.owner);
    const normalizedActor = asString(actor) || "external";
    if (!roomId || !taskId || !status) {
      return { ok: false, reason: "invalid" };
    }

    const active = this.getActiveTask(roomId);
    if (!active) {
      const created = {
        taskId,
        status,
        owner: owner || (status === "create" || status === "ack" ? normalizedActor : ""),
        lastActor: normalizedActor,
        lastNote: note,
        createdAt: now,
        updatedAt: now,
        closedAt: 0,
        history: [{ status, actor: normalizedActor, note, at: now }]
      };
      if (isTerminalStatus(status)) {
        created.closedAt = now;
        this.archiveTask(roomId, created);
        this.persistActiveTask(roomId, null);
        return { ok: true, created: true, closed: true, record: created };
      }
      this.activeTaskByRoom.set(roomId, created);
      this.persistActiveTask(roomId, created);
      return { ok: true, created: true, closed: false, record: created };
    }

    if (active.taskId !== taskId) {
      return {
        ok: false,
        reason: "active_conflict",
        activeTaskId: active.taskId,
        active
      };
    }

    const history = Array.isArray(active.history) ? active.history.slice(-99) : [];
    history.push({ status, actor: normalizedActor, note, at: now });
    const next = {
      ...active,
      status,
      owner: owner || active.owner || (status === "create" || status === "ack" ? normalizedActor : ""),
      lastActor: normalizedActor,
      lastNote: note,
      updatedAt: now,
      history
    };

    if (isTerminalStatus(status)) {
      next.closedAt = now;
      this.archiveTask(roomId, next);
      this.activeTaskByRoom.delete(roomId);
      this.persistActiveTask(roomId, null);
      return { ok: true, updated: true, closed: true, record: next };
    }

    this.activeTaskByRoom.set(roomId, next);
    this.persistActiveTask(roomId, next);
    return { ok: true, updated: true, closed: false, record: next };
  }

  listTasks(roomId) {
    const active = this.getActiveTask(roomId);
    return active ? [active] : [];
  }

  taskSnapshot(rooms, roomId) {
    const selected = roomId ? rooms.filter((room) => room.id === roomId) : rooms;
    const lines = [];
    for (const room of selected) {
      const active = this.getActiveTask(room.id);
      const closedCount = this.getHistoryCount(room.id);
      const lastClosed = this.lastClosedTaskByRoom.get(room.id);
      if (!active) {
        if (lastClosed) {
          lines.push(
            `- ${room.id}: active=none closed=${closedCount} lastClosed=${lastClosed.taskId}:${lastClosed.status}`
          );
        } else {
          lines.push(`- ${room.id}: active=none closed=${closedCount}`);
        }
        continue;
      }
      const owner = asString(active.owner) || "unknown";
      const actor = asString(active.lastActor) || "unknown";
      const note = asString(active.lastNote);
      lines.push(
        `- ${room.id}: active=${active.taskId} status=${active.status} owner=${owner} actor=${actor} closed=${closedCount}${note ? ` note=${note}` : ""}`
      );
    }
    return lines.join("\n");
  }

  snapshot(rooms) {
    const lines = [];
    for (const room of rooms) {
      const cycle = this.cycles.get(room.id);
      const taskCount = this.getActiveTask(room.id) ? 1 : 0;
      if (!cycle) {
        lines.push(
          `- ${room.id}: turns=0/${room.maxTurnsPerCycle}, dispatch=0/${room.autopilot.maxDispatchPerCycle ?? room.maxTurnsPerCycle}, tasks=${taskCount}`
        );
        continue;
      }
      lines.push(
        `- ${room.id}: turns=${cycle.turnsUsed}/${cycle.maxTurns}, dispatch=${cycle.dispatchCount}/${cycle.maxDispatch}, lastInbound=${cycle.lastInboundAt || 0}, tasks=${taskCount}`
      );
    }
    if (this.lastAutopilot.length > 0) {
      lines.push("");
      lines.push("Recent autopilot:");
      for (const entry of this.lastAutopilot.slice(-10)) {
        lines.push(
          `- room=${entry.roomId} agent=${entry.agentId} ok=${entry.ok ? "yes" : "no"} detail=${entry.detail}`
        );
      }
    }
    return lines.join("\n");
  }
}
