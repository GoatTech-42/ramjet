# design: ending username-based login lockout (v3, after second reviewer hold)

## the problem

the login route throttles `acct:<name>` BEFORE verifying, counting every
attempt (10 per 10 min). anyone who knows a username can hold that account
at 429 forever with ~1 request/minute, and the owner's own correct password
is never even checked.

## every password-verification route, and what guards it

| route | verify | throttle |
| --- | --- | --- |
| `POST /api/auth/login` | password | this design (below) |
| `POST /api/auth/change-password` | current password, session required | the same account failure budget + kd gate, and every failed current DEBITS THE PRESENTING DEVICE's lifetime budget: a session and a kd stolen together still self-revoke at 20 probes (tested). the general per-user request limit on top. |
| `/api/lite/*` (Basic/Bearer) | password, every uncached request | per-socket-ip limits only (60/min + bad-ip backoff), plus a 5-minute in-memory good-credential cache keyed by sha256 and bound to the account's revocation generation. cookies do not exist on this surface, so kd cannot apply; charging lite failures to the account budget would reintroduce the lockout with no escape hatch. **residual, flagged for the deployment owner's decision (not self-accepted): credential stuffing against lite is bounded per-ip only.** scrypt cost and the revocation-bound cache are the only friction there. |
| `POST /api/auth/signup` | creates, not verifies | own per-ip limit (40) |

## forwarded identity is the ceiling's foundation (deployment gate)

every per-ip number in this design is only real if the client ip is real.
`clientIp` honors `x-forwarded-for` ONLY from a trusted peer (loopback by
default, or `RJ_TRUST_PROXY`); a direct client's spoofed xff is ignored
(tested). **deployment requirement: the edge MUST strip client-supplied xff
and set it itself, or no per-ip ceiling anywhere in the proxy is a
ceiling.**

## the design: known-device cookie + failure-counted budget

1. **the account budget counts failures, not attempts.** a correct password
   never spends budget; a success resets it. under budget the flow is
   exactly today.
2. **over budget, a verify costs a known-device cookie.** on a successful
   login (or signup) the server mints `__Host-rj_kd` - a random 256-bit
   token, HttpOnly, SameSite=Lax, Secure ALWAYS, Path=/, no Domain
   (__Host- rules), 90-day Max-Age. only its sha256 is stored, as
   `{ h, exp, fails }`, fifo of 8 per account in users.json.
   - **server-side expiry**: `exp` (90 days) is enforced on read; aged-out
     entries are pruned from disk.
   - **renewal in place**: a successful login from a remembered device
     extends THAT entry's expiry. same token, no new entry, so repeat
     logins never evict the owner's other devices.
   - **the device failure budget is LIFETIME and cumulative.** a failed
     verify on a remembered device increments `fails`; renewal NEVER resets
     it; at 20 the device revokes itself. honest claim: a stolen kd buys at
     most 20 verified guesses BEYOND the per-account budget every unknown
     device already has - after revocation the thief is an unknown device
     and the ordinary budget applies (including its reset on the owner's
     successes). the alternative - rotating the token on each successful
     renewal so old copies die - was rejected: two tabs of the same browser
     racing a login would keep revoking each other, and a copy made after
     the latest rotation is indistinguishable from the owner anyway.
   - **revocation tied to authority**: single-device logout forgets the
     asking device (and clears the cookie); logout-all, ban, removal, and
     every password change clear ALL devices (killSessions owns it). a
     username rename keeps the list - the devices are the same person's.
     kd is never logged; only its hash persists.
   - Secure is unconditional and __Host- requires https: **on a plain-http
     deployment the cookie never sticks and nothing in this design works -
     it degrades to pre-kd behavior. this design assumes real https.**
3. **a remembered device skips every ip-keyed guard.** the 120/10min login
   ceiling exists to bound scrypt cpu, and the general 5000/hour anon
   bucket keys on ip too - both let a NAT full of strangers lock the owner
   out. a remembered device instead spends the general budget against the
   ACCOUNT (`kd:<name>`, same 5000/hour shape) and answers to its own
   lifetime failure budget, so neither NAT neighbors nor one shared-ip
   attacker can exhaust the IP-keyed guards under the owner's browser.
   this is not "the owner always works": the account-keyed budget and the
   device's lifetime budget still bound that path. forged cookies cost a
   hash compare and fall through to the ip guards without spending a
   scrypt.
4. **a password change issues the replacement kd in the same response.**
   the changing browser proved the NEW password; it leaves with a fresh
   session AND a fresh device cookie.
5. **enumeration parity.** unknown usernames pay a dummy scrypt (same 401
   body, same timing) and accrue the SAME failure budget as real names;
   the hot-limit 429 fires identically whether or not the name exists.
   tested: status, body, timing, hot-limit behavior.
6. **every guard key-space is bounded against churn.** the login-tries map
   (acct/ip/signup keys) and the request/byte bucket map are each capped
   at 10k entries with one admission rule: entries with a LIVE window are
   never evicted (a victim's throttle state is never silently reset),
   expired windows are shed first (at boot, on lookup, and on admission),
   and a map full of live entries refuses admission and fails CLOSED (no
   verify, no request, zero bytes). without this, 10001 invented keys could
   erase a victim's cap - tested as a direct repro. the trade is stated
   plainly: bounded memory is bought with denial of NEW accounts, devices,
   and anon buckets for as long as 10000 live keys fill a map - churn that
   large is an active attack, and failing closed keeps every existing
   victim's throttle state intact through it.

## residuals (documented, no promises)

- a brand-new device during an active spray waits: the account budget
  reopens 10 minutes after the LAST failure, so a continuous spray holds
  new devices out indefinitely, not for 10 minutes. closing that needs a
  captcha/pow step - a bigger surface.
- a stolen kd can burn its 20 and revoke the OWNER's escape credential
  with it: the owner's that-device login then waits out a window like any
  new device. other devices and password change remain.
- unauthenticated non-login surfaces (signup, public pages) still key on
  ip; a hostile NAT neighbor can exhaust those buckets. login itself no
  longer does (point 3).
- defense costs: scrypt is sync (event-loop time per verify) and every kd
  failure/renewal writes users.json. an attacker at the ip ceiling can
  still make the box pay ~120 scrypts per 10 min per ip; per-failure disk
  writes are small but real io.
- lite stays per-ip only - **flagged above for the deployment owner's decision**.
- xff edge-strip is a deployment gate (above); __Host- needs real https
  (above).

## reference implementation + tests (branch kd-design)

- core/auth.js: kd entries `{ h, exp, fails }` (hash-only, fifo 8),
  mint/renew/fail/revoke/clear with lazy expiry pruning, lifetime budget,
  dummy scrypt for unknown names, killSessions clears devices,
  `__Host-rj_kd` headers.
- core/guard.js: failure-counted account budget; anti-churn admission on
  every key-insertion path (login map + request/byte buckets), fail-closed
  when full of live entries, expired shed first, no silent resets.
- core/index.js: login reorders to kd-path (account-keyed general budget,
  skips ip guards) vs unknown-device path (anon bucket -> ip ceiling ->
  account budget -> verify); change-password spends account + device
  budgets and mints the replacement kd; logout revokes the asking device.

tests (24 kd tests: 15 route-level, 9 unit - all green; full suite green):
mint/cookie-flags/hash-only storage, attacker 429 vs owner kd, renewal in
place, success resets the account budget, kd-is-not-a-session, password
change clears + re-mints, logout forgets, stolen-kd cross-ip exhaustion,
stolen session+kd change-password exhaustion, copied-token lifetime budget
across owner logins, NAT login-ceiling skip, NAT general-bucket exemption,
enumeration parity, malformed/duplicate cookies, fifo eviction, server-
side expiry + disk pruning, restart persistence, cumulative renewal
semantics, self-revoke + revocation paths, guard windows, guard anti-
churn (both maps), spoofed xff from an untrusted peer.
