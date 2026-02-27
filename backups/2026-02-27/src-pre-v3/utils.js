export function asString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

export function asArray(value) {
  if (!Array.isArray(value)) return [];
  return value;
}

export function clampInt(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = asString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function parseSingleTarget(rawValue) {
  const raw = asString(rawValue);
  if (!raw) return null;
  let lowered = raw.toLowerCase();
  let working = raw;
  let hasFeishuPrefix = false;

  if (lowered.startsWith("feishu:")) {
    working = raw.slice("feishu:".length).trim();
    lowered = working.toLowerCase();
    hasFeishuPrefix = true;
  } else if (lowered.startsWith("lark:")) {
    working = raw.slice("lark:".length).trim();
    lowered = working.toLowerCase();
    hasFeishuPrefix = true;
  }

  let id = working;
  let kind = "unknown";

  if (lowered.startsWith("user:")) {
    id = working.slice("user:".length).trim();
    kind = "user";
  } else if (lowered.startsWith("open_id:")) {
    id = working.slice("open_id:".length).trim();
    kind = "user";
  } else if (lowered.startsWith("chat:")) {
    id = working.slice("chat:".length).trim();
    kind = "group";
  } else if (lowered.startsWith("channel:")) {
    id = working.slice("channel:".length).trim();
    kind = "group";
  }

  if (kind === "unknown") {
    if (id.startsWith("ou_")) kind = "user";
    else if (id.startsWith("oc_")) kind = "group";
  }

  const likelyFeishu = hasFeishuPrefix || id.startsWith("ou_") || id.startsWith("oc_");
  return { raw, id, kind, likelyFeishu };
}

export function parseMessageParams(rawParams) {
  const params = asObject(rawParams);
  const targets = [];

  for (const key of ["target", "to", "channelId"]) {
    const parsed = parseSingleTarget(params[key]);
    if (parsed) targets.push(parsed);
  }
  for (const value of asArray(params.targets)) {
    const parsed = parseSingleTarget(value);
    if (parsed) targets.push(parsed);
  }

  const uniqueTargets = [];
  const seen = new Set();
  for (const target of targets) {
    const fingerprint = `${target.kind}:${target.id}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    uniqueTargets.push(target);
  }

  const action = asString(params.action).toLowerCase();
  const channel = asString(params.channel).toLowerCase();
  const text =
    asString(params.message) ||
    asString(params.text) ||
    asString(params.content) ||
    asString(params.caption);

  const allAreUsers = uniqueTargets.length > 0 && uniqueTargets.every((t) => t.kind === "user");
  const hasGroup = uniqueTargets.some((t) => t.kind === "group");
  const roomTarget = uniqueTargets.find((t) => t.kind === "group" && t.id.startsWith("oc_")) || null;
  const likelyFeishu =
    channel === "feishu" || uniqueTargets.some((t) => t.likelyFeishu) || roomTarget !== null;

  return {
    params,
    action,
    channel,
    targets: uniqueTargets,
    isDm: allAreUsers,
    hasGroup,
    roomId: roomTarget?.id ?? null,
    likelyFeishu,
    text
  };
}

export function isMessageSendLikeAction(action) {
  return (
    action === "send" ||
    action === "reply" ||
    action === "send_text" ||
    action === "send_media" ||
    action === "post"
  );
}

export function parseConversationId(ctxConversationId, metadata) {
  const direct = asString(ctxConversationId);
  const metaOrigin = asString(metadata?.originatingTo);
  const metaTo = asString(metadata?.to);
  const raw = direct || metaOrigin || metaTo;
  if (!raw) return "";
  if (raw.startsWith("chat:")) return raw.slice("chat:".length);
  if (raw.startsWith("channel:")) return raw.slice("channel:".length);
  return raw;
}

export function isLikelyGroupId(conversationId) {
  const id = asString(conversationId);
  return id.startsWith("oc_");
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textHash(input) {
  const text = asString(input);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return `${hash}`;
}

export function toIso(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toISOString();
  } catch {
    return "";
  }
}
