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

// ─── TaskBoard class ───

export class TaskBoard {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.maxActiveTasks = options.maxActiveTasks || 10;
    this.roundTracking = options.roundTracking !== false;
  }

  /**
   * Ensure task directories exist for a room.
   */
  _ensureDirs(roomId) {
    mkdirSync(activeDir(roomId), { recursive: true });
    mkdirSync(historyDir(roomId), { recursive: true });
  }

  /**
   * Read the board summary for a room.
   */
  getBoard(roomId) {
    return readJsonSafe(boardPath(roomId), { roomId, tasks: {}, updatedAt: 0 }, this.logger);
  }

  /**
   * Persist the board summary.
   */
  _saveBoard(roomId, board) {
    board.updatedAt = Date.now();
    writeJsonAtomic(boardPath(roomId), board, this.logger);
  }

  /**
   * Get a single active task by ID.
   */
  getTask(roomId, taskId) {
    const filePath = taskFilePath(roomId, taskId);
    return readJsonSafe(filePath, null, this.logger);
  }

  /**
   * List all active tasks for a room.
   */
  listActiveTasks(roomId) {
    const dir = activeDir(roomId);
    if (!existsSync(dir)) return [];
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      const tasks = [];
      for (const file of files) {
        const task = readJsonSafe(join(dir, file), null, this.logger);
        if (task && task.taskId) tasks.push(task);
      }
      return tasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    } catch {
      return [];
    }
  }

  /**
   * Create a new task.
   */
  createTask(roomId, params) {
    const taskId = asString(params.taskId);
    if (!roomId || !taskId) return { ok: false, reason: "invalid" };

    this._ensureDirs(roomId);
    const lp = taskLockPath(roomId);
    let result = null;

    withFileLock(lp, () => {
      // Check max active tasks
      const activeTasks = this.listActiveTasks(roomId);
      if (activeTasks.length >= this.maxActiveTasks) {
        result = { ok: false, reason: "max_active_reached", count: activeTasks.length };
        return;
      }

      // Check if task already exists
      const existing = this.getTask(roomId, taskId);
      if (existing) {
        result = { ok: false, reason: "already_exists", task: existing };
        return;
      }

      const now = Date.now();
      const task = {
        taskId,
        summary: asString(params.summary) || "",
        status: asString(params.status) || "create",
        assignee: asString(params.assignee) || asString(params.owner) || "",
        createdBy: asString(params.createdBy) || "unknown",
        createdAt: now,
        updatedAt: now,
        closedAt: 0,
        rounds: [],
        observers: Array.isArray(params.observers) ? params.observers.filter(Boolean) : [],
        history: [
          {
            status: asString(params.status) || "create",
            actor: asString(params.createdBy) || "unknown",
            note: asString(params.note) || "",
            at: now
          }
        ]
      };

      // Add initial round if tracking enabled
      if (this.roundTracking && task.assignee) {
        task.rounds.push({
          round: 1,
          agent: task.assignee,
          status: task.status,
          startedAt: now,
          note: asString(params.note) || "task created"
        });
      }

      writeJsonAtomic(taskFilePath(roomId, taskId), task, this.logger);

      // Update board
      const board = this.getBoard(roomId);
      board.tasks[taskId] = {
        status: task.status,
        assignee: task.assignee,
        summary: task.summary
      };
      this._saveBoard(roomId, board);

      result = { ok: true, created: true, task };
    }, this.logger);

    return result || { ok: false, reason: "lock_failed" };
  }

  /**
   * Update a task's status, add a round, etc.
   */
  updateTask(roomId, params) {
    const taskId = asString(params.taskId);
    const status = asString(params.status).toLowerCase();
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
      const actor = asString(params.actor) || "unknown";
      const note = asString(params.note) || "";
      const newAssignee = asString(params.assignee);

      // Update fields
      task.status = status;
      task.updatedAt = now;
      if (newAssignee) task.assignee = newAssignee;

      // Add history entry
      task.history = (task.history || []).slice(-99);
      task.history.push({ status, actor, note, at: now });

      // Add round if agent is doing work
      if (this.roundTracking && (status === "in_progress" || status === "ack")) {
        const lastRound = task.rounds[task.rounds.length - 1];
        const roundNum = lastRound ? lastRound.round + 1 : 1;
        task.rounds.push({
          round: roundNum,
          agent: newAssignee || task.assignee || actor,
          status,
          startedAt: now,
          note
        });
      }

      // Handle terminal status
      if (isTerminal(status)) {
        task.closedAt = now;
        // Move to history
        const histFile = `${tsKey(now)}-${sanitizeTaskId(taskId)}.json`;
        writeJsonAtomic(join(historyDir(roomId), histFile), task, this.logger);
        // Remove from active
        try { rmSync(taskFilePath(roomId, taskId), { force: true }); } catch {}
        // Update board
        const board = this.getBoard(roomId);
        delete board.tasks[taskId];
        this._saveBoard(roomId, board);
        result = { ok: true, updated: true, closed: true, task };
        return;
      }

      // Save updated task
      writeJsonAtomic(taskFilePath(roomId, taskId), task, this.logger);

      // Update board
      const board = this.getBoard(roomId);
      board.tasks[taskId] = {
        status: task.status,
        assignee: task.assignee,
        summary: task.summary
      };
      this._saveBoard(roomId, board);

      result = { ok: true, updated: true, closed: false, task };
    }, this.logger);

    return result || { ok: false, reason: "lock_failed" };
  }

  /**
   * Build a task board summary for injection into agent context.
   */
  buildBoardContext(roomId, agentId) {
    const tasks = this.listActiveTasks(roomId);
    if (tasks.length === 0) return "";

    const lines = ["--- 任务看板 ---"];
    for (const task of tasks) {
      const lastRound = task.rounds?.[task.rounds.length - 1];
      const roundInfo = lastRound
        ? `round ${lastRound.round}, ${lastRound.agent}`
        : "no rounds";
      const isMyTask = task.assignee === agentId;
      const marker = isMyTask ? "👉 " : "";
      lines.push(
        `${marker}${task.taskId} [${task.status}] assignee=${task.assignee || "unassigned"} "${task.summary}" (${roundInfo})`
      );
    }
    return lines.join("\n");
  }

  /**
   * Get a snapshot for /teamroom tasks command.
   */
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
      const rounds = task.rounds?.length || 0;
      lines.push(
        `  ${task.taskId} [${task.status}] assignee=${task.assignee || "?"} rounds=${rounds} "${task.summary}"`
      );
    }
    return lines.join("\n");
  }
}
