PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY, applied_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(
 account_id TEXT PRIMARY KEY,
 username TEXT NOT NULL UNIQUE COLLATE BINARY,
 password_scheme TEXT NOT NULL CHECK(password_scheme='scrypt-r32'),
 password_salt_ascii TEXT NOT NULL,
 password_key_hex TEXT NOT NULL,
 status TEXT,
 created_ms INTEGER NOT NULL,
 legacy_record BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS storage_meter(
 account_id TEXT PRIMARY KEY REFERENCES accounts(account_id),
 storage_cap_bytes INTEGER NOT NULL CHECK(storage_cap_bytes>=0),
 storage_used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(storage_used_bytes>=0)
);
CREATE TABLE IF NOT EXISTS activity(
 account_id TEXT PRIMARY KEY REFERENCES accounts(account_id),
 last_active_ms INTEGER NOT NULL,
 idle_wipe_due_ms INTEGER NOT NULL,
 idle_wipe_state TEXT NOT NULL DEFAULT 'pending_review' CHECK(idle_wipe_state IN ('pending_review','eligible','held','wiped'))
);
CREATE TABLE IF NOT EXISTS sessions(
 account_id TEXT NOT NULL REFERENCES accounts(account_id),
 token_digest BLOB NOT NULL UNIQUE CHECK(length(token_digest)=32),
 created_ms INTEGER NOT NULL,
 expires_ms INTEGER NOT NULL,
 last_active_ms INTEGER NOT NULL,
 revoked_ms INTEGER,
 PRIMARY KEY(account_id,token_digest)
);
CREATE TABLE IF NOT EXISTS settings(
 account_id TEXT NOT NULL REFERENCES accounts(account_id),
 record_id TEXT NOT NULL, payload BLOB NOT NULL, fmt INTEGER NOT NULL CHECK(fmt IN (1,2)),
 payload_bytes INTEGER NOT NULL CHECK(payload_bytes=length(payload)),
 updated_ms INTEGER NOT NULL, PRIMARY KEY(account_id,record_id)
);
CREATE TABLE IF NOT EXISTS history(
 account_id TEXT NOT NULL REFERENCES accounts(account_id),
 record_id TEXT NOT NULL, payload BLOB NOT NULL, fmt INTEGER NOT NULL CHECK(fmt IN (1,2)),
 payload_bytes INTEGER NOT NULL CHECK(payload_bytes=length(payload)),
 updated_ms INTEGER NOT NULL, PRIMARY KEY(account_id,record_id)
);
CREATE TABLE IF NOT EXISTS bookmarks(
 account_id TEXT NOT NULL REFERENCES accounts(account_id),
 record_id TEXT NOT NULL, payload BLOB NOT NULL, fmt INTEGER NOT NULL CHECK(fmt IN (1,2)),
 payload_bytes INTEGER NOT NULL CHECK(payload_bytes=length(payload)),
 updated_ms INTEGER NOT NULL, PRIMARY KEY(account_id,record_id)
);
CREATE TABLE IF NOT EXISTS playlists(
 account_id TEXT NOT NULL REFERENCES accounts(account_id),
 record_id TEXT NOT NULL, payload BLOB NOT NULL, fmt INTEGER NOT NULL CHECK(fmt IN (1,2)),
 payload_bytes INTEGER NOT NULL CHECK(payload_bytes=length(payload)),
 updated_ms INTEGER NOT NULL, PRIMARY KEY(account_id,record_id)
);
CREATE TABLE IF NOT EXISTS conversations(
 account_id TEXT NOT NULL REFERENCES accounts(account_id),
 record_id TEXT NOT NULL, payload BLOB NOT NULL, fmt INTEGER NOT NULL CHECK(fmt IN (1,2)),
 payload_bytes INTEGER NOT NULL CHECK(payload_bytes=length(payload)),
 updated_ms INTEGER NOT NULL, PRIMARY KEY(account_id,record_id)
);
-- Import source bytes are privileged custody artifacts, never account API payloads.
CREATE TABLE IF NOT EXISTS import_batches(
 source_sha256 TEXT PRIMARY KEY, imported_ms INTEGER NOT NULL, source_bytes BLOB NOT NULL,
 accounts_inserted INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_members(
 account_id TEXT NOT NULL REFERENCES accounts(account_id),
 source_sha256 TEXT NOT NULL REFERENCES import_batches(source_sha256),
 legacy_username TEXT NOT NULL,
 PRIMARY KEY(account_id,source_sha256)
);
CREATE TRIGGER IF NOT EXISTS settings_insert_cap BEFORE INSERT ON settings BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-0>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS settings_insert_usage AFTER INSERT ON settings BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS settings_delete_usage AFTER DELETE ON settings BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(-OLD.payload_bytes) WHERE account_id=OLD.account_id; END;
CREATE TRIGGER IF NOT EXISTS settings_immutable_owner BEFORE UPDATE ON settings WHEN NEW.account_id != OLD.account_id BEGIN SELECT RAISE(ABORT,'owner_immutable'); END;
CREATE TRIGGER IF NOT EXISTS settings_update_cap BEFORE UPDATE ON settings BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-OLD.payload_bytes>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS settings_update_usage AFTER UPDATE ON settings BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes-OLD.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS history_insert_cap BEFORE INSERT ON history BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-0>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS history_insert_usage AFTER INSERT ON history BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS history_delete_usage AFTER DELETE ON history BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(-OLD.payload_bytes) WHERE account_id=OLD.account_id; END;
CREATE TRIGGER IF NOT EXISTS history_immutable_owner BEFORE UPDATE ON history WHEN NEW.account_id != OLD.account_id BEGIN SELECT RAISE(ABORT,'owner_immutable'); END;
CREATE TRIGGER IF NOT EXISTS history_update_cap BEFORE UPDATE ON history BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-OLD.payload_bytes>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS history_update_usage AFTER UPDATE ON history BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes-OLD.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS bookmarks_insert_cap BEFORE INSERT ON bookmarks BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-0>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS bookmarks_insert_usage AFTER INSERT ON bookmarks BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS bookmarks_delete_usage AFTER DELETE ON bookmarks BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(-OLD.payload_bytes) WHERE account_id=OLD.account_id; END;
CREATE TRIGGER IF NOT EXISTS bookmarks_immutable_owner BEFORE UPDATE ON bookmarks WHEN NEW.account_id != OLD.account_id BEGIN SELECT RAISE(ABORT,'owner_immutable'); END;
CREATE TRIGGER IF NOT EXISTS bookmarks_update_cap BEFORE UPDATE ON bookmarks BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-OLD.payload_bytes>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS bookmarks_update_usage AFTER UPDATE ON bookmarks BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes-OLD.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS playlists_insert_cap BEFORE INSERT ON playlists BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-0>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS playlists_insert_usage AFTER INSERT ON playlists BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS playlists_delete_usage AFTER DELETE ON playlists BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(-OLD.payload_bytes) WHERE account_id=OLD.account_id; END;
CREATE TRIGGER IF NOT EXISTS playlists_immutable_owner BEFORE UPDATE ON playlists WHEN NEW.account_id != OLD.account_id BEGIN SELECT RAISE(ABORT,'owner_immutable'); END;
CREATE TRIGGER IF NOT EXISTS playlists_update_cap BEFORE UPDATE ON playlists BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-OLD.payload_bytes>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS playlists_update_usage AFTER UPDATE ON playlists BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes-OLD.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS conversations_insert_cap BEFORE INSERT ON conversations BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-0>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS conversations_insert_usage AFTER INSERT ON conversations BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes) WHERE account_id=NEW.account_id; END;
CREATE TRIGGER IF NOT EXISTS conversations_delete_usage AFTER DELETE ON conversations BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(-OLD.payload_bytes) WHERE account_id=OLD.account_id; END;
CREATE TRIGGER IF NOT EXISTS conversations_immutable_owner BEFORE UPDATE ON conversations WHEN NEW.account_id != OLD.account_id BEGIN SELECT RAISE(ABORT,'owner_immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversations_update_cap BEFORE UPDATE ON conversations BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'missing_meter') END; SELECT CASE WHEN (SELECT storage_used_bytes+NEW.payload_bytes-OLD.payload_bytes>storage_cap_bytes FROM storage_meter WHERE account_id=NEW.account_id) THEN RAISE(ABORT,'storage_cap') END; END;
CREATE TRIGGER IF NOT EXISTS conversations_update_usage AFTER UPDATE ON conversations BEGIN UPDATE storage_meter SET storage_used_bytes=storage_used_bytes+(NEW.payload_bytes-OLD.payload_bytes) WHERE account_id=NEW.account_id; END;

CREATE TABLE IF NOT EXISTS session_import_batches(source_sha256 TEXT PRIMARY KEY, imported_ms INTEGER NOT NULL, inserted INTEGER NOT NULL);
-- Append-only audit application role; enforce durable writes in SAME transaction
-- as session revoke/status update. No token plaintext. Account row may be deleted
-- by approved wipe, so audit account id intentionally has no cascading FK.
CREATE TABLE IF NOT EXISTS revocation_audit(
 event_id INTEGER PRIMARY KEY AUTOINCREMENT,
 account_id TEXT NOT NULL,
 token_digest BLOB CHECK(token_digest IS NULL OR length(token_digest)=32),
 event TEXT NOT NULL CHECK(event IN ('session_revoked','account_banned','password_rotated','account_removed')),
 occurred_ms INTEGER NOT NULL,
 CHECK((event='session_revoked' AND token_digest IS NOT NULL) OR event!='session_revoked')
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON revocation_audit
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON revocation_audit
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
-- Freed names remain reserved; claim/rename transaction must check this table.
CREATE TABLE IF NOT EXISTS username_tombstones(
 account_id TEXT NOT NULL,
 username TEXT PRIMARY KEY COLLATE BINARY,
 retired_ms INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS accounts_reserved_insert BEFORE INSERT ON accounts
WHEN EXISTS(SELECT 1 FROM username_tombstones WHERE username=NEW.username)
BEGIN SELECT RAISE(ABORT,'username_tombstoned'); END;
CREATE TRIGGER IF NOT EXISTS accounts_reserved_update BEFORE UPDATE OF username ON accounts
WHEN EXISTS(SELECT 1 FROM username_tombstones WHERE username=NEW.username)
BEGIN SELECT RAISE(ABORT,'username_tombstoned'); END;
CREATE TRIGGER IF NOT EXISTS accounts_tombstone_rename AFTER UPDATE OF username ON accounts
WHEN OLD.username != NEW.username
BEGIN INSERT INTO username_tombstones(account_id,username,retired_ms)
 VALUES(OLD.account_id,OLD.username,CAST(strftime('%s','now') AS INTEGER)*1000); END;

-- Device pairing (Roku lane contract): TVs pair without a password. Pending
-- pairing requests are short-lived; issued devices live until revoked.
CREATE TABLE IF NOT EXISTS pairing_requests(
 poll_id TEXT PRIMARY KEY,
 code TEXT NOT NULL,
 name TEXT NOT NULL,
 created_ms INTEGER NOT NULL,
 expires_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','consumed')),
 account_id TEXT,
 device_id TEXT
);
CREATE TABLE IF NOT EXISTS devices(
 device_id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(account_id),
 name TEXT NOT NULL,
 scopes TEXT NOT NULL,
 token_digest BLOB NOT NULL UNIQUE CHECK(length(token_digest)=32),
 created_ms INTEGER NOT NULL,
 last_used_ms INTEGER,
 revoked_ms INTEGER
);

-- Pairing auxiliary state keeps legacy pairing_requests CHECK compatible across upgrades.
CREATE TABLE IF NOT EXISTS pairing_meta(poll_id TEXT PRIMARY KEY, client_id TEXT, terminal TEXT);
CREATE INDEX IF NOT EXISTS pairing_client ON pairing_meta(client_id);

CREATE INDEX IF NOT EXISTS pairing_expiry ON pairing_requests(state,expires_ms);
CREATE INDEX IF NOT EXISTS pairing_code ON pairing_requests(code,created_ms);
