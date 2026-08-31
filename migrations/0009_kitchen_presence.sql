ALTER TABLE devices
  ADD COLUMN kitchen_away INTEGER NOT NULL DEFAULT 0 CHECK (kitchen_away IN (0, 1));

ALTER TABLE devices
  ADD COLUMN kitchen_away_updated_at TEXT;
