// Lab cleaning roster API — Cloudflare Worker + D1
// No external account needed: a device picks one of the 10 fixed names once,
// gets a random bearer token back, and keeps it in localStorage from then on.

const MEMBERS = [
  { id: "takai", name: "高井" },
  { id: "yamamoto", name: "山本" },
  { id: "takahashi", name: "高橋" },
  { id: "kakihara", name: "柿原" },
  { id: "sao", name: "竿" },
  { id: "seyama", name: "瀬山" },
  { id: "yuki", name: "優希" },
  { id: "masaya", name: "まさや" },
  { id: "koike", name: "小池" },
  { id: "tsunoda", name: "角田" },
];
const MEMBER_IDS = new Set(MEMBERS.map((m) => m.id));
function memberName(id) {
  const m = MEMBERS.find((x) => x.id === id);
  return m ? m.name : id;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function getAuthMemberId(req, env) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { token: "", memberId: null };
  const row = await env.DB.prepare("SELECT member_id FROM devices WHERE token = ?")
    .bind(token)
    .first();
  return { token, memberId: row ? row.member_id : null };
}

async function ensureDevice(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare("SELECT token FROM devices WHERE token = ?").bind(token).first();
  if (!row) return null;
  return token;
}

function newToken() {
  return crypto.randomUUID();
}

async function handleMe(req, env) {
  const { memberId } = await getAuthMemberId(req, env);
  return json({ memberId: memberId || null });
}

async function handleClaim(req, env) {
  const body = await req.json().catch(() => ({}));
  const memberId = body.memberId;
  if (!MEMBER_IDS.has(memberId)) return json({ error: "invalid_member" }, 400);

  let { token } = await getAuthMemberId(req, env);
  const now = new Date().toISOString();
  if (!token || !(await ensureDevice(env, token))) {
    token = newToken();
    await env.DB.prepare("INSERT INTO devices (token, member_id, created_at) VALUES (?, NULL, ?)")
      .bind(token, now)
      .run();
  }

  const existing = await env.DB.prepare("SELECT token FROM claims WHERE member_id = ?")
    .bind(memberId)
    .first();
  if (existing && existing.token !== token) {
    return json({ error: "already_claimed" }, 409);
  }

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO claims (member_id, token, claimed_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(member_id) DO UPDATE SET token = excluded.token, claimed_at = excluded.claimed_at"
    ).bind(memberId, token, now),
    env.DB.prepare("UPDATE devices SET member_id = ? WHERE token = ?").bind(memberId, token),
  ]);

  return json({ token, memberId });
}

async function handleRelease(req, env) {
  const { token, memberId } = await getAuthMemberId(req, env);
  if (!token || !memberId) return json({ error: "not_logged_in" }, 400);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM claims WHERE member_id = ? AND token = ?").bind(memberId, token),
    env.DB.prepare("UPDATE devices SET member_id = NULL WHERE token = ?").bind(token),
  ]);
  return json({ ok: true });
}

async function handleState(env) {
  const [{ results: dayRows }, { results: claimRows }] = await Promise.all([
    env.DB.prepare("SELECT date, data FROM days").all(),
    env.DB.prepare("SELECT member_id FROM claims").all(),
  ]);
  const days = {};
  for (const r of dayRows) {
    try {
      days[r.date] = JSON.parse(r.data);
    } catch (e) {
      /* skip corrupt row */
    }
  }
  const claimed = claimRows.map((r) => r.member_id);
  return json({ days, claimed, members: MEMBERS });
}

async function loadDay(env, date) {
  const row = await env.DB.prepare("SELECT data, version FROM days WHERE date = ?").bind(date).first();
  if (!row) return { data: {}, version: -1 };
  let data = {};
  try {
    data = JSON.parse(row.data);
  } catch (e) {
    data = {};
  }
  return { data, version: row.version };
}

async function saveDay(env, date, data, expectedVersion) {
  const serialized = JSON.stringify(data);
  if (expectedVersion === -1) {
    const res = await env.DB.prepare(
      "INSERT INTO days (date, data, version) VALUES (?, ?, 0) ON CONFLICT(date) DO NOTHING"
    )
      .bind(date, serialized)
      .run();
    return res.meta.changes > 0;
  }
  const res = await env.DB.prepare(
    "UPDATE days SET data = ?, version = version + 1 WHERE date = ? AND version = ?"
  )
    .bind(serialized, date, expectedVersion)
    .run();
  return res.meta.changes > 0;
}

function emptySlot() {
  return null;
}

function applyOp(data, op, memberId, payload) {
  data.slot1 = data.slot1 || emptySlot();
  data.slot2 = data.slot2 || emptySlot();
  data.req1 = data.req1 || [];
  data.req2 = data.req2 || [];
  data.checklist = data.checklist || {};

  const result = { error: null };
  const slotKey = payload.slot;
  const reqKey = slotKey === "slot1" ? "req1" : "req2";
  const otherKey = slotKey === "slot1" ? "slot2" : "slot1";

  switch (op) {
    case "join": {
      if (data[otherKey] && data[otherKey].memberId === memberId && data[otherKey].status !== "absent") {
        result.error = "同じ日に2枠は登録できません";
        break;
      }
      if (data[slotKey] && data[slotKey].memberId && data[slotKey].status !== "absent") {
        result.error = "すでに埋まっています";
        break;
      }
      data[slotKey] = { memberId, name: memberName(memberId), status: "active" };
      data[reqKey] = [];
      break;
    }
    case "leave": {
      if (!data[slotKey] || data[slotKey].memberId !== memberId) {
        result.error = "すでに変更されています";
        break;
      }
      data[slotKey] = null;
      break;
    }
    case "absent": {
      if (!data[slotKey] || !data[slotKey].memberId) {
        result.error = "対象がありません";
        break;
      }
      data[slotKey].status = data[slotKey].status === "absent" ? "active" : "absent";
      break;
    }
    case "request": {
      const list = data[reqKey];
      if (list.some((r) => r.memberId === memberId)) {
        result.error = "送信済みです";
        break;
      }
      list.push({ memberId, name: memberName(memberId), at: new Date().toISOString() });
      break;
    }
    case "approve": {
      if (!data[slotKey] || data[slotKey].memberId !== memberId) {
        result.error = "操作できません";
        break;
      }
      const target = payload.targetMemberId;
      data[slotKey] = { memberId: target, name: memberName(target), status: "active" };
      data[reqKey] = [];
      break;
    }
    case "decline": {
      data[reqKey] = data[reqKey].filter((r) => r.memberId !== payload.targetMemberId);
      break;
    }
    case "task": {
      const done = !!payload.done;
      data.checklist[payload.taskId] = done
        ? { done: true, by: memberName(memberId), at: new Date().toISOString() }
        : { done: false };
      break;
    }
    case "taskAll": {
      const done = !!payload.done;
      for (const id of payload.taskIds || []) {
        data.checklist[id] = done
          ? { done: true, by: memberName(memberId), at: new Date().toISOString() }
          : { done: false };
      }
      break;
    }
    default:
      result.error = "unknown_op";
  }
  return result;
}

async function handleDayOp(req, env, date) {
  const { memberId } = await getAuthMemberId(req, env);
  const body = await req.json().catch(() => ({}));
  const op = body.op;
  const needsAuth = op !== undefined && op !== "task" ? true : true; // every mutating op needs a logged-in member
  if (needsAuth && !memberId) return json({ error: "not_logged_in" }, 401);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad_date" }, 400);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, version } = await loadDay(env, date);
    const result = applyOp(data, op, memberId, body);
    if (result.error) return json({ error: result.error }, 409);
    const ok = await saveDay(env, date, data, version);
    if (ok) return json({ ok: true, day: data });
    // version conflict: retry
  }
  return json({ error: "busy" }, 409);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/me" && req.method === "GET") return handleMe(req, env);
    if (path === "/api/claim" && req.method === "POST") return handleClaim(req, env);
    if (path === "/api/release" && req.method === "POST") return handleRelease(req, env);
    if (path === "/api/state" && req.method === "GET") return handleState(env);

    const dayMatch = path.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (dayMatch && req.method === "POST") return handleDayOp(req, env, dayMatch[1]);

    if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);

    return env.ASSETS.fetch(req);
  },
};
