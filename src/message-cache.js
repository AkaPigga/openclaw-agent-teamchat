import { asString } from "./utils.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync
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
    if (logger) logger.warn(`[teamchat] cache lock timeout: ${lockPath}`);
    return false;
  }
  try {
    fn();
    return true;
  } catch (err) {
    if (logger) logger.warn(`[teamchat] cache locked op failed: ${String(err)}`);
    return false;
  } finally {
    try { closeSync(lockFd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

function sanitizeRoomId(roomId) {
  return asString(roomId).replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

function roomPath(roomId) {
  return join(ROOMS_DIR, sanitizeRoomId(roomId));
}

function messagesPath(roomId) {
  return join(roomPath(roomId), "messages.jsonl");
}

function watermarksPath(roomId) {
  return join(roomPath(roomId), "watermarks.json");
}

function lockPath(roomId, op) {
  return join(roomPath(roomId), `.${op || "cache"}.lock`);
}

function ensureRoomDir(roomId) {
  const dir = roomPath(roomId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonSafe(filePath, fallback, logger) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch (err) {
    if (logger && existsSync(filePath)) {
      logger.warn(`[teamchat] read json failed: ${filePath} err=${String(err)}`);
    }
  }
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

// ─── Message ID generation ───

let _seqCounter = 0;

function generateMessageId(ts) {
  _seqCounter = (_seqCounter + 1) % 100000;
  const stamp = String(ts || Date.now());
  const seq = String(_seqCounter).padStart(5, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `m_${stamp}_${seq}_${rand}`;
}

// ─── MessageCache class ───

export class MessageCache {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.maxMessages = options.maxMessages || 500;
    this.cleanupTtlMs = (options.cleanupTtlSeconds || 3600) * 1000;
    this.compactThreshold = options.compactThreshold || 200;
  }

  /**
   * Append a message to the room cache.
   * Returns the generated message record.
   */
  appendMessage(roomId, params) {
    if (!roomId) return null;
    ensureRoomDir(roomId);

    const rawContent = asString(params.content) || "";
    // Skip system/memory injection blocks — they are not real chat messages
    if (rawContent.includes("[UNTRUSTED DATA") || rawContent.includes("<relevant-memories>")) {
      return null;
    }

    const ts = Number(params.ts) || Date.now();
    const record = {
      id: asString(params.id) || generateMessageId(ts),
      ts,
      sender: asString(params.sender) || "unknown",
      senderId: asString(params.senderId) || "",
      sourceAgent: asString(params.sourceAgent) || "",
      content: asString(params.content) || "",
      mentions: Array.isArray(params.mentions) ? params.mentions.filter(Boolean) : [],
      type: asString(params.type) || "message"
    };

    const line = JSON.stringify(record) + "\n";
    const lp = lockPath(roomId, "write");

    withFileLock(lp, () => {
      appendFileSync(messagesPath(roomId), line, "utf8");
    }, this.logger);

    return record;
  }

  /**
   * Read all messages from the room cache.
   */
  readAllMessages(roomId) {
    const filePath = messagesPath(roomId);
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const messages = [];
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line));
        } catch {}
      }
      return messages;
    } catch (err) {
      if (this.logger) this.logger.warn(`[teamchat] read messages failed: ${filePath} err=${String(err)}`);
      return [];
    }
  }

  /**
   * Get unread messages for a specific agent.
   * Returns messages after the agent's watermark, excluding the agent's own messages.
   */
  getUnreadMessages(roomId, agentId) {
    if (!roomId || !agentId) return [];
    const allMessages = this.readAllMessages(roomId);
    const watermarks = this.getWatermarks(roomId);
    const agentWatermark = watermarks[agentId];
    const lastReadTs = agentWatermark?.lastReadTs || 0;
    const lastReadId = agentWatermark?.lastReadId || "";

    let startIdx = 0;
    if (lastReadId) {
      const idx = allMessages.findIndex((m) => m.id === lastReadId);
      if (idx >= 0) {
        startIdx = idx + 1;
      } else if (lastReadTs > 0) {
        // lastReadId not found (stale/legacy id) — fall back to ts-based boundary
        // Use strict > to avoid re-delivering messages at the exact watermark ts
        startIdx = allMessages.findIndex((m) => m.ts > lastReadTs);
        if (startIdx < 0) startIdx = allMessages.length;
      }
    } else if (lastReadTs > 0) {
      startIdx = allMessages.findIndex((m) => m.ts > lastReadTs);
      if (startIdx < 0) startIdx = allMessages.length;
    }

    return allMessages
      .slice(startIdx)
      .filter((m) => m.sourceAgent !== agentId);
  }

  /**
   * Build a context block from unread messages for injection into agent session.
   */
  buildContextBlock(roomId, agentId, options = {}) {
    const unread = this.getUnreadMessages(roomId, agentId);
    if (unread.length === 0) return "";

    const maxMessages = options.maxMessages || 50;
    const maxChars = options.maxChars || 8000;

    // Take last N by count first, then apply char budget from newest → oldest
    const candidates = unread.slice(-maxMessages);
    const selected = [];
    let charCount = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const line = candidates[i].content || "";
      if (charCount + line.length > maxChars) break;
      charCount += line.length;
      selected.unshift(candidates[i]);
    }

    const skipped = unread.length - selected.length;
    const lines = [`[teamroom-context room=${roomId} unread=${unread.length}${skipped > 0 ? ` skipped=${skipped}` : ""}]`];
    for (const msg of selected) {
      const d = new Date(msg.ts);
      const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const sender = msg.sourceAgent || msg.sender || "unknown";
      const prefix = msg.type === "task_update" ? "📋 " : "";
      lines.push(`[${time} ${sender}] ${prefix}${msg.content}`);
    }
    lines.push("[/teamroom-context]");
    return lines.join("\n");
  }

  /**
   * Mark messages as read for a specific agent (update watermark).
   */
  markAsRead(roomId, agentId, upToMessageId, upToTs) {
    if (!roomId || !agentId) return;
    const lp = lockPath(roomId, "watermark");
    withFileLock(lp, () => {
      const watermarks = this.getWatermarks(roomId);
      watermarks[agentId] = {
        lastReadId: asString(upToMessageId) || watermarks[agentId]?.lastReadId || "",
        lastReadTs: Number(upToTs) || Date.now()
      };
      writeJsonAtomic(watermarksPath(roomId), watermarks, this.logger);
    }, this.logger);
  }

  /**
   * Reset watermark for an agent to just before a specific message ts,
   * so that message appears as unread on next context build.
   */
  resetWatermarkBefore(roomId, agentId, beforeTs) {
    if (!roomId || !agentId) return;
    const lp = lockPath(roomId, "watermark");
    withFileLock(lp, () => {
      const watermarks = this.getWatermarks(roomId);
      watermarks[agentId] = {
        lastReadId: "",
        lastReadTs: Number(beforeTs) - 1
      };
      writeJsonAtomic(watermarksPath(roomId), watermarks, this.logger);
    }, this.logger);
  }

  /**
   * Mark all current messages as read for an agent.
   */
  markAllAsRead(roomId, agentId) {
    const allMessages = this.readAllMessages(roomId);
    if (allMessages.length === 0) return;
    const last = allMessages[allMessages.length - 1];
    this.markAsRead(roomId, agentId, last.id, last.ts);
  }

  /**
   * Get watermarks for all agents in a room.
   */
  getWatermarks(roomId) {
    return readJsonSafe(watermarksPath(roomId), {}, this.logger);
  }

  /**
   * Check if a message with the same content from the same source
   * already exists within a time window (dedup for echo detection).
   */
  hasRecentMessage(roomId, content, sourceAgent, windowMs) {
    if (!roomId || !content) return false;
    const allMessages = this.readAllMessages(roomId);
    const now = Date.now();
    const cutoff = now - (windowMs || 30000);
    const normalizedContent = asString(content);

    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msg = allMessages[i];
      if (msg.ts < cutoff) break;
      if (msg.content === normalizedContent) {
        if (!sourceAgent || msg.sourceAgent === sourceAgent) return true;
      }
    }
    return false;
  }

  /**
   * Cleanup: remove messages that all agents have read and are older than TTL.
   */
  cleanup(roomId, memberAgents) {
    if (!roomId || !memberAgents || memberAgents.length === 0) return;
    const allMessages = this.readAllMessages(roomId);
    if (allMessages.length < this.compactThreshold) return;

    const watermarks = this.getWatermarks(roomId);
    const now = Date.now();

    // Find the minimum watermark across all member agents
    let minReadTs = Infinity;
    for (const agentId of memberAgents) {
      const wm = watermarks[agentId];
      if (!wm || !wm.lastReadTs) {
        minReadTs = 0;
        break;
      }
      if (wm.lastReadTs < minReadTs) minReadTs = wm.lastReadTs;
    }

    if (minReadTs === 0 || minReadTs === Infinity) return;

    // Keep messages that are either:
    // 1. Not yet read by all agents (ts > minReadTs), OR
    // 2. Within the TTL window
    const cutoff = now - this.cleanupTtlMs;
    const keepThreshold = Math.max(minReadTs, cutoff);

    const kept = allMessages.filter((m) => m.ts > keepThreshold);
    if (kept.length === allMessages.length) return;

    const lp = lockPath(roomId, "compact");
    withFileLock(lp, () => {
      const content = kept.map((m) => JSON.stringify(m)).join("\n") + (kept.length > 0 ? "\n" : "");
      writeFileSync(messagesPath(roomId), content, "utf8");
    }, this.logger);

    if (this.logger) {
      this.logger.info(
        `[teamchat] cache cleanup room=${roomId}: ${allMessages.length} → ${kept.length} messages`
      );
    }
  }

  /**
   * Get a snapshot of the cache state for a room (for /teamroom status).
   */
  snapshot(roomId, memberAgents) {
    const allMessages = this.readAllMessages(roomId);
    const watermarks = this.getWatermarks(roomId);
    const lines = [`messages=${allMessages.length}`];
    for (const agentId of (memberAgents || [])) {
      const wm = watermarks[agentId];
      const unreadCount = this.getUnreadMessages(roomId, agentId).length;
      lines.push(`  ${agentId}: unread=${unreadCount} lastRead=${wm?.lastReadId || "none"}`);
    }
    return lines.join("\n");
  }
}
