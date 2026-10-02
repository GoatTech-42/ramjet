# ramjet2 - ground-up redesign plan (the only plan)
Written Sep 28 ~3:26 PM after Luke's confirmed scope + full autonomy.

## Confirmed scope (Luke, user-channel originals via parent)
- Ramjet + its five apps ONLY (not GoatClient/MiniGoat/mc anything).
- Zip everything first, then wipe, rebuild from complete scratch. DONE: archives in
  /home/luke/goattech/archives-20260928/ (9 tarballs incl. staging trees + ramjet-data);
  repos wiped. GitHub remotes GoatTech-42/ramjet|jetstream|amp left intact as extra backup.
- "Make every choice on every aspect of the project yourself."
- "Wipe all knowledge of ramjet... go off of the concept not anything visual and nothing
  mechanical in any way literally just 1 sentence or so about each project and app"
- Bar: "production level app with no bugs whatsoever" + "it needs to look stunning".
- Build in background until Saturday Oct 3; one update per day (via parent); live stays DOWN.

## The concept (one sentence each - the entire spec)
- ramjet: one login opens your personal corner of the web - a filter-safe portal
  with a built-in proxy browser and a family of apps.
- proxy browser: type any address and browse it through ramjet; filters never see
  the destination, destinations never see the school network.
- jetstream: search and watch YouTube, filter-safe.
- amp: one clean music player across YouTube Music, SoundCloud and Audius.
- sage: ask an AI anything in a clean conversation.

## Hard requirements (standing, not v1 mechanics)
- Low AGGREGATE bandwidth even with many users - server-enforced budgets everywhere.
- Small footprint, free tiers only, MC/EmberBot/box untouched (2 GB+ free RAM floor).
- Everything built from source in one pipeline; screenshot proof at 390x844 + 1280
  before any screen counts as done; QA gate: every flow exercised until nothing
  reproduces, known-issue list empty at "done".

## Fresh architecture (my choices, from scratch)
- One Node 20 process, zero runtime dependencies (node:http), JSON-file storage.
- Apps = addons with explicit route tables, health checks, failure isolation.
- One vite + svelte multi-page pipeline; every UI builds from source.
- New design system from tokens: new visual identity (v1's look is not consulted).
  Direction: true-black base, one electric accent, glassy cards, big rounded type,
  motion that feels alive, mobile-first with 44px targets.
- Auth: scrypt accounts, httpOnly cookie sessions, login guard, first-class QA users.

## Scope cuts (Mon ~6:00 PM, Luke live)
- PERSONAL PLATFORM: "honestly this platform is probably just for me" - school-scale assumptions (bandwidth budgets, multi-user hardening) relax; real-product bar + Saturday reveal stay.
- BANTER: cut ("probably isn't needed"). Parked, nothing deleted.
- ALL SOCIAL FEATURES: cut (same personal-platform logic). Family = browse, jetstream, amp, sage.
- JETSTREAM QUALITY BAR (Luke 5:58 PM): 1080p if possible - 360p was a bandwidth-first stopgap.

## Week shape (done = Saturday Oct 3)
- Mon PM: fresh core + auth + hub + design tokens, screenshot-verified.
- Tue: proxy browser + jetstream.
- Wed: amp.
- Thu: sage + settings/accounts.
- Fri: acceptance gate - full flow matrix to zero repros, bandwidth audit, polish.
- Sat: docs + cutover runbook + final report. Live relaunch only when Luke asks.

## Scope updates (Mon ~4:41 PM, Luke live)
- FLICK: collaboration angle DROPPED. Just movies, fast. No watch-with-people rooms.
- KNOWLEDGE WIPE RELAXED: may remember the GENERAL IDEA of each app as it was in v1 (his clarification 4:42 PM) - general ideas only, NOT mechanics, NOT visuals. Everything is still rebuilt fresh.
- ADD MY OWN SPIN: original ideas beyond v1 parity are wanted, filtered by the human-made bar + no-bugs Saturday gate.
- PRINCIPLE (law): everything must look HUMAN-MADE - copy, UI, details. Review loop checks "would a person believe a human made this" every lane.

## How the 4 days run (researched Mon ~4:48 PM, Luke asked for this)

Sources: scrum sprint-planning guides, NN/g heuristic evaluation, UX competitive analysis practice, launch QA checklists (RedQA, release-readiness templates).

### Planning rules
- One primary lane per day, one hard gate per evening: a WORKING app, real screenshots, Notion updated the same session. No gate, no sleep on it.
- Timeboxes are fixed (Tue browse+jetstream, Wed amp, Thu sage+settings). A lane that slips eats its own evening, never the next lane.
- Scope freezes Thursday midnight. Friday is test-and-fix only - no new features, no "one more idea".
- Backlog of nice-to-haves lives at the bottom of this file; only pulls in if a lane finishes early.
- Saturday 1 PM PT is the reveal. Friday night the build is frozen except crash fixes.

### Review loop (every lane, before it can pass)
1. SELF-QA - scripted API checks (login, budgets, errors) + click-through at 390px and 1280px. Real flows, not happy paths.
2. PRODUCT COMPARISON - pick 2-3 professional products in the lane's category and compare the flow: navigation logic, feedback, error states, friction (UX competitive analysis method). browse: Arc/Safari. jetstream: YouTube. amp: Spotify. sage: ChatGPT. Steal patterns, never pixels.
3. HEURISTIC PASS - NN/g quick sweep per screen: status visible, errors prevented not just reported, consistent patterns, recognition over recall, empty states that say something useful.
4. HUMAN-MADE JUDGMENT - would a person believe a human made this? No AI tells: glow, glass, gradients, generic copy, over-perfect symmetry.
5. Fix what the loop finds, re-screenshot, THEN the lane is done. Loop until clean.

### Friday gate (launch-style QA)
- Fresh account, real device viewports, every app end to end, GO/NO-GO checklist.
- Error states on purpose: wrong password, dead network, oversized input, spam clicking.
- Only then: frozen for Saturday.

### Notion
- Updated at all times (Luke, 4:46 PM): any lane move lands on the page in the same work session.

### Research-first rule (Luke, 4:49 PM)
No hasty builds. Before any lane starts: research what it is (v1 general idea), how pro products do it, what the design should reference. Know exactly what you are building before writing code.

### Amendments, Mon 6:01-6:14 PM
- FLICK: cut too ("make that ur own project too") - spin-off like banter. Ramjet family is now browse, jetstream, amp, sage. Thu lane becomes sage + settings/accounts only.
- Mon 8:37 PM: Luke called it - banter and flick are FULLY removed from ramjet, nothing replaces them (ramjet = browse, jetstream, amp, sage). The GoatTech-42/banter-chat and GoatTech-42/flick-movies repos are kept only as empty shells he can reuse if he ever wants more apps; they are NOT ramjet scope and not standalone projects we maintain.
- BANDWIDTH (Luke 6:01 PM): "u prob don't need to save bandwidth" - per-user byte budgets scrapped; quality wins (jetstream 1080p). Keep only a whole-box sanity guardrail so nothing melts.
- 4b4t PORT SWAP DONE 6:14 PM: 4b4t live on server.lukeevanson.com default ports (25565 java / 19132 bedrock / 24454 voice) via UPnP asymmetric maps; Emberstead playit tunnels untouched (mc-proxy now loopback-only).

## CURRENT STATE (Tue 12:51 AM)
- ALL LANES SHIPPED Monday night: core/auth/hub/tokens, browse (+mobile fix, back arrow, SVG icons), jetstream (1080p HD old-pattern), amp (3 sources, block-cache YT, honest throttle errors), sage (keyless provider, markdown), settings (was a soft-404, built).
- Also done: banter/flick purged (hub + gates), design-token bug fixed, bandwidth budget enforced at media choke points (1GB/user/hr - matches core/guard.js; raised from 256MB because video streaming eats it fast), full regression sweep green both viewports.
- REMAINING: review-loop steps 2-4 per lane (product comparison, heuristic pass, human-made judgment - steal nothing, just verify no gaps), Fri acceptance gate (zero-repro re-run + bandwidth re-audit + watch the transient amp 502), Sat docs + final report.
- YT verdict logged in PROGRESS 11:49 PM: mega-hits stream, most of catalog walls after ~1MB (googlevideo per-asset tier). Luke picks: ship as-is / PO-token build / reorder sources.
- Open questions staged for Luke: sage Groq key (better answers, vault), hub footer copy (built by luke + instinct vs built by luke), embercam 14G videos.
