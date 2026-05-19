# Mirror model

This mirror now treats the public SeaDex PocketBase API as the source of truth and rebuilds D1 from a verified snapshot.

## Live public endpoints

Observed from the live site and the saved HAR:

- `GET /api/listIDs`
- `GET /api/collections/entries/records?...&expand=trs`
- AniList GraphQL for title, cover, format, score, and relations

## What we learned from the source audit

- The public `entries` endpoint currently returns `2661` unique SeaDex entries.
- Every live entry currently expands to torrent rows through `expand=trs`.
- Some torrent URLs are absolute public links such as Nyaa.
- Some torrent URLs are relative private-tracker paths such as `/torrents.php?...`.
- Those relative paths must be resolved against `https://releases.moe` or links appear broken.

## D1 tables

### `entries`

One row per SeaDex entry.

Stored fields include:

- `al_id`
- `record_id`
- `comparison`
- `notes`
- `theoretical_best`
- `incomplete`
- `source_created_at`
- `source_updated_at`
- `mirrored_at`
- `torrent_count`
- `best_torrent_count`
- `raw_json`

### `torrents`

One row per expanded torrent record.

Stored fields include:

- `id`
- `entry_al_id`
- `release_group`
- `tracker`
- `source_url`
- `resolved_url`
- `source_grouped_url`
- `resolved_grouped_url`
- `info_hash`
- `dual_audio`
- `is_best`
- `tags_json`
- `files_json`
- `source_created_at`
- `source_updated_at`
- `mirrored_at`
- `raw_json`

### `anilist_media`

Cached AniList metadata for mirrored SeaDex entries only.

Stored fields include:

- `id`
- `title_user_preferred`
- `title_english`
- `cover_image_extra_large`
- `cover_image_color`
- `season`
- `season_year`
- `start_year`
- `format`
- `status`
- `episodes`
- `duration`
- `average_score`
- `genres_json`
- `relations_json`
- `fetched_at`
- `raw_json`

### `sync_state`

Small key-value table used for rebuild metadata and integrity markers.

Important keys:

- `source_list_id_count`
- `source_entry_count`
- `source_torrent_count`
- `anilist_media_count`
- `source_list_id_parity`
- `expanded_torrent_parity`
- `last_rebuild_started_at`
- `last_rebuild_finished_at`
- `last_rebuild_mode`
- `last_rebuild_summary`

## Rebuild rules

The external rebuild script:

1. Fetches all `listIDs`.
2. Fetches all expanded SeaDex entries in `source_updated_at` order.
3. Verifies the `listIDs` set matches the expanded entry set.
4. Verifies each entry's `trs` IDs match its `expand.trs` rows.
5. Fetches AniList only for SeaDex entry IDs.
6. Writes a full clean snapshot into D1.

This avoids the partial-sync failure mode that created missing torrent rows in earlier iterations.
