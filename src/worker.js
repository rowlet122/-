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
  // Same person often opens the app from two separate browser contexts (e.g. a
  // LINE in-app browser and Safari), which look like two different devices —
  // each has its own isolated localStorage/token. Don't permanently lock them
  // out of their own name; just require an explicit confirmation (force) to
  // take over a name already claimed by a different device.
  if (existing && existing.token !== token && !body.force) {
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

async function getConfig(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM config WHERE key IN ('period','holidays')").all();
  const map = {};
  for (const r of results) {
    try {
      map[r.key] = JSON.parse(r.value);
    } catch (e) {
      /* ignore corrupt row */
    }
  }
  return {
    period: map.period || { start: "2026-10-01", end: "2027-03-31", label: "2026年度後期" },
    holidays: map.holidays || {},
  };
}

async function handleConfig(env) {
  const cfg = await getConfig(env);
  return json(cfg);
}

function isAdmin(req, env) {
  const given = req.headers.get("x-admin-password") || "";
  return !!env.ADMIN_PASSWORD && given === env.ADMIN_PASSWORD;
}

async function handleAdminPeriod(req, env) {
  if (!isAdmin(req, env)) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => ({}));
  const { start, end, label } = body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return json({ error: "bad_date" }, 400);
  }
  const period = { start, end, label: label || "" };
  await env.DB.prepare(
    "INSERT INTO config (key, value) VALUES ('period', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(JSON.stringify(period))
    .run();
  return json({ ok: true, period });
}

async function handleAdminHolidays(req, env) {
  if (!isAdmin(req, env)) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => ({}));
  const holidays = body.holidays && typeof body.holidays === "object" ? body.holidays : {};
  await env.DB.prepare(
    "INSERT INTO config (key, value) VALUES ('holidays', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(JSON.stringify(holidays))
    .run();
  return json({ ok: true, holidays });
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
  const cfg = await getConfig(env);
  return json({ days, claimed, members: MEMBERS, period: cfg.period, holidays: cfg.holidays });
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

// ---------- notifications (LINE Messaging API or a generic/Discord/Slack webhook) ----------
async function sendNotification(env, text) {
  try {
    if (env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_TARGET_ID) {
      await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN,
        },
        body: JSON.stringify({ to: env.LINE_TARGET_ID, messages: [{ type: "text", text }] }),
      });
      return;
    }
    if (env.NOTIFY_WEBHOOK_URL) {
      const isDiscord = env.NOTIFY_WEBHOOK_URL.includes("discord.com");
      const body = isDiscord ? { content: text } : { text, content: text };
      await fetch(env.NOTIFY_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  } catch (e) {
    console.error("notify failed", e);
  }
}

async function handleDayOp(req, env, date) {
  const { memberId } = await getAuthMemberId(req, env);
  const body = await req.json().catch(() => ({}));
  const op = body.op;
  if (!memberId) return json({ error: "not_logged_in" }, 401);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad_date" }, 400);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, version } = await loadDay(env, date);
    const result = applyOp(data, op, memberId, body);
    if (result.error) return json({ error: result.error }, 409);
    const ok = await saveDay(env, date, data, version);
    if (ok) {
      if (op === "request") {
        const slotKey = body.slot;
        const occupant = data[slotKey];
        if (occupant) {
          const md = date.slice(5).replace("-", "/");
          const text =
            "🔄 " +
            md +
            "の交代リクエスト: " +
            memberName(memberId) +
            "さん → " +
            (occupant.name || memberName(occupant.memberId)) +
            "さんへ。アプリで承認/却下してください。";
          sendNotification(env, text);
        }
      }
      return json({ ok: true, day: data });
    }
    // version conflict: retry
  }
  return json({ error: "busy" }, 409);
}

// ---------- scheduled reminders (cron) ----------
function jstDateStr(offsetDays) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function runReminder(cronExpr, env) {
  const isMorningCheck = cronExpr === "0 22 * * *"; // 07:00 JST — check today
  const targetDate = isMorningCheck ? jstDateStr(0) : jstDateStr(1); // evening cron checks tomorrow
  const dow = new Date(targetDate + "T00:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6) return; // weekend, nothing scheduled

  const row = await env.DB.prepare("SELECT data FROM days WHERE date = ?").bind(targetDate).first();
  let data = {};
  if (row) {
    try {
      data = JSON.parse(row.data);
    } catch (e) {
      /* ignore */
    }
  }
  const names = [];
  for (const key of ["slot1", "slot2"]) {
    const s = data[key];
    if (s && s.memberId && s.status !== "absent") names.push(s.name || memberName(s.memberId));
  }
  if (names.length >= 2) return; // fully staffed already

  const label = isMorningCheck ? "本日" : "明日";
  const md = targetDate.slice(5).replace("-", "/");
  const text =
    names.length === 0
      ? "🧹 " + label + "(" + md + ")の掃除当番がまだ誰も登録されていません。参加できる人はアプリから登録してください。"
      : "🧹 " + label + "(" + md + ")の掃除当番は" + names[0] + "さんのみです。もう1人募集中です。";
  await sendNotification(env, text);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/me" && req.method === "GET") return handleMe(req, env);
    if (path === "/api/claim" && req.method === "POST") return handleClaim(req, env);
    if (path === "/api/release" && req.method === "POST") return handleRelease(req, env);
    if (path === "/api/state" && req.method === "GET") return handleState(env);
    if (path === "/api/config" && req.method === "GET") return handleConfig(env);
    if (path === "/api/admin/period" && req.method === "POST") return handleAdminPeriod(req, env);
    if (path === "/api/admin/holidays" && req.method === "POST") return handleAdminHolidays(req, env);

    const dayMatch = path.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (dayMatch && req.method === "POST") return handleDayOp(req, env, dayMatch[1]);

    if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);

    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminder(event.cron, env));
  },
};
