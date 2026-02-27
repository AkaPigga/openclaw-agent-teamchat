import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MessageCache } from "../src/message-cache.js";
import { TaskBoard } from "../src/task-board.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TEST_ROOM = "oc_test_v2_room";
const ROOMS_DIR = join(homedir(), ".openclaw", "plugin-data", "agent-teamchat", "rooms");

function cleanTestRoom() {
  const dir = join(ROOMS_DIR, TEST_ROOM);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ─── MessageCache tests ───

test("MessageCache: append and read messages", () => {
  cleanTestRoom();
  const cache = new MessageCache();

  const msg1 = cache.appendMessage(TEST_ROOM, {
    sender: "Finley",
    senderId: "ou_user1",
    content: "请builder看看",
    mentions: ["builder"]
  });
  const msg2 = cache.appendMessage(TEST_ROOM, {
    sender: "builder",
    senderId: "ou_builder",
    sourceAgent: "builder",
    content: "收到，马上看",
    mentions: []
  });

  assert.ok(msg1.id);
  assert.ok(msg2.id);

  const all = cache.readAllMessages(TEST_ROOM);
  assert.equal(all.length, 2);
  assert.equal(all[0].content, "请builder看看");
  assert.equal(all[1].sourceAgent, "builder");
  cleanTestRoom();
});

test("MessageCache: getUnreadMessages respects watermark", () => {
  cleanTestRoom();
  const cache = new MessageCache();

  const msg1 = cache.appendMessage(TEST_ROOM, {
    sender: "Finley", content: "消息1", ts: 1000
  });
  const msg2 = cache.appendMessage(TEST_ROOM, {
    sender: "Finley", content: "消息2", ts: 2000
  });
  const msg3 = cache.appendMessage(TEST_ROOM, {
    sender: "Finley", content: "消息3", ts: 3000
  });

  let unread = cache.getUnreadMessages(TEST_ROOM, "builder");
  assert.equal(unread.length, 3);

  cache.markAsRead(TEST_ROOM, "builder", msg2.id, msg2.ts);

  unread = cache.getUnreadMessages(TEST_ROOM, "builder");
  assert.equal(unread.length, 1);
  assert.equal(unread[0].content, "消息3");
  cleanTestRoom();
});

test("MessageCache: agent's own messages are excluded from unread", () => {
  cleanTestRoom();
  const cache = new MessageCache();

  cache.appendMessage(TEST_ROOM, {
    sender: "Finley", content: "你好builder", ts: 1000
  });
  cache.appendMessage(TEST_ROOM, {
    sender: "builder", sourceAgent: "builder", content: "收到", ts: 2000
  });
  cache.appendMessage(TEST_ROOM, {
    sender: "Finley", content: "再看看这个", ts: 3000
  });

  const unread = cache.getUnreadMessages(TEST_ROOM, "builder");
  assert.equal(unread.length, 2);
  assert.ok(unread.every((m) => m.sourceAgent !== "builder"));
  cleanTestRoom();
});

test("MessageCache: buildContextBlock formats correctly", () => {
  cleanTestRoom();
  const cache = new MessageCache();

  cache.appendMessage(TEST_ROOM, {
    sender: "Finley", content: "请builder看看", ts: 1740000000000
  });
  cache.appendMessage(TEST_ROOM, {
    sender: "researcher", sourceAgent: "researcher", content: "我看了一下", ts: 1740000060000
  });

  const ctx = cache.buildContextBlock(TEST_ROOM, "builder");
  assert.ok(ctx.includes("[teamroom-context"));
  assert.ok(ctx.includes("请builder看看"));
  assert.ok(ctx.includes("我看了一下"));
  assert.ok(ctx.includes("[/teamroom-context]"));
  cleanTestRoom();
});

test("MessageCache: hasRecentMessage detects duplicates", () => {
  cleanTestRoom();
  const cache = new MessageCache();

  cache.appendMessage(TEST_ROOM, {
    sender: "builder", sourceAgent: "builder", content: "测试消息", ts: Date.now()
  });

  assert.equal(cache.hasRecentMessage(TEST_ROOM, "测试消息", "builder", 5000), true);
  assert.equal(cache.hasRecentMessage(TEST_ROOM, "不同消息", "builder", 5000), false);
  cleanTestRoom();
});

test("MessageCache: cleanup removes fully-read old messages", () => {
  cleanTestRoom();
  const cache = new MessageCache({ compactThreshold: 3, cleanupTtlSeconds: 0 });

  const now = Date.now();
  cache.appendMessage(TEST_ROOM, { sender: "A", content: "old1", ts: now - 10000 });
  cache.appendMessage(TEST_ROOM, { sender: "A", content: "old2", ts: now - 9000 });
  cache.appendMessage(TEST_ROOM, { sender: "A", content: "new1", ts: now - 1000 });
  cache.appendMessage(TEST_ROOM, { sender: "A", content: "new2", ts: now });

  cache.markAsRead(TEST_ROOM, "builder", null, now - 8000);
  cache.markAsRead(TEST_ROOM, "researcher", null, now - 8000);

  cache.cleanup(TEST_ROOM, ["builder", "researcher"]);

  const remaining = cache.readAllMessages(TEST_ROOM);
  assert.ok(remaining.length <= 3);
  assert.ok(remaining.some((m) => m.content === "new1"));
  assert.ok(remaining.some((m) => m.content === "new2"));
  cleanTestRoom();
});

// ─── TaskBoard v3 tests (slots mode) ───

test("TaskBoard v3: create task initializes slots for creator", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  const result = board.createTask(TEST_ROOM, {
    taskId: "TASK-001",
    summary: "修复P0 bug",
    createdBy: "main",
    note: "紧急修复"
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.task.taskId, "TASK-001");
  assert.ok(result.task.slots);
  // creator does not get a slot — slots are populated when agents signal
  assert.equal(Object.keys(result.task.slots).length, 0);
  assert.ok(result.task.globalHistory);
  assert.equal(result.task.globalHistory.length, 1);
  assert.equal(result.task.globalHistory[0].actor, "main");

  const task = board.getTask(TEST_ROOM, "TASK-001");
  assert.ok(task);
  assert.equal(task.summary, "修复P0 bug");
  cleanTestRoom();
});

test("TaskBoard v3: updateTask writes into actor slot", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "测试", createdBy: "main" });

  const result = board.updateTask(TEST_ROOM, {
    taskId: "T-1",
    status: "in_progress",
    actor: "builder",
    note: "开始工作"
  });

  assert.equal(result.ok, true);
  const task = result.task;
  assert.ok(task.slots["builder"]);
  assert.equal(task.slots["builder"].status, "in_progress");
  assert.equal(task.slots["builder"].rounds, 1);
  assert.equal(task.slots["builder"].lastNote, "开始工作");
  assert.equal(task.globalHistory.length, 2); // create + in_progress
  cleanTestRoom();
});

test("TaskBoard v3: multiple agents write independent slots", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "并行任务", createdBy: "main" });

  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "in_progress", actor: "builder", note: "实现中" });
  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "done", actor: "researcher", note: "调研完成" });

  const task = board.getTask(TEST_ROOM, "T-1");
  assert.ok(task.slots["builder"]);
  assert.ok(task.slots["researcher"]);
  assert.equal(task.slots["builder"].status, "in_progress");
  assert.equal(task.slots["researcher"].status, "done");
  // overall status: not all done (builder still in_progress) → in_progress
  assert.equal(task.status, "in_progress");
  cleanTestRoom();
});

test("TaskBoard v3: task closes when all slots are done", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "协作任务", createdBy: "main" });
  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "in_progress", actor: "builder", note: "开始" });
  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "done", actor: "researcher", note: "完成" });

  // builder also done → all slots done → task closes
  const result = board.updateTask(TEST_ROOM, {
    taskId: "T-1",
    status: "done",
    actor: "builder",
    note: "完成了"
  });

  assert.equal(result.ok, true);
  assert.equal(result.closed, true);

  const active = board.listActiveTasks(TEST_ROOM);
  assert.equal(active.length, 0);

  const boardData = board.getBoard(TEST_ROOM);
  assert.equal(boardData.tasks["T-1"], undefined);
  cleanTestRoom();
});

test("TaskBoard v3: blocked slot makes overall status blocked", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "测试", createdBy: "main" });
  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "in_progress", actor: "builder", note: "" });
  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "blocked", actor: "researcher", note: "等待依赖" });

  const task = board.getTask(TEST_ROOM, "T-1");
  assert.equal(task.status, "blocked");
  cleanTestRoom();
});

test("TaskBoard v3: multiple active tasks", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "任务1", createdBy: "main" });
  board.createTask(TEST_ROOM, { taskId: "T-2", summary: "任务2", createdBy: "main" });

  const active = board.listActiveTasks(TEST_ROOM);
  assert.equal(active.length, 2);

  const boardData = board.getBoard(TEST_ROOM);
  assert.ok(boardData.tasks["T-1"]);
  assert.ok(boardData.tasks["T-2"]);
  cleanTestRoom();
});

test("TaskBoard v3: max active tasks limit", () => {
  cleanTestRoom();
  const board = new TaskBoard({ maxActiveTasks: 2 });

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "1", createdBy: "main" });
  board.createTask(TEST_ROOM, { taskId: "T-2", summary: "2", createdBy: "main" });
  const result = board.createTask(TEST_ROOM, { taskId: "T-3", summary: "3", createdBy: "main" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "max_active_reached");
  cleanTestRoom();
});

test("TaskBoard v3: duplicate task creation blocked", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "1", createdBy: "main" });
  const result = board.createTask(TEST_ROOM, { taskId: "T-1", summary: "dup", createdBy: "main" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "already_exists");
  cleanTestRoom();
});

test("TaskBoard v3: buildBoardContext shows slots per agent", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "协作任务", createdBy: "main" });
  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "in_progress", actor: "builder", note: "实现中" });
  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "done", actor: "researcher", note: "调研完成" });

  const ctx = board.buildBoardContext(TEST_ROOM, "builder");
  assert.ok(ctx.includes("[task-board]"));
  assert.ok(ctx.includes("T-1"));
  assert.ok(ctx.includes("👉 builder")); // my slot marker
  assert.ok(ctx.includes("researcher"));
  assert.ok(ctx.includes("[/task-board]"));
  cleanTestRoom();
});

test("TaskBoard v3: snapshot shows slot summary", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  board.createTask(TEST_ROOM, { taskId: "T-1", summary: "测试", createdBy: "main" });
  board.updateTask(TEST_ROOM, { taskId: "T-1", status: "in_progress", actor: "builder", note: "" });

  const snap = board.snapshot(TEST_ROOM);
  assert.ok(snap.includes("active=1"));
  assert.ok(snap.includes("T-1"));
  assert.ok(snap.includes("builder"));
  cleanTestRoom();
});

test("TaskBoard v3: legacy task migration (no slots)", () => {
  cleanTestRoom();
  const board = new TaskBoard();

  // Manually write a legacy-format task
  const dir = join(homedir(), ".openclaw", "plugin-data", "agent-teamchat", "rooms", TEST_ROOM, "tasks", "active");
  mkdirSync(dir, { recursive: true });
  const legacyTask = {
    taskId: "LEGACY-1",
    summary: "旧格式任务",
    status: "in_progress",
    assignee: "builder",
    owner: "builder",
    createdBy: "main",
    createdAt: Date.now() - 10000,
    updatedAt: Date.now(),
    closedAt: 0,
    rounds: [{ round: 1, agent: "builder", status: "ack", startedAt: Date.now() - 10000 }],
    history: [{ status: "ack", actor: "builder", note: "收到", at: Date.now() - 10000 }]
  };
  writeFileSync(join(dir, "LEGACY-1.json"), JSON.stringify(legacyTask), "utf8");

  const task = board.getTask(TEST_ROOM, "LEGACY-1");
  assert.ok(task);
  assert.ok(task.slots, "migrated task should have slots");
  assert.ok(task.slots["builder"], "builder slot should exist after migration");
  assert.ok(task.globalHistory, "migrated task should have globalHistory");
  cleanTestRoom();
});
