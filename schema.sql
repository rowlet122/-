-- Device <-> member binding (no external account needed, just a name picked once per device)
CREATE TABLE IF NOT EXISTS devices (
  token TEXT PRIMARY KEY,
  member_id TEXT,
  created_at TEXT NOT NULL
);

-- Which device currently holds each of the 10 fixed member names
CREATE TABLE IF NOT EXISTS claims (
  member_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

-- One row per weekday date; `data` is a JSON blob holding slots/requests/checklist
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

-- App-wide settings (active term period, holiday list) editable from the admin screen
-- without a redeploy — this is what lets the next term be set up as a simple form entry.
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO config (key, value) VALUES (
  'period',
  '{"start":"2026-10-01","end":"2027-03-31","label":"2026年度後期"}'
);

INSERT OR IGNORE INTO config (key, value) VALUES (
  'holidays',
  '{"2026-10-12":"スポーツの日","2026-11-03":"文化の日","2026-11-23":"勤労感謝の日","2027-01-01":"元日","2027-01-11":"成人の日","2027-02-11":"建国記念の日","2027-02-23":"天皇誕生日","2027-03-21":"春分の日","2027-03-22":"振替休日"}'
);

-- Web Push subscriptions (one row per device that allowed notifications)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  member_id TEXT,
  created_at TEXT NOT NULL
);
