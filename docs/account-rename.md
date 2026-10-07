# Account rename

Online username changes refuse with409. The account page explains maintenance rather than offering a form that strands saved data. No role, admin, sync-admin or quota policy changes in this pass. Protected/configured special names cannot be migrated.

## Procedure

Stop every process sharing this root, including any separately launched tool/container. The local PID lock only guards the same process namespace; it cannot prove a host/container elsewhere is stopped. Take the full stopped snapshot from storage-cutover.md, including hidden files, key, messages and media. Verify restoration and decrypted fixtures first. Retain source/image/environment.

In the stopped container's normal environment, run:

```
node scripts/rename-account.mjs plan OLD NEW
node scripts/rename-account.mjs apply OLD NEW
```

Plan reports file paths/count, no contents or secrets. Collision, corruption, protected identity, invalid encrypted message or unfinished journal stops preflight without changes. The complete source-root inventory must include any unrecognized stores added since this version; do not assume this manifest covers future addons.

Account maps: users, sessions, guard, user-prefs, Amp playlists, Browse bookmarks/sync, Sage conversations, Jetstream history/likes/dislikes/subs/settings. Chat maps: friends/reqs/reads/codes; owners/members; message authors/reply authors; votes and reactions. Plain message text is not search-and-replaced. Encrypted bodies are decrypted/validated then resealed with the unchanged key only when nested identity fields change. Media bytes and key remain untouched. User-independent search/provider/cache data and diagnostic text logs are not identity stores.

Changes run with a private per-file snapshot and hash manifest in .identity-snapshots. The fsynced .identity-migration.json journal is installed before any replacements. On failure original bytes/permissions are restored. On crash startup restores any prepared/incomplete journal before loading accounts/addons; a durable committed marker completes without reverting. Bad journal/snapshot hashes block startup instead of partially restoring. Do not discard these artifacts to force startup. `node scripts/rename-account.mjs recover` is for stopped recovery only.

Start a fresh process (no stale runtime caches/tickets). Verify renamed login, existing session, export, playlists, bookmarks/history, conversations, chat membership/ownership/replies/votes/reactions/edit access, prefs and quotas. Check old login fails, collisions fail, and key/media hashes unchanged. Browser local-only caches may contain an old greeting until reload, not backend identity. Do not claim old diagnostic logs were rewritten.

If rollback is needed after new writes, stop and reconcile those writes before restoring an older snapshot. Never merge journal and current state or restore while a process is writing. Never rename the production owner as a smoke fixture.

A short exclusive .identity-lock-claim serializes stale PID-lock removal. A crash during that step fails closed. Only after independently confirming EVERY process/container using this root is stopped, an operator may remove that stranded claim and run stopped recovery. Never remove a server lock or claim merely to make startup work. PID liveness is meaningful only in the same namespace; the stopped-container procedure is mandatory.
