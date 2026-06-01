-- Feature 4: Calendar-aware meeting pre-creation
ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT;
ALTER TABLE meetings ADD COLUMN attendees TEXT; -- JSON array of names
