# Seeker — deployment notes

Live (since 2026-11-18): https://seeker-m2nl.onrender.com
Old Railway link (seekerlive.up.railway.app) is retired: the Railway trial ended.

## Hosting now: Render + Neon
- Code: GitHub `Haircoolhis/seeker`, branch `main` (index.tsx, Dockerfile, package.json, neon.ts). This is the source of truth.
- Render web service `seeker` (srv-dbuqna68bjmc739l8vi0), Frankfurt, free instance, Docker (`oven/bun:1`).
  - Env: DATABASE_URL (Neon, pooled, `?sslmode=require`), HOST_CODES=VELVET26.
  - Auto-deploy on push did not fire on the first push; after pushing, check list_deploys and trigger a deploy if needed.
  - Free instances sleep after 15 min idle. index.tsx pings RENDER_EXTERNAL_URL/health every 10 min so guests never hit a 50 s cold start. Keep Seeker the only always-on free service (750 free hours/month).
- Neon project `rough-sky-17186377`, London (eu-west-2), database `neondb`. Free plan, does not expire. Tables are created by the app on start.
- No 96 KB limit any more (that was Railway Functions), so no build/slimming step is needed.
- Unused: Render free Postgres `seeker-db` (expires 2026-12-18; safe to delete).
- To do: reset the neondb_owner password in Neon (it was shared in chat) and update DATABASE_URL on Render.

Routes
- `/` host creates an event: venue from current location or address/postcode search, pin adjustable on a map; start now or at a set time (up to 30 days ahead); optional meeting point; "let guests look around first" (on by default)
- `/events` My events: every event linked to this creator (live / upcoming / ended), plus the creator link card
- `/c/<creatorKey>` creator link: saves the key on this device and opens My events — works on any phone
- `/h/<id>?k=<hostKey>` host dashboard (QR, "Copy guest link", stats, how many are looking around, reports, meeting point, end event)
- `/e/<id>` guest join and status board; shows a countdown before the start time. Joining is a step-by-step journey (one question per screen, progress bar, a mood note under each): house rules → name → status → one line (optional, Skip) → how to spot you → who can see you → preview card → "Check my location and join". Browse guests posting a status get the same journey minus the rules step.

Creator links (2026-10-18)
- Table `creators(key)`; `events.creator_key` and `summaries.creator_key`.
- Creating an event sends the device's saved creator key (localStorage `seeker:creator`); the server issues a new key if missing or unknown. Response includes `creatorKey`.
- `POST /api/creator/claim {creatorKey, events:[{id,k}]}` attaches events this device already hosts (proved by host key) to the creator key — used once per My events visit to migrate old, per-device events.
- `GET /api/creator/:key` lists events (with host keys) and ended summaries; `POST /api/creator/:key/reset` swaps the key and invalidates the old link.
- Removed: `/api/host-status` and the "Add an event from another device" box (people pasted the guest link and got errors).

Safety principle: nobody learns more about you than you learn about them, and you can pull out at any moment.
- Location checked on every board/wave/share/beacon/edit call; guest coordinates are never stored, only the venue pin.
- Location blocked or unavailable: the guest sees step-by-step help for their phone (iPhone Safari, Android Chrome, or "open in browser" + Copy link when opened inside Instagram/TikTok/Facebook in-app browsers).
- Optional rotating QR check-in (code changes every 2 minutes; previous code still accepted, so a code lasts up to 4 minutes).
- House rules (no means no, no photos, staff can remove you, 18+) must be agreed with the 18+ tick; the server refuses a join without `rules: true`.
- 18+ confirmation, waves only (no messaging), discreet mode (same-status only), block, report (3 reporters auto-hide).
- Look around first (browse mode): anyone (no gender check, deliberately) can join without a status. They see nicknames, statuses and lines of people who are visible to everyone; never discreet-mode guests, descriptions or wave info. They are invisible, can't wave, share or use the beacon, and can't be waved at. Everyone sees how many people are looking around. Browsers can block, report and leave. Posting a status turns them into a normal guest. Host can turn browse mode off per event.
- Ready to meet (cooling period): after a mutual wave, each person taps "I'm ready to meet" when they feel ready (stored as share kind 'desc'). Only when BOTH are ready do they see each other's "how to find you" note, the meeting point line and a shared match word (e.g. "Velvet", HMAC of event + pair over a 36-word list) to say when they meet. If one never taps, nobody is told.
- "Find each other" beacon is a handshake: colours are only sent while both phones are checking in (live within 12 seconds).
- Unmatch (two taps) withdraws your wave and everything either person shared, including the word. Block and report also withdraw shares.
- Events auto-delete on end; host keeps totals for 90 days.
- Address search uses OpenStreetMap Nominatim (throttled, cached); maps use OpenStreetMap tiles via Leaflet 1.9.4.

Decisions
- Gender verification / women-only features: decided against (can't verify reliably; self-declared gender would let men unlock it; UK Equality Act risk). Browse mode is offered to everyone instead.
- Getting guests in (2026-10-17): a fixed link/QR, with QR check-in OFF. Receipts are the "official" way in ("Your drink unlocks Midnight Confessions. Scan me."), Instagram teases without the link ("Get your Confession code at the bar"), table cards on booked tables, staff/hosts carry a QR card, no wall posters. Location is the only gate. Rejected for the pilot: word of the night, venue Wi-Fi check, rotating screen code, follow-to-DM (Instagram can't trigger a DM on a follow).
- Removal and identity: guests are identified only by a random token in their browser, so a removed guest can rejoin on a private tab or another phone. Accepted: "remove plus your staff" — the app flags, venue staff deal with the person. Phone-number sign-in is a possible paid venue option later.
- Creator accounts: a private creator link now, no sign-up. Email sign-in later, once venues pay (needs an email service).
- Staff guide for the pilot (three levels: guest handles it / report and watch / ask to leave): Claude Docs "Seeker staff guide: 2geda pilot" https://claude.ai/artifact/ShwZcYTnfeCUC4BPDN4Yd7
- Icebreaker games: decided to build AFTER the pilot, slotting in between matching and "ready to meet". Rules: under a minute, both agree first, pick-from-options only (no typing), declining is silent, ends with a hook to meet. First to build: "This or That" with host-set questions per night. Other candidates: Two Truths and a Lie, rock paper scissors, Would You Rather, quick reflex, emoji story, Confession Card; Guess the Song later (music licensing). Chess suits networking/board-game events, not clubs.
- First pilot target: Together Derby, "Sedvction Saturday: Midnight Confessions" Halloween edition, Sat 31 Oct 2026 (fallback test night Sat 24 Oct).

Known limits: a guest can lie in their description, or light their beacon then hide the phone; they still only learn what the other person chose to share. GPS can't separate the room from just outside it (smoking area, queue); accepted for the pilot. Removed guests can rejoin under a new nickname. The match word proves the person in front of you is your in-app match, not who they really are. Anyone holding a creator link can manage those events (reset is on the My events page).

History
- 2026-10-16: first deploy.
- 2026-10-17: address/postcode pinning, scheduled starts, My events; status-list fix.
- 2026-10-17: required find-me note, meeting point, two-tone beacon.
- 2026-10-17: both-or-neither safety: description swap, beacon handshake, unmatch.
- 2026-10-17: look-around-first (browse mode); fixed table-creation order for empty databases.
- 2026-10-17: house rules on the join screen, required by the server.
- 2026-10-17: "I'm ready to meet" + match word.
- 2026-10-18: step-by-step location help (incl. Instagram/TikTok in-app browsers).
- 2026-10-18: creator links; "Copy guest link"; removed the host-link import box; build step for the 96 KB limit. 100 automated checks passing (e2e, e2e2, e2e3, e2e5, e2e6, e2e7, e2e8; e2e4 is the retired pre-handshake beacon suite), run against the built file.
- 2026-10-18: guest join rebuilt as a one-question-per-screen journey with notes, progress bar and a preview before going live. 100 checks still passing. Host create form is still a single form.
- 2026-10-24: trust badges on the first screen (no sign-up / payment / phone number / deleted at night end), link-preview text, favicon, "Made in Kent" footer; address renamed to seekerlive.up.railway.app.

- 2026-10-25: hosting is invite-only. Variable HOST_CODES (comma-separated, case-insensitive; currently VELVET26) is checked when an event is created. Remove the variable to open hosting to everyone. Home page shows a 12.5 s story-style explainer reel.
- 2026-10/11: "night" wording changed to "room"; @useseeker under the host QR, in the footer and on the ended page.
- 2026-11-18: moved from Railway (trial ended) to Render (app) + Neon (database). Keep-awake ping added. 14-check end-to-end test passed locally before the move; live start on Render connected to Neon ("Seeker listening on 10000").
- 2026-11-18: networking mode. Picking "Networking or conference" sets events.kind='network': defaults 8 h / 200 m / "Registration desk", work-style questions (What are you here for? What do you do?), an optional contact step (LinkedIn or work email, guests.contact), professional house rules (18+ still required), and "Swap contacts" replaces "I'm ready to meet". Contacts are revealed only when both have waved AND both tapped Swap (same both-or-neither rule); no match word in networking rooms; unmatch hides contacts again. Host code errors now show at the code box and scroll up to it. Checks: 14 social + 11 networking API checks, plus browser checks of the networking form, join journey and match card.

Not built yet: card payments / pricing tiers, email sign-in, QR posters / table cards / receipt artwork, permanent venue link (e.g. /v/2geda) so printed codes survive from week to week, "pause new joins" button, clearer label for the QR check-in option, icebreaker games, journey-style host create form.
