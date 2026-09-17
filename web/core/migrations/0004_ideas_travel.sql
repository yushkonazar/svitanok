-- release-phase: expand
-- Кеш закладів, ідеї, бажання, ціни, поїздки.

CREATE TABLE places (
  place_id     TEXT PRIMARY KEY,
  name         TEXT,
  address      TEXT,
  lat          REAL,
  lon          REAL,
  phone        TEXT,
  site         TEXT,
  hours_json   TEXT,
  maps_uri     TEXT,
  rating_owner INTEGER,
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  visits       INTEGER NOT NULL DEFAULT 0,
  fetched_at   TEXT
);
CREATE INDEX idx_places_name ON places (name);

CREATE TABLE ideas (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  body_md           TEXT,
  domain            TEXT, -- svitanok·робота·побут·бізнес·інше
  status            TEXT NOT NULL DEFAULT 'нова', -- нова·в аналізі·план готовий·погоджено·у роботі·зроблено·відкладено·відхилено
  priority          INTEGER, -- 1-3
  effort            TEXT, -- S·M·L
  next_action       TEXT,
  tags_json         TEXT,
  analysis_md       TEXT,
  plan_md           TEXT,
  plan_approved_at  TEXT,
  repo              TEXT,
  head_sha          TEXT,
  artifact_drive_id TEXT,
  source_msg_id     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_ideas_status ON ideas (status);
CREATE INDEX idx_ideas_domain ON ideas (domain);

CREATE TABLE idea_events (
  id      TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL, -- created·analysis·plan·edit·status
  note    TEXT
);
CREATE INDEX idx_idea_events_idea_at ON idea_events (idea_id, at);

CREATE TABLE wishes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL, -- game·trip·purchase
  title        TEXT NOT NULL,
  payload_json TEXT,
  status       TEXT NOT NULL DEFAULT 'active', -- active·done·cancelled
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_wishes_type_status ON wishes (type, status);

CREATE TABLE price_points (
  id       TEXT PRIMARY KEY,
  wish_id  TEXT NOT NULL,
  at       TEXT NOT NULL,
  source   TEXT,
  price    INTEGER,
  currency TEXT,
  url      TEXT,
  is_low   INTEGER
);
CREATE INDEX idx_price_points_wish_at ON price_points (wish_id, at);

CREATE TABLE trips (
  id                   TEXT PRIMARY KEY,
  wish_id              TEXT,
  from_city            TEXT,
  to_text              TEXT,
  country              TEXT,
  date_from            TEXT,
  date_to              TEXT,
  mode                 TEXT, -- car·bus·train·plane
  vehicle_key          TEXT, -- facts.vehicle
  checklist_key        TEXT, -- ua-car·abroad-plane-bus·ua-train-bus·abroad-car
  cost_json            TEXT,
  checklist_state_json TEXT,
  workflow_id          TEXT,
  status               TEXT
);
CREATE INDEX idx_trips_date_from ON trips (date_from);
