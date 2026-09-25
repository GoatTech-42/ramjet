# Ramjet v0.4 - zero-knowledge design notes (honest limits)

## What is genuinely zero-knowledge
- History, bookmarks, settings: AES-256-GCM encrypted client-side (rjcrypto.js),
  server stores only ciphertext in userdata/<user>.blob.json. The wrapped data
  key lives in process memory keyed by session token; disk files are useless
  without the user's password.
- Passwords: salted scrypt hashes only.
- v0.4 inactivity wipe (7d) deletes the account, the encrypted blob, and all
  sessions - after a wipe there is nothing left on the server to read.

## What is NOT zero-knowledge, and why (no faking)
1. **Browser HTTP cache.** Scramjet fetches run through the browser, and the
   browser's HTTP cache is owned by the browser, keyed by the proxied URL
   shapes. A server-side or client-side JS "encrypted cache" cannot intercept
   what Chromium decides to cache at the network layer. Honest options are:
   (a) ask the browser not to cache (scramjet already rewrites cache headers
   where it can; the service worker controls its own cache buckets), and
   (b) the wipe-on-logout path clearing Cache Storage + IDB for the origin.
   What we will NOT do is claim the disk cache is encrypted. It is not.
2. **Per-user adblock preference.** The server-side blocklist runs inside the
   wisp transport, which terminates before any user identity exists (the wisp
   upgrade is authenticated, but per-stream filtering is global). The per-user
   pref lives in the encrypted blob the server cannot read. So: server blocklist
   is a GLOBAL admin toggle; a per-user "off" switch could only be cosmetic
   (client-side element hiding), which we do not ship.
3. **Traffic metadata.** The server sees destination hostnames at connect time
   (wisp streams) and request timing/volume. That is inherent to any proxy and
   is why the DNS resolvers are 1.1.1.3/1.0.0.3 and UDP is off. We do not log
   destinations (wisp logging is set to NONE).

## Cookies
- Ramjet sets exactly one first-party cookie: rj_session (Secure, HttpOnly,
  SameSite=Lax). Proxied-site cookies are handled by scramjet's jar inside the
  browser profile, not by this server.
