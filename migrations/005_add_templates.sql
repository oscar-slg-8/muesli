CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  is_builtin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

ALTER TABLE meetings ADD COLUMN last_template_id INTEGER REFERENCES templates(id);
