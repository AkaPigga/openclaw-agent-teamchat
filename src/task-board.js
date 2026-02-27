import { asString } from "./utils.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".openclaw", "plugin-data", "agent-teamchat");
const ROOMS_DIR = join(DATA_DIR, "rooms");
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 25;
const LOCK_RETRIES = 40;

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function withFileLock(lockPath, fn, logger) {
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
    if (logger) logger.warn(`[teamchat] task lock timeout: ${lockPath}`);
    return false;
  }
  try {
    fn();
    return true;
  } catch (err) {
    if (logger) logger.warn(`[teamchat] task locked op failed: ${String(err)}`);
    return false;
  } finally {
    try { closeSync(lockFd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

function sanitizeRoomId(roomId) {
  return asString(roomId).replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

function sanitizeTaskId(taskId) {
  return asString(taskId).replace(/[^a-zA-Z0-9._-]/g, "_") || "task";
}

function roomTasksDir(roomId) {
  return join(ROOMS_DIR, sanitizeRoomId(roomId), "tasks");
}

function activeDir(roomId) {
  return join(roomTasksDir(roomId), "active");
}

function historyDir(roomId) {
  return join(roomTasksDir(roomId), "history");
}

function boardPath(roomId) {
  return join(roomTasksDir(roomId), "board.json");
}

function taskFilePath(roomId, taskId) {
  return join(activeDir(roomId), `${sanitizeTaskId(taskId)}.json`);
}

function taskLockPath(roomId) {
  return join(roomTasksDir(roomId), ".task.lock");
}

function readJsonSafe(filePath, fallback, logger) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch {}
  return fallback;
}

function writeJsonAtomic(filePath, data, logger) {
  const dir = dirname(filePath);
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
    renameSync(temp, filePath);
    return true;
  } catch (err) {
    if (logger) logger.warn(`[teamchat] write json failed: ${filePath} err=${String(err)}`);
    try { rmSync(temp, { force: true }); } catch {}
    return false;
  }
}

function tsKey(ts) {
  return new Date(Number(ts) || Date.now()).toISOString().replace(/[:.]/g, "-");
}

const TERMINAL_STATUSES = new Set(["done", "review_ok"]);

function isTerminal(status) {
  return TERMINAL_STATUSES.has(asString(status).toLowerCase());
}

/**
 * Derive overall task status from slots.
 * Rules:
 * - all slots done/review_ok → done
 * - any slot blocked → blocked
 * - any slot in_progress → in_progress
 * - otherwise → ack
 */
function deriveTaskStatus(slots) {
  const entries = Object.values(slots || {});
  if (entries.length === 0) return "create";
  const statuses = entries.map((s) => asString(s.status).toLowerCase());
  if (statuses.every((s) => s === "done" || s === "review_ok")) return "done";
  if (statuses.some((s) => s === "blocked")) return "blocked";
  if (statuses.some((s) => s === "in_progress")) return "in_progress";
  return "ack";
}

/**
 * Migrate a legacy task (no slots) to v3 format.
 */
function migrateLegacyTask(task) {
  if (task.slots) return task; // already v3
  const slots = {};
  const assignee = asString(task.assignee || task.owner);
  if (assignee) {
    slots[assignee] = {
      status: asString(task.status) || "ack",
      rounds: task.rounds?.length || 1,
      lastNote: asString(task.lastNote || ""),
      lastAt: task.updatedAt || task.createdAt || Date.now(),
      history: (task.history || []).map((h) => ({
        status: asString(h.status),
        note: asString(h.note),
        at: h.at || task.updatedAt
      }))
    };
  }
  return {
    ...task,
    slots,
    globalHistory: (task.history || []).map((h) => ({
      actor: asString(h.actor || assignee || "unknown"),
      status: asString(h.status),
      note: asString(h.note),
      at: h.at || task.updatedAt
    }))
  };
}

// ─── TaskBoard class ───

export class TaskBoard {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.maxActiveTasks = options.maxActiveTasks || 10;
    this.roundTracking = options.roundTracking !== false;
  }

  _ensureDirs(roomId) {
    mkdirSync(activeDir(roomId), { recursive: true });
    mkdirSync(historyDir(roomId), { recursive: true });
  }

  getBoard(roomId) {
    return readJsonSafe(boardPath(roomId), { roomId, tasks: {}, updatedAt: 0 }, this.logger);
  }

  _saveBoard(roomId, board) {
    board.updatedAt = Date.now();
    writeJsonAtomic(boardPath(roomId), board, this.logger);
  }

  getTask(roomId, taskId) {
    const raw = readJsonSafe(taskFilePath(roomId, taskId), null, this.logger);
    return raw ? migrateLegacyTask(raw) : null;
  }

  listActiveTasks(roomId) {
    const dir = activeDir(roomId);
    if (!existsSync(dir)) return [];
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      const tasks = [];
      for (const file of files) {
        const raw = readJsonSafe(join(dir, file), null, this.logger);
        if (raw && raw.taskId) tasks.push(migrateLegacyTask(raw));
      }
      return tasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    } catch {
      return [];
    }
  }

  createTask(roomId, params) {
    const taskId = asString(params.taskId);
    if (!roomId || !taskId) return { ok: false, reason: "invalid" };

    this._ensureDirs(roomId);
    const lp = taskLockPath(roomId);
    let result = null;

    withFileLock(lp, () => {
      const activeTasks = this.listActiveTasks(roomId);
      if (activeTasks.length >= this.maxActiveTasks) {
        result = { ok: false, reason: "max_active_reached", count: activeTasks.length };
        return;
      }

      const existing = this.getTask(roomId, taskId);
      if (existing) {
        result = { ok: false, reason: "already_exists", task: existing };
        return;
      }

      const now = Date.now();
      const actor = asString(params.createdBy) || "unknown";
      const initialStatus = asString(params.status) || "create";

      // Slots start empty — agents populate their own slot when they signal
      const slots = {};

      const task = {
        taskId,
        summary: asString(params.summary) || "",
        status: initialStatus,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
        closedAt: 0,
        slots,
        globalHistory: [
          { actor, status: initialStatus, note: asString(params.note) || "", at: now }
        ]
      };

      writeJsonAtomic(taskFilePath(roomId, taskId), task, this.logger);

      const board = this.getBoard(roomId);
      board.tasks[taskId] = { status: task.status, summary: task.summary };
      this._saveBoard(roomId, board);

      result = { ok: true, created: true, task };
    }, this.logger);

    return result || { ok: false, reason: "lock_failed" };
  }

  /**
   * Update a task — writes into the actor's slot.
   * actor: the agent id sending the signal (e.g. "builder", "researcher")
   */
  updateTask(roomId, params) {
    const taskId = asString(params.taskId);
    const status = asString(params.status).toLowerCase();
    const actor = asString(params.actor) || "unknown";
    if (!roomId || !taskId || !status) return { ok: false, reason: "invalid" };

    this._ensureDirs(roomId);
    const lp = taskLockPath(roomId);
    let result = null;

    withFileLock(lp, () => {
      const task = this.getTask(roomId, taskId);
      if (!task) {
        result = { ok: false, reason: "not_found", taskId };
        return;
      }

      const now = Date.now();
      const note = asString(params.note) || "";

      // Update actor's slot
      const slots = task.slots || {};
      if (!slots[actor]) {
        slots[actor] = { status, rounds: 1, lastNote: note, lastAt: now, history: [] };
      } else {
        slots[actor].rounds = (slots[actor].rounds || 0) + 1;
        slots[actor].status = status;
        slots[actor].lastNote = note;
        slots[actor].lastAt = now;
      }
      slots[actor].history = (slots[actor].history || []).slice(-19);
      slots[actor].history.push({ status, note, at: now });

      // Append to globalHistory
      const globalHistory = (task.globalHistory || []).slice(-99);
      globalHistory.push({ actor, status, note, at: now });

      // Derive overall task status from all slots
      const derivedStatus = deriveTaskStatus(slots);

      const next = {
        ...task,
        slots,
        globalHistory,
        status: derivedStatus,
        updatedAt: now
      };

      // Handle terminal
      if (isTerminal(derivedStatus)) {
        next.closedAt = now;
        const histFile = `${tsKey(now)}-${sanitizeTaskId(taskId)}.json`;
        writeJsonAtomic(join(historyDir(roomId), histFile), next, this.logger);
        try { rmSync(taskFilePath(roomId, taskId), { force: true }); } catch {}
        const board = this.getBoard(roomId);
        delete board.tasks[taskId];
        this._saveBoard(roomId, board);
        result = { ok: true, updated: true, closed: true, task: next };
        return;
      }

      writeJsonAtomic(taskFilePath(roomId, taskId), next, this.logger);
      const board = this.getBoard(roomId);
      board.tasks[taskId] = { status: next.status, summary: next.summary };
      this._saveBoard(roomId, board);

      result = { ok: true, updated: true, closed: false, task: next };
    }, this.logger);

    return result || { ok: false, reason: "lock_failed" };
  }

  /**
   * Build task board context for injection into agent prompts.
   * Shows each agent's slot status and round count.
   */
  buildBoardContext(roomId, agentId) {
    const tasks = this.listActiveTasks(roomId);
    if (tasks.length === 0) return "";

    const lines = ["[task-board]"];
    for (const task of tasks) {
      lines.push(`${task.taskId} [${task.status}] "${task.summary}"`);
      const slots = task.slots || {};
      for (const [agent, slot] of Object.entries(slots)) {
        const marker = agent === agentId ? "👉 " : "   ";
        lines.push(
          `${marker}${agent}: ${slot.status} (${slot.rounds}轮) — ${slot.lastNote || "-"}`
        );
      }
    }
    lines.push("[/task-board]");
    return lines.join("\n");
  }

  snapshot(roomId) {
    const tasks = this.listActiveTasks(roomId);
    const dir = historyDir(roomId);
    let closedCount = 0;
    if (existsSync(dir)) {
      try {
        closedCount = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
      } catch {}
    }

    if (tasks.length === 0) {
      return `room=${roomId}: active=0 closed=${closedCount}`;
    }

    const lines = [`room=${roomId}: active=${tasks.length} closed=${closedCount}`];
    for (const task of tasks) {
      const slots = task.slots || {};
      const slotSummary = Object.entries(slots)
        .map(([agent, s]) => `${agent}:${s.status}(${s.rounds}轮)`)
        .join(", ");
      lines.push(
        `  ${task.taskId} [${task.status}] "${task.summary}"${slotSummary ? ` — ${slotSummary}` : ""}`
      );
    }
    return lines.join("\n");
  }
}
