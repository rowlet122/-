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
