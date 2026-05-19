CREATE TABLE IF NOT EXISTS entries (
  al_id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  comparison TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  theoretical_best TEXT NOT NULL DEFAULT '',
  incomplete INTEGER NOT NULL DEFAULT 0,
  source_created_at TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  mirrored_at TEXT NOT NULL,
  torrent_count INTEGER NOT NULL DEFAULT 0,
  best_torrent_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_entries_source_updated_at
  ON entries(source_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_torrent_count
  ON entries(torrent_count DESC, best_torrent_count DESC);

CREATE TABLE IF NOT EXISTS torrents (
  mirror_key TEXT PRIMARY KEY,
  source_torrent_id TEXT NOT NULL,
  entry_al_id INTEGER NOT NULL,
  release_group TEXT NOT NULL DEFAULT '',
  tracker TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  resolved_url TEXT NOT NULL DEFAULT '',
  source_grouped_url TEXT NOT NULL DEFAULT '',
  resolved_grouped_url TEXT NOT NULL DEFAULT '',
  info_hash TEXT NOT NULL DEFAULT '',
  dual_audio INTEGER NOT NULL DEFAULT 0,
  is_best INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  files_json TEXT NOT NULL DEFAULT '[]',
  source_created_at TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  mirrored_at TEXT NOT NULL,
  FOREIGN KEY (entry_al_id) REFERENCES entries(al_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_torrents_entry_al_id
  ON torrents(entry_al_id, is_best DESC, release_group);

CREATE UNIQUE INDEX IF NOT EXISTS idx_torrents_entry_source_id
  ON torrents(entry_al_id, source_torrent_id);

CREATE INDEX IF NOT EXISTS idx_torrents_resolved_url
  ON torrents(resolved_url);

CREATE TABLE IF NOT EXISTS anilist_media (
  id INTEGER PRIMARY KEY,
  title_user_preferred TEXT NOT NULL DEFAULT '',
  title_english TEXT NOT NULL DEFAULT '',
  cover_image_extra_large TEXT NOT NULL DEFAULT '',
  cover_image_color TEXT NOT NULL DEFAULT '',
  season TEXT NOT NULL DEFAULT '',
  season_year INTEGER,
  start_year INTEGER,
  format TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  episodes INTEGER,
  duration INTEGER,
  average_score INTEGER,
  genres_json TEXT NOT NULL DEFAULT '[]',
  relations_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_anilist_start_year
  ON anilist_media(start_year DESC, season_year DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
