// Seeker — temporary, geofenced status board for one-off events.
// Single-file Bun server (Render web service). Postgres via Bun.sql (DATABASE_URL).
import { sql } from "bun";
import { createHmac, randomBytes } from "node:crypto";
import QRCode from "qrcode";

const PORT = Number(Bun.env.PORT || 3000);
const QR_WINDOW_MS = 120_000; // rotating check-in code changes every 2 minutes
const MAX_ACCURACY_M = 250; // reject fixes rougher than this
const ACCURACY_ALLOWANCE_M = 75; // max slack added to the radius for GPS error
const REPORTS_TO_AUTOHIDE = 3;
const BEACON_LIVE_SECS = 12; // a beacon counts as "held up" only while its phone keeps checking in
const FIND_ME_MSG = "Add how people can find you, like what you're wearing or where you're standing.";

// ---------- schema ----------
await sql.unsafe(`create table if not exists events (
  id text primary key, name text not null, lat double precision not null, lng double precision not null,
  radius_m integer not null, ends_at timestamptz not null, statuses jsonb not null,
  host_key text not null, qr_required boolean not null default false, qr_secret text not null,
  created_at timestamptz not null default now())`);
await sql.unsafe(`alter table events add column if not exists starts_at timestamptz not null default now()`);
await sql.unsafe(`alter table events add column if not exists meet_spot text not null default ''`);
await sql.unsafe(`alter table events add column if not exists browse_allowed boolean not null default true`);
await sql.unsafe(`create table if not exists guests (
  id text primary key, event_id text not null, token text not null unique, alias text not null,
  status text not null, line text not null default '', find_me text not null default '',
  visibility text not null default 'all', hidden boolean not null default false,
  last_inside timestamptz, created_at timestamptz not null default now())`);
await sql.unsafe(`alter table guests add column if not exists mode text not null default 'declared'`);
await sql.unsafe(`create index if not exists guests_event on guests(event_id)`);
await sql.unsafe(`create table if not exists waves (
  event_id text not null, from_id text not null, to_id text not null,
  created_at timestamptz not null default now(), primary key (from_id, to_id))`);
await sql.unsafe(`create index if not exists waves_event on waves(event_id)`);
await sql.unsafe(`create table if not exists blocks (
  event_id text not null, from_id text not null, to_id text not null, primary key (from_id, to_id))`);
await sql.unsafe(`create table if not exists shares (
  event_id text not null, from_id text not null, to_id text not null, kind text not null,
  updated_at timestamptz not null default now(), primary key (from_id, to_id, kind))`);
await sql.unsafe(`create index if not exists shares_event on shares(event_id)`);
await sql.unsafe(`create table if not exists reports (
  id text primary key, event_id text not null, from_id text not null, to_id text not null,
  reason text not null default '', created_at timestamptz not null default now())`);
await sql.unsafe(`create table if not exists summaries (
  event_id text primary key, host_key text not null, name text not null, ended_at timestamptz not null,
  joined integer not null, waves integer not null, matches integer not null, reports integer not null,
  removed integer not null default 0, created_at timestamptz not null default now())`);
// Creator links: one private key per creator that lists all their events on any device.
await sql.unsafe(`create table if not exists creators (key text primary key, created_at timestamptz not null default now())`);
await sql.unsafe(`alter table events add column if not exists creator_key text not null default ''`);
await sql.unsafe(`alter table summaries add column if not exists creator_key text not null default ''`);

// ---------- helpers ----------
const newId = (n = 9) => randomBytes(n).toString("base64url");
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

type Loc = { lat: number; lng: number; acc: number };
function readLoc(v: any): Loc | null {
  if (!v || typeof v !== "object") return null;
  const lat = Number(v.lat), lng = Number(v.lng), acc = Number(v.acc ?? 50);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, acc: Number.isFinite(acc) && acc > 0 ? acc : 50 };
}

// Returns null when inside, or a guest-facing error response.
function fenceCheck(ev: any, raw: any): Response | null {
  const loc = readLoc(raw);
  if (!loc) return fail("We need your location to show this event. Allow location access and try again.", 403, { reason: "no_location" });
  if (loc.acc > MAX_ACCURACY_M)
    return fail("Your location is too rough to confirm (±" + Math.round(loc.acc) + " m). Turn on precise location and try again.", 403, { reason: "imprecise" });
  const d = distanceM(ev.lat, ev.lng, loc.lat, loc.lng);
  if (d > ev.radius_m + Math.min(loc.acc, ACCURACY_ALLOWANCE_M))
    return fail("You're outside the event area. Statuses only show inside the venue.", 403, { reason: "outside" });
  return null;
}

function qrCode(secret: string, offset = 0) {
  const w = Math.floor(Date.now() / QR_WINDOW_MS) + offset;
  return createHmac("sha256", secret).update(String(w)).digest("hex").slice(0, 8);
}
// Two-tone beacon shared by a mutual pair: same colours on both phones, different for most other pairs.
const BEACON = ["#ff3b30", "#ff9500", "#ffd60a", "#34c759", "#00c7be", "#0a84ff", "#5e5ce6", "#bf5af2", "#ff2d92", "#ffffff"];
function beaconFor(eventId: string, a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const h = createHmac("sha256", eventId).update(x + ":" + y).digest();
  const top = h[0] % BEACON.length;
  let bottom = h[1] % (BEACON.length - 1);
  if (bottom >= top) bottom += 1;
  return { top: BEACON[top], bottom: BEACON[bottom] };
}
// A word only the two people in a match see, once both are ready to meet. Same word on both phones.
const MATCH_WORDS = ["Velvet", "Midnight", "Ember", "Mango", "Moonlight", "Echo", "Saffron", "Comet", "Honey", "Jollof",
  "Neon", "Cocoa", "Starling", "Ruby", "Sapphire", "Thunder", "Pepper", "Lotus", "Cinnamon", "Galaxy", "Rhythm", "Palm",
  "Sunset", "Indigo", "Cherry", "Opal", "Blaze", "Coral", "Nova", "Tiger", "Plantain", "Groove", "Willow", "Amber", "Raven", "Lagos"];
function matchWordFor(eventId: string, a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const h = createHmac("sha256", eventId).update("word:" + x + ":" + y).digest();
  return MATCH_WORDS[h.readUInt16BE(0) % MATCH_WORDS.length];
}
const qrValid = (ev: any, c: unknown) => typeof c === "string" && (c === qrCode(ev.qr_secret) || c === qrCode(ev.qr_secret, -1));

function originOf(req: Request) {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || new URL(req.url).host;
  return proto.split(",")[0] + "://" + host;
}

// Very small in-memory rate limiter.
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}
const ipOf = (req: Request, server: any) =>
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || server.requestIP(req)?.address || "?";

// ---------- geocoding ----------
// Nominatim's usage policy: identify the app, at most 1 request per second, cache results.
const geoCache = new Map<string, { at: number; results: any[] }>();
let geoQueue: Promise<unknown> = Promise.resolve();
let geoLast = 0;
async function geocode(q: string) {
  const key = q.toLowerCase().replace(/\s+/g, " ");
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.results;
  const run = geoQueue.then(async () => {
    const wait = 1100 - (Date.now() - geoLast);
    if (wait > 0) await Bun.sleep(wait);
    geoLast = Date.now();
    const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=" + encodeURIComponent(q);
    const r = await fetch(u, {
      headers: { "user-agent": "Seeker-event-app/1.0 (+https://seeker-production-3c02.up.railway.app)", "accept-language": "en-GB,en" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error("nominatim " + r.status);
    const data: any[] = await r.json();
    return data.map((d) => ({ name: String(d.display_name || ""), lat: Number(d.lat), lng: Number(d.lon) }))
      .filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lng));
  });
  geoQueue = run.catch(() => {});
  const results = await run;
  if (geoCache.size > 2000) geoCache.clear();
  geoCache.set(key, { at: Date.now(), results });
  return results;
}

// ---------- auto-delete ----------
// Runs on incoming traffic at most once a minute; ended events are summarised then wiped.
let lastClean = 0;
async function cleanup(force = false) {
  if (!force && Date.now() - lastClean < 60_000) return;
  lastClean = Date.now();
  const over = await sql`select id, name, ends_at, host_key, creator_key from events where ends_at < now()`;
  for (const e of over) {
    const [c] = await sql`select
      (select count(*) from guests where event_id = ${e.id})::int as joined,
      (select count(*) from guests where event_id = ${e.id} and hidden)::int as removed,
      (select count(*) from waves where event_id = ${e.id})::int as waves,
      (select count(*) from waves w where w.event_id = ${e.id} and exists
        (select 1 from waves w2 where w2.from_id = w.to_id and w2.to_id = w.from_id))::int as mutual,
      (select count(*) from reports where event_id = ${e.id})::int as reports`;
    await sql`insert into summaries (event_id, host_key, name, ended_at, joined, waves, matches, reports, removed, creator_key)
      values (${e.id}, ${e.host_key}, ${e.name}, ${e.ends_at}, ${c.joined}, ${c.waves}, ${Math.floor(c.mutual / 2)}, ${c.reports}, ${c.removed}, ${e.creator_key || ""})
      on conflict (event_id) do nothing`;
    await sql`delete from waves where event_id = ${e.id}`;
    await sql`delete from blocks where event_id = ${e.id}`;
    await sql`delete from shares where event_id = ${e.id}`;
    await sql`delete from reports where event_id = ${e.id}`;
    await sql`delete from guests where event_id = ${e.id}`;
    await sql`delete from events where id = ${e.id}`;
  }
  await sql`delete from summaries where created_at < now() - interval '90 days'`;
}

// jsonb can come back as text depending on the driver; always hand out a real array.
function statusList(v: unknown): string[] {
  let x: unknown = v;
  if (typeof x === "string") { try { x = JSON.parse(x); } catch { x = []; } }
  return Array.isArray(x) ? x.map(String) : [];
}
async function liveEvent(id: string) {
  const [ev] = await sql`select * from events where id = ${id} and ends_at > now()`;
  if (ev) ev.statuses = statusList(ev.statuses);
  return ev || null;
}
// Both-or-neither: what one side of a mutual pair may see about the other.
async function pairState(eventId: string, meId: string, otherId: string) {
  const waves = await sql`select from_id from waves where (from_id = ${meId} and to_id = ${otherId}) or (from_id = ${otherId} and to_id = ${meId})`;
  const mutual = waves.length === 2;
  const rows = await sql`select from_id, kind, extract(epoch from (now() - updated_at))::float as age from shares
    where (from_id = ${meId} and to_id = ${otherId}) or (from_id = ${otherId} and to_id = ${meId})`;
  const has = (from: string, kind: string, live = false) =>
    rows.some((r: any) => r.from_id === from && r.kind === kind && (!live || r.age <= BEACON_LIVE_SECS));
  return {
    mutual,
    iShared: has(meId, "desc"), theyShared: has(otherId, "desc"),
    myBeacon: has(meId, "beacon", true), theirBeacon: has(otherId, "beacon", true),
  };
}
async function creatorOrNew(k: unknown) {
  const key = str(k, 60);
  if (key) {
    const [c] = await sql`select key from creators where key = ${key}`;
    if (c) return c.key as string;
  }
  const nk = newId(18);
  await sql`insert into creators (key) values (${nk})`;
  return nk;
}
async function guestFor(ev: any, req: Request) {
  const token = req.headers.get("x-guest-token") || "";
  if (!token) return null;
  const [g] = await sql`select * from guests where token = ${token} and event_id = ${ev.id}`;
  return g || null;
}

// ---------- API ----------
async function api(req: Request, url: URL, server: any): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const method = req.method;
  const body: any = method === "POST" ? await req.json().catch(() => ({})) : {};

  // Create event
  if (method === "POST" && parts[1] === "events" && parts.length === 2) {
    if (limited("create:" + ipOf(req, server), 10, 3600_000)) return fail("Too many events created from here. Try again later.", 429);
    const name = str(body.name, 60);
    if (!name) return fail("Give the event a name.");
    const loc = readLoc(body.loc);
    if (!loc) return fail("Set the venue first: use your location or search for the address.");
    const fromMap = body.loc?.source === "map";
    if (!fromMap && loc.acc > MAX_ACCURACY_M) return fail("Your location is too rough (±" + Math.round(loc.acc) + " m) to pin the venue. Search for the address instead, or turn on precise location.");
    const radius = Math.round(Number(body.radius));
    if (!(radius >= 30 && radius <= 1000)) return fail("Radius must be between 30 m and 1 km.");
    const hours = Number(body.hours);
    if (!(hours >= 1 && hours <= 24)) return fail("Events can run between 1 and 24 hours.");
    const statuses = Array.isArray(body.statuses)
      ? [...new Set(body.statuses.map((s: unknown) => str(s, 30)).filter(Boolean))].slice(0, 8)
      : [];
    if (statuses.length < 2) return fail("Add at least two status options.");
    let start = Date.now();
    if (body.startsAt) {
      const t = Date.parse(String(body.startsAt));
      if (!Number.isFinite(t)) return fail("That start time isn't valid.");
      if (t < Date.now() - 5 * 60_000) return fail("The start time is in the past. Pick a later time or start now.");
      if (t > Date.now() + 30 * 86_400_000) return fail("Events can be set up at most 30 days ahead.");
      start = Math.max(t, Date.now());
    }
    const startsAt = new Date(start).toISOString();
    const endsAt = new Date(start + Math.round(hours * 60) * 60_000).toISOString();
    const id = newId(6), hostKey = newId(18), qrSecret = newId(24);
    const meetSpot = str(body.meetSpot, 80);
    const browseAllowed = body.browseAllowed !== false;
    const creatorKey = await creatorOrNew(body.creatorKey);
    await sql`insert into events (id, name, lat, lng, radius_m, starts_at, ends_at, statuses, host_key, qr_required, qr_secret, meet_spot, browse_allowed, creator_key)
      values (${id}, ${name}, ${loc.lat}, ${loc.lng}, ${radius}, ${startsAt}::timestamptz, ${endsAt}::timestamptz,
      ${JSON.stringify(statuses)}::jsonb, ${hostKey}, ${!!body.qrRequired}, ${qrSecret}, ${meetSpot}, ${browseAllowed}, ${creatorKey})`;
    return json({ id, hostKey, name, startsAt, endsAt, creatorKey });
  }

  // Creator links. claim: attach events this device already hosts (proved by their host keys) to a creator key.
  if (method === "POST" && parts[1] === "creator" && parts[2] === "claim") {
    if (limited("claim:" + ipOf(req, server), 30, 600_000)) return fail("Too many attempts. Wait a few minutes and try again.", 429);
    const list = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
    const key = await creatorOrNew(body.creatorKey);
    for (const item of list) {
      const id = str(item?.id, 20), k = str(item?.k, 60);
      if (!id || !k) continue;
      await sql`update events set creator_key = ${key} where id = ${id} and host_key = ${k} and creator_key = ''`;
      await sql`update summaries set creator_key = ${key} where event_id = ${id} and host_key = ${k} and creator_key = ''`;
    }
    return json({ creatorKey: key });
  }
  if (parts[1] === "creator" && parts[2]) {
    const key = str(parts[2], 60);
    if (limited("creator:" + ipOf(req, server), 120, 600_000)) return fail("Too many attempts. Wait a few minutes and try again.", 429);
    const [c] = await sql`select key from creators where key = ${key}`;
    if (!c) return fail("That creator link isn't valid. It may have been reset.", 404, { reason: "bad_creator" });
    if (method === "POST" && parts[3] === "reset") {
      const nk = newId(18);
      await sql`insert into creators (key) values (${nk})`;
      await sql`update events set creator_key = ${nk} where creator_key = ${key}`;
      await sql`update summaries set creator_key = ${nk} where creator_key = ${key}`;
      await sql`delete from creators where key = ${key}`;
      return json({ creatorKey: nk });
    }
    if (method === "GET" && !parts[3]) {
      const out: any[] = [];
      const live = await sql`select id, name, starts_at, ends_at, host_key from events where creator_key = ${key}`;
      for (const ev of live) {
        const [n] = await sql`select
          (select count(*) from guests where event_id = ${ev.id} and not hidden)::int as joined,
          (select count(*) from guests where event_id = ${ev.id} and not hidden and last_inside > now() - interval '3 minutes')::int as here,
          (select count(*) from reports where event_id = ${ev.id})::int as reports`;
        const now = new Date();
        const state = new Date(ev.ends_at) <= now ? "ended" : new Date(ev.starts_at) > now ? "upcoming" : "live";
        out.push({ id: ev.id, k: ev.host_key, state, name: ev.name, startsAt: ev.starts_at, endsAt: ev.ends_at, joined: n.joined, here: n.here, reports: n.reports });
      }
      const done = await sql`select event_id, name, ended_at, joined, host_key from summaries where creator_key = ${key}`;
      for (const s of done) {
        if (out.some((o) => o.id === s.event_id)) continue;
        out.push({ id: s.event_id, k: s.host_key, state: "ended", name: s.name, endsAt: s.ended_at, joined: s.joined });
      }
      return json({ events: out });
    }
    return fail("Not found.", 404);
  }

  // Address / postcode search for pinning a venue remotely (OpenStreetMap Nominatim, throttled + cached).
  if (method === "GET" && parts[1] === "geocode") {
    const q = str(url.searchParams.get("q"), 120);
    if (q.length < 3) return fail("Type at least 3 characters of the address or postcode.");
    if (limited("geo:" + ipOf(req, server), 30, 600_000)) return fail("Too many searches. Wait a few minutes and try again.", 429);
    try {
      return json({ results: await geocode(q) });
    } catch (e) {
      console.error("geocode", e);
      return fail("Address search isn't responding right now. Try again, or use your location at the venue.", 502);
    }
  }

  // Host endpoints: /api/host/:id[/action]?k=
  if (parts[1] === "host" && parts[2]) {
    const k = url.searchParams.get("k") || "";
    const ev = await liveEvent(parts[2]);
    if (!ev) {
      const [s] = await sql`select * from summaries where event_id = ${parts[2]} and host_key = ${k}`;
      if (s) return json({ ended: true, summary: { name: s.name, endedAt: s.ended_at, joined: s.joined, waves: s.waves, matches: s.matches, reports: s.reports, removed: s.removed } });
      return fail("Event not found.", 404);
    }
    if (k !== ev.host_key) return fail("That host link isn't valid.", 403);
    const action = parts[3];
    if (method === "POST" && action === "remove") {
      await sql`update guests set hidden = true where id = ${str(body.guestId, 40)} and event_id = ${ev.id}`;
      return json({ ok: true });
    }
    if (method === "POST" && action === "dismiss") {
      await sql`delete from reports where id = ${str(body.reportId, 40)} and event_id = ${ev.id}`;
      return json({ ok: true });
    }
    if (method === "POST" && action === "end") {
      await sql`update events set ends_at = now() - interval '1 second' where id = ${ev.id}`;
      await cleanup(true);
      return json({ ok: true });
    }
    if (method === "GET" && !action) {
      const joinUrl = originOf(req) + "/e/" + ev.id + (ev.qr_required ? "?c=" + qrCode(ev.qr_secret) : "");
      const shareUrl = originOf(req) + "/e/" + ev.id;
      const svg = await QRCode.toString(joinUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      const [c] = await sql`select
        (select count(*) from guests where event_id = ${ev.id} and not hidden)::int as joined,
        (select count(*) from guests where event_id = ${ev.id} and not hidden and last_inside > now() - interval '3 minutes')::int as here,
        (select count(*) from guests where event_id = ${ev.id} and not hidden and mode = 'browse' and last_inside > now() - interval '20 minutes')::int as browsing,
        (select count(*) from waves where event_id = ${ev.id})::int as waves,
        (select count(*) from waves w where w.event_id = ${ev.id} and exists
          (select 1 from waves w2 where w2.from_id = w.to_id and w2.to_id = w.from_id))::int as mutual`;
      const reports = await sql`select r.id, r.reason, r.created_at, r.to_id, t.alias as to_alias, t.hidden as to_hidden,
          f.alias as from_alias
        from reports r left join guests t on t.id = r.to_id left join guests f on f.id = r.from_id
        where r.event_id = ${ev.id} order by r.created_at desc limit 50`;
      return json({
        ended: false,
        event: { id: ev.id, name: ev.name, startsAt: ev.starts_at, endsAt: ev.ends_at, radius: ev.radius_m, statuses: ev.statuses, qrRequired: ev.qr_required, meetSpot: ev.meet_spot, browseAllowed: ev.browse_allowed },
        stats: { joined: c.joined, here: c.here, browsing: c.browsing, waves: c.waves, matches: Math.floor(c.mutual / 2) },
        reports: reports.map((r: any) => ({ id: r.id, reason: r.reason, at: r.created_at, toId: r.to_id, toAlias: r.to_alias || "(left)", toHidden: !!r.to_hidden, fromAlias: r.from_alias || "(left)" })),
        qr: { svg, joinUrl, shareUrl, rotatesEverySec: ev.qr_required ? QR_WINDOW_MS / 1000 : null },
      });
    }
    return fail("Not found.", 404);
  }

  // Guest endpoints: /api/events/:id[/action]
  if (parts[1] === "events" && parts[2]) {
    const ev = await liveEvent(parts[2]);
    if (!ev) {
      const [s] = await sql`select name from summaries where event_id = ${parts[2]}`;
      return fail(s ? "This event has ended." : "Event not found.", 404, { ended: !!s, name: s?.name });
    }
    const action = parts[3];

    if (method === "GET" && !action) {
      return json({ name: ev.name, startsAt: ev.starts_at, endsAt: ev.ends_at, statuses: ev.statuses, qrRequired: ev.qr_required, radius: ev.radius_m, browseAllowed: ev.browse_allowed });
    }

    if (new Date(ev.starts_at) > new Date())
      return fail("This event hasn't started yet.", 403, { reason: "not_started", startsAt: ev.starts_at });

    if (method === "POST" && action === "join") {
      if (limited("join:" + ipOf(req, server), 30, 600_000)) return fail("Too many attempts. Wait a few minutes and try again.", 429);
      if (body.adult !== true) return fail("Seeker is for adults only. Confirm you're 18 or over to join.");
      if (body.rules !== true) return fail("Agree to the house rules to join.");
      if (body.mode === "browse") {
        if (!ev.browse_allowed) return fail("The host has asked everyone to post a status at this event.");
        if (ev.qr_required && !qrValid(ev, body.code))
          return fail("This event needs on-site check-in. Scan the QR code displayed at the venue.", 403, { reason: "qr" });
        const fenceB = fenceCheck(ev, body.loc);
        if (fenceB) return fenceB;
        const bid = newId(8), btoken = newId(24);
        await sql`insert into guests (id, event_id, token, alias, status, mode, last_inside)
          values (${bid}, ${ev.id}, ${btoken}, '', '', 'browse', now())`;
        return json({ token: btoken, guestId: bid });
      }
      const alias = str(body.alias, 24);
      if (!alias) return fail("Pick a name people will see.");
      const status = str(body.status, 30);
      if (!(ev.statuses as string[]).includes(status)) return fail("Choose one of the event's status options.");
      if (str(body.findMe, 60).length < 3) return fail(FIND_ME_MSG);
      if (ev.qr_required && !qrValid(ev, body.code))
        return fail("This event needs on-site check-in. Scan the QR code displayed at the venue.", 403, { reason: "qr" });
      const fence = fenceCheck(ev, body.loc);
      if (fence) return fence;
      const id = newId(8), token = newId(24);
      await sql`insert into guests (id, event_id, token, alias, status, line, find_me, visibility, last_inside)
        values (${id}, ${ev.id}, ${token}, ${alias}, ${status}, ${str(body.line, 80)}, ${str(body.findMe, 60)},
        ${body.visibility === "match" ? "match" : "all"}, now())`;
      return json({ token, guestId: id });
    }

    const me = await guestFor(ev, req);
    if (!me) return fail("Join the event first.", 401, { reason: "no_guest" });
    if (me.hidden) return fail("The host has removed you from this event.", 403, { reason: "removed" });

    if (method === "POST" && action === "leave") {
      await sql`delete from waves where from_id = ${me.id} or to_id = ${me.id}`;
      await sql`delete from blocks where from_id = ${me.id} or to_id = ${me.id}`;
      await sql`delete from shares where from_id = ${me.id} or to_id = ${me.id}`;
      await sql`delete from guests where id = ${me.id}`;
      return json({ ok: true });
    }

    if (method === "POST" && action === "block") {
      const to = str(body.to, 40);
      if (to && to !== me.id) {
        await sql`insert into blocks (event_id, from_id, to_id) values (${ev.id}, ${me.id}, ${to}) on conflict do nothing`;
        await sql`delete from shares where (from_id = ${me.id} and to_id = ${to}) or (from_id = ${to} and to_id = ${me.id})`;
      }
      return json({ ok: true });
    }

    // Unmatch: take back my wave and everything either of us shared. Works anywhere, any time.
    if (method === "POST" && action === "unwave") {
      const to = str(body.to, 40);
      await sql`delete from waves where from_id = ${me.id} and to_id = ${to}`;
      await sql`delete from shares where (from_id = ${me.id} and to_id = ${to}) or (from_id = ${to} and to_id = ${me.id})`;
      return json({ ok: true });
    }

    if (method === "POST" && action === "report") {
      const to = str(body.to, 40);
      if (!to || to === me.id) return fail("Pick someone to report.");
      const [t] = await sql`select id from guests where id = ${to} and event_id = ${ev.id}`;
      if (!t) return fail("That person has already left.");
      const [dup] = await sql`select id from reports where from_id = ${me.id} and to_id = ${to}`;
      if (!dup) await sql`insert into reports (id, event_id, from_id, to_id, reason) values (${newId(8)}, ${ev.id}, ${me.id}, ${to}, ${str(body.reason, 200)})`;
      await sql`insert into blocks (event_id, from_id, to_id) values (${ev.id}, ${me.id}, ${to}) on conflict do nothing`;
      await sql`delete from shares where (from_id = ${me.id} and to_id = ${to}) or (from_id = ${to} and to_id = ${me.id})`;
      const [n] = await sql`select count(distinct from_id)::int as n from reports where to_id = ${to}`;
      if (n.n >= REPORTS_TO_AUTOHIDE) await sql`update guests set hidden = true where id = ${to}`;
      return json({ ok: true });
    }

    // Everything below shows or changes what's visible, so it needs a fresh in-venue location.
    const fence = fenceCheck(ev, body.loc);
    if (fence) return fence;
    await sql`update guests set last_inside = now() where id = ${me.id}`;

    // Browsing guest posts a status and becomes a normal, visible guest.
    if (method === "POST" && action === "declare") {
      if (me.mode !== "browse") return fail("You already have a status. Use Edit to change it.");
      const alias = str(body.alias, 24);
      if (!alias) return fail("Pick a name people will see.");
      const status = str(body.status, 30);
      if (!(ev.statuses as string[]).includes(status)) return fail("Choose one of the event's status options.");
      if (str(body.findMe, 60).length < 3) return fail(FIND_ME_MSG);
      await sql`update guests set mode = 'declared', alias = ${alias}, status = ${status}, line = ${str(body.line, 80)},
        find_me = ${str(body.findMe, 60)}, visibility = ${body.visibility === "match" ? "match" : "all"} where id = ${me.id}`;
      return json({ ok: true });
    }

    if (me.mode === "browse" && ["me", "share", "beacon", "wave"].includes(action))
      return fail("Post a status first. While you’re looking around, nobody can see you and you can’t wave.", 403, { reason: "browsing" });

    if (method === "POST" && action === "me") {
      const status = str(body.status, 30);
      if (!(ev.statuses as string[]).includes(status)) return fail("Choose one of the event's status options.");
      if (str(body.findMe, 60).length < 3) return fail(FIND_ME_MSG);
      await sql`update guests set status = ${status}, line = ${str(body.line, 80)}, find_me = ${str(body.findMe, 60)},
        visibility = ${body.visibility === "match" ? "match" : "all"} where id = ${me.id}`;
      return json({ ok: true });
    }

    // Share my description with one mutual match. Theirs is only revealed once both have shared.
    if (method === "POST" && action === "share") {
      const to = str(body.to, 40);
      const st = await pairState(ev.id, me.id, to);
      if (!st.mutual) return fail("You can only share with someone you've both waved at.");
      await sql`insert into shares (event_id, from_id, to_id, kind) values (${ev.id}, ${me.id}, ${to}, 'desc') on conflict do nothing`;
      return json({ ok: true, both: st.theyShared });
    }

    // Beacon heartbeat. Colours are only handed out while BOTH phones are holding it up.
    if (method === "POST" && action === "beacon") {
      const to = str(body.to, 40);
      if (limited("beacon:" + me.id, 90, 60_000)) return fail("Slow down a little.", 429);
      const st = await pairState(ev.id, me.id, to);
      if (!st.mutual) {
        await sql`delete from shares where from_id = ${me.id} and to_id = ${to} and kind = 'beacon'`;
        return json({ state: "ended" });
      }
      if (body.on === true) {
        await sql`insert into shares (event_id, from_id, to_id, kind, updated_at) values (${ev.id}, ${me.id}, ${to}, 'beacon', now())
          on conflict (from_id, to_id, kind) do update set updated_at = now()`;
      } else {
        await sql`delete from shares where from_id = ${me.id} and to_id = ${to} and kind = 'beacon'`;
        return json({ state: "off" });
      }
      const both = st.theirBeacon;
      return json({ state: both ? "both" : "waiting", colours: both ? beaconFor(ev.id, me.id, to) : null });
    }

    if (method === "POST" && action === "wave") {
      const to = str(body.to, 40);
      const [t] = await sql`select id from guests where id = ${to} and event_id = ${ev.id} and not hidden and mode = 'declared'`;
      if (!t || to === me.id) return fail("That person isn't here any more.");
      const [blocked] = await sql`select 1 from blocks where (from_id = ${me.id} and to_id = ${to}) or (from_id = ${to} and to_id = ${me.id})`;
      if (blocked) return fail("That person isn't here any more.");
      if (limited("wave:" + me.id, 40, 600_000)) return fail("Slow down a little. Try again in a few minutes.", 429);
      await sql`insert into waves (event_id, from_id, to_id) values (${ev.id}, ${me.id}, ${to}) on conflict do nothing`;
      const [back] = await sql`select 1 from waves where from_id = ${to} and to_id = ${me.id}`;
      return json({ ok: true, mutual: !!back });
    }

    if (method === "POST" && action === "board") {
      const others = await sql`select id, alias, status, line, find_me, visibility from guests
        where event_id = ${ev.id} and not hidden and id <> ${me.id} and mode = 'declared'
        and last_inside > now() - interval '20 minutes'`;
      const [bc] = await sql`select count(*)::int as n from guests where event_id = ${ev.id} and not hidden
        and mode = 'browse' and id <> ${me.id} and last_inside > now() - interval '20 minutes'`;
      const browsing = bc.n;
      if (me.mode === "browse") {
        // Look-only view: what everyone already posts publicly, nothing more.
        const blocksB = await sql`select from_id, to_id from blocks where from_id = ${me.id} or to_id = ${me.id}`;
        const blockedB = new Set(blocksB.map((b: any) => (b.from_id === me.id ? b.to_id : b.from_id)));
        const peopleB = others
          .filter((o: any) => !blockedB.has(o.id) && o.visibility === "all")
          .map((o: any) => ({ id: o.id, alias: o.alias, status: o.status, line: o.line }));
        return json({
          me: { id: me.id, mode: "browse" }, people: peopleB, browsing,
          event: { name: ev.name, endsAt: ev.ends_at, statuses: ev.statuses, meetSpot: ev.meet_spot },
        });
      }
      const blocks = await sql`select from_id, to_id from blocks where from_id = ${me.id} or to_id = ${me.id}`;
      const blocked = new Set(blocks.map((b: any) => (b.from_id === me.id ? b.to_id : b.from_id)));
      const waves = await sql`select from_id, to_id from waves where from_id = ${me.id} or to_id = ${me.id}`;
      const iWaved = new Set(waves.filter((w: any) => w.from_id === me.id).map((w: any) => w.to_id));
      const wavedMe = new Set(waves.filter((w: any) => w.to_id === me.id).map((w: any) => w.from_id));
      const shares = await sql`select from_id, to_id, kind, extract(epoch from (now() - updated_at))::float as age from shares
        where from_id = ${me.id} or to_id = ${me.id}`;
      const shared = (from: string, to: string, kind: string, live = false) =>
        shares.some((r: any) => r.from_id === from && r.to_id === to && r.kind === kind && (!live || r.age <= BEACON_LIVE_SECS));
      const people = others
        .filter((o: any) => !blocked.has(o.id))
        // Discreet mode is symmetric: you only see people who can see you.
        .filter((o: any) => (o.visibility === "all" && me.visibility === "all") || o.status === me.status)
        .map((o: any) => {
          const mutual = iWaved.has(o.id) && wavedMe.has(o.id);
          const bothReady = mutual && shared(me.id, o.id, "desc") && shared(o.id, me.id, "desc");
          return {
            id: o.id, alias: o.alias, status: o.status, line: o.line,
            iWaved: iWaved.has(o.id), wavedMe: wavedMe.has(o.id), mutual,
            iShared: mutual && shared(me.id, o.id, "desc"),
            theyShared: mutual && shared(o.id, me.id, "desc"),
            findMe: bothReady ? o.find_me : "",
            matchWord: bothReady ? matchWordFor(ev.id, me.id, o.id) : "",
            theirBeacon: mutual && shared(o.id, me.id, "beacon", true),
          };
        });
      return json({
        me: { id: me.id, mode: "declared", alias: me.alias, status: me.status, line: me.line, findMe: me.find_me, visibility: me.visibility },
        people, browsing,
        event: { name: ev.name, endsAt: ev.ends_at, statuses: ev.statuses, meetSpot: ev.meet_spot },
      });
    }
  }

  return fail("Not found.", 404);
}

// ---------- server ----------
Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    try {
      cleanup().catch((e) => console.error("cleanup", e));
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname.startsWith("/api/")) return await api(req, url, server);
      if (url.pathname === "/" || url.pathname === "/events" || url.pathname.startsWith("/e/") || url.pathname.startsWith("/h/") || url.pathname.startsWith("/c/"))
        return new Response(PAGE, {
          headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer", "cache-control": "no-store" },
        });
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return fail("Something went wrong on our side. Try again.", 500);
    }
  },
});
console.log("Seeker listening on " + PORT);

// ---------- web app ----------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Seeker</title>
<meta name="description" content="See who's open to talk, only while you're in the room. No sign-up, no payment, nothing stored.">
<meta property="og:title" content="Seeker: see who's open to talk tonight">
<meta property="og:description" content="Wave. Match. Say the word. Only works inside the venue. No sign-up, no payment, deleted when the night ends.">
<meta property="og:type" content="website">
<meta name="theme-color" content="#14111a">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%235a3e16'/%3E%3Ccircle cx='16' cy='16' r='9' fill='%23ffb547'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Figtree:wght@400;500;600;700&display=swap">
<style>
/* Layout: single column, phone-first; a venue-light amber accent on a dim-room ground. */
:root{
  --bg:#f6f3f8; --surface:#ffffff; --raise:#efeaf3; --fg:#1d1824; --muted:#6c6478; --line:#ddd5e4;
  --accent:#c9760a; --accent-ink:#ffffff; --ok:#1f8a5b; --danger:#c23a3a;
  --display:"Bricolage Grotesque", "Arial Narrow", system-ui, sans-serif;
  --body:"Figtree", system-ui, -apple-system, "Segoe UI", sans-serif;
  color-scheme:light;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#14111a; --surface:#1d1925; --raise:#262131; --fg:#f2eef7; --muted:#a59db3; --line:#332c3f;
  --accent:#ffb547; --accent-ink:#1d1308; --ok:#5dd39e; --danger:#ff7a7a; color-scheme:dark;}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0}
body{background:var(--bg);color:var(--fg);font:16px/1.5 var(--body);min-height:100vh;
  padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.wrap{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
h1,h2,h3{font-family:var(--display);margin:0;line-height:1.1;text-wrap:balance}
h1{font-size:clamp(2rem,8vw,2.8rem);font-weight:800;letter-spacing:-.02em}
h2{font-size:1.35rem;font-weight:700}
h3{font-size:1.05rem;font-weight:700}
p{margin:0}
.muted{color:var(--muted)}
.small{font-size:.875rem}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--display);font-weight:800;font-size:1.15rem;letter-spacing:-.01em}
.dot{width:12px;height:12px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 6px color-mix(in srgb,var(--accent) 22%,transparent)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:14px}
label{font-weight:600;font-size:.9rem;display:flex;flex-direction:column;gap:6px}
input[type=text],input[type=datetime-local],select,textarea{font:inherit;color:var(--fg);background:var(--raise);border:1px solid var(--line);border-radius:10px;padding:11px 12px;width:100%}
textarea{min-height:70px;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.check{flex-direction:row;align-items:flex-start;gap:10px;font-weight:500}
.check input{width:20px;height:20px;margin-top:2px;accent-color:var(--accent)}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row>*{flex:1 1 140px;min-width:0}
button{font:inherit;font-weight:700;border:0;border-radius:12px;padding:13px 16px;cursor:pointer;background:var(--accent);color:var(--accent-ink)}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
button.quiet{background:var(--raise);color:var(--fg)}
button.danger{background:transparent;color:var(--danger);border:1px solid color-mix(in srgb,var(--danger) 45%,transparent)}
button.sm{padding:8px 12px;font-size:.875rem;border-radius:10px}
button:disabled{opacity:.55;cursor:default}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:8px 12px;border-radius:999px;background:var(--raise);color:var(--fg);border:1px solid var(--line);font-weight:600;font-size:.9rem}
.chip[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;font-weight:700;padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--hue) 18%,transparent);color:var(--fg)}
.pill::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--hue)}
.person{display:grid;grid-template-columns:1fr auto;gap:8px 12px;padding:14px 0;border-top:1px solid var(--line)}
.person:first-child{border-top:0}
.person .who{min-width:0;display:flex;flex-direction:column;gap:6px}
.person .name{font-weight:700;font-size:1.05rem;overflow-wrap:anywhere}
.person .line{color:var(--muted);overflow-wrap:anywhere}
.person .acts{display:flex;flex-direction:column;gap:6px;align-items:flex-end}
.match{grid-column:1/-1;background:color-mix(in srgb,var(--ok) 14%,transparent);border-radius:10px;padding:12px;font-size:.92rem;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.match .meet{font-size:1rem}
.word{font-family:var(--display);font-size:1.2rem;letter-spacing:.03em}
.prog{height:4px;border-radius:4px;background:var(--raise);overflow:hidden}
.prog i{display:block;height:100%;background:var(--accent);transition:width .3s}
.step{gap:16px;padding:22px 18px}
.q{font-size:1.6rem;line-height:1.15}
.chips.big .chip{padding:12px 16px;font-size:1rem}
.rules{margin:0;padding-left:1.2em;display:grid;gap:6px}
.preview{display:flex;flex-direction:column;gap:6px;align-items:flex-start;background:var(--raise);border-radius:12px;padding:14px}
.preview .name{font-weight:700;font-size:1.1rem}
.preview .line{color:var(--muted)}
.trust{display:flex;flex-wrap:wrap;gap:6px}
.trust span{font-size:.78rem;font-weight:700;padding:4px 10px;border-radius:999px;background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--fg)}
.trust span::before{content:"✓ ";color:var(--ok)}
.help{text-align:left;background:var(--raise);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;font-weight:500;color:var(--fg);width:100%}
.help ol{margin:0;padding-left:1.2em;display:grid;gap:6px;font-size:.9rem}
.help button{align-self:flex-start}
.mrow{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.mrow .small{flex:1 1 160px;min-width:0}
.linkbtn{background:none;border:0;padding:4px 0;color:var(--muted);font-weight:600;font-size:.8rem;text-decoration:underline;cursor:pointer}
.status-bar{display:flex;align-items:center;gap:8px;font-size:.875rem;font-weight:600}
.live{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 25%,transparent)}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.stat{background:var(--raise);border-radius:12px;padding:12px 14px}
.stat b{display:block;font-family:var(--display);font-size:1.8rem;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
.stat span{font-size:.8rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.qr{background:#fff;border-radius:14px;padding:12px;max-width:300px;width:100%;margin:0 auto}
.qr svg{display:block;width:100%;height:auto}
.err{color:var(--danger);font-weight:600;font-size:.92rem}
.note{font-size:.85rem;color:var(--muted)}
.lock{text-align:center;padding:36px 18px;align-items:center}
.lock .ring{width:84px;height:84px;border-radius:50%;border:3px dashed var(--accent);display:grid;place-items:center;font-family:var(--display);font-weight:800;color:var(--accent)}
.empty{color:var(--muted);padding:12px 0}
.copyline{display:flex;gap:8px}
.copyline input{flex:1;min-width:0;font-size:.85rem}
.menu{display:flex;gap:8px;flex-wrap:wrap;grid-column:1/-1}
.report-item{border-top:1px solid var(--line);padding-top:12px;display:flex;flex-direction:column;gap:8px}
.report-item:first-of-type{border-top:0;padding-top:0}
.field{display:flex;flex-direction:column;gap:10px}
.flabel{font-weight:600;font-size:.9rem}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.segbtn{background:var(--raise);color:var(--fg);border:1px solid var(--line);font-weight:600;font-size:.9rem;padding:11px 10px}
.segbtn[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.results{display:flex;flex-direction:column;gap:6px}
.result{background:var(--raise);color:var(--fg);border:1px solid var(--line);font-weight:500;font-size:.9rem;text-align:left;padding:10px 12px}
.map{height:260px;border-radius:12px;border:1px solid var(--line);overflow:hidden;z-index:0;max-width:100%}
.evrow{display:grid;grid-template-columns:1fr auto;gap:8px 12px;padding:14px 0;border-top:1px solid var(--line)}
.evrow:first-child{border-top:0;padding-top:0}
.evrow .who{min-width:0;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.evrow .name{font-weight:700;font-size:1.05rem;overflow-wrap:anywhere}
.evrow .acts{display:flex;flex-direction:column;gap:6px;align-items:flex-end}
.btnlink{display:inline-block;font-weight:700;text-decoration:none;border-radius:10px;padding:8px 14px;background:var(--accent);color:var(--accent-ink);font-size:.875rem}
.warn{color:var(--danger)}
.strong{font-weight:700;color:var(--fg)}
a{color:var(--fg)}
footer{font-size:.8rem;color:var(--muted);text-align:center}
.beacon{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;cursor:pointer}
.beacon i{flex:1;display:block}
.beacon .bcap{position:absolute;left:0;right:0;bottom:0;padding:16px max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:rgba(0,0,0,.72);color:#fff;text-align:center;display:flex;flex-direction:column;gap:6px;font-family:var(--body)}
.beacon .bcap b{font-family:var(--display);font-size:1.3rem}
.beacon .bcap button{align-self:center;background:#fff;color:#111;margin-top:6px}
.beacon.waiting{cursor:default}
.beacon.waiting i{background:#15121b!important;animation:none!important}
@media (prefers-reduced-motion:no-preference){.beacon i{animation:beat 1.2s ease-in-out infinite}@keyframes beat{50%{filter:brightness(.72)}}}
@media (prefers-reduced-motion:no-preference){.dot{animation:pulse 2.4s ease-in-out infinite}@keyframes pulse{50%{box-shadow:0 0 0 10px color-mix(in srgb,var(--accent) 8%,transparent)}}}
</style>
</head>
<body>
<main class="wrap" id="app" aria-live="polite"><p class="muted">Loading…</p></main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<script>
(function(){
var app = document.getElementById("app");
var HUES = ["#e08a1e","#2f9e76","#4a7fd6","#c2468d","#8a63d2","#cf5a3b","#2a9cb3","#7c8a2f"];
var PRESETS = {
  social: ["Single & mingling","Open to chat","Here with friends","Taken"],
  network: ["Hiring","Looking for work","Investing","Open to collaborate","Just networking"]
};
var poll = null, watchId = null, lastLoc = null;

function esc(s){return String(s == null ? "" : s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
function $(sel){return app.querySelector(sel);}
function store(k,v){try{ if(v===undefined) return localStorage.getItem(k); if(v===null) localStorage.removeItem(k); else localStorage.setItem(k,v);}catch(e){return null;}}
function hueFor(statuses, s){var i = statuses.indexOf(s); return HUES[(i<0?0:i) % HUES.length];}
function pill(statuses, s){return '<span class="pill" style="--hue:'+hueFor(statuses,s)+'">'+esc(s)+'</span>';}
function timeLeft(iso){var ms = new Date(iso) - Date.now(); if(ms<=0) return "ending now"; var h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000); return (h? h+"h ":"")+m+"m left";}
function stop(){ if(poll){clearInterval(poll);poll=null;} }

function api(path, opts){
  opts = opts || {};
  var headers = {"content-type":"application/json"};
  if (opts.token) headers["x-guest-token"] = opts.token;
  return fetch(path, {method: opts.body ? "POST" : "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined})
    .then(function(r){ return r.json().catch(function(){return {};}).then(function(d){ d._status = r.status; return d; }); })
    .catch(function(){ return {error:"Can't reach Seeker. Check your connection and try again.", _status:0}; });
}

function locate(){
  return new Promise(function(resolve){
    if (!navigator.geolocation) return resolve({error:"This browser can’t share your location.", help:"denied"});
    navigator.geolocation.getCurrentPosition(function(p){
      lastLoc = {lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy, t:Date.now()};
      resolve(lastLoc);
    }, function(err){
      resolve(err.code === 1 ? {error:"Location is blocked for this page.", help:"denied"} : {error:"We couldn’t get your location.", help:"unavailable"});
    }, {enableHighAccuracy:true, timeout:20000, maximumAge:15000});
  });
}
function watchLoc(){
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(function(p){
    lastLoc = {lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy, t:Date.now()};
  }, function(){}, {enableHighAccuracy:true, maximumAge:15000});
}
/* Step-by-step help for turning location back on. A website has no app settings, so the switch lives in the browser. */
function locHelp(kind){
  var ua = navigator.userAgent || "";
  var inApp = /Instagram|FBAN|FBAV|FB_IAB|musical_ly|Bytedance|TikTok|Snapchat|Twitter|Line\\//i.test(ua);
  var ios = /iPhone|iPad|iPod/.test(ua), android = /Android/.test(ua);
  var steps;
  if (inApp) {
    steps = ['Tap the <b>⋯</b> menu at the top right and choose <b>Open in browser</b> (or Open in Safari / Chrome).',
      'If you can’t see that option, copy the link and paste it into Safari or Chrome.'];
    return '<div class="help"><p class="small">You opened Seeker inside another app (like Instagram or TikTok), which often blocks location. <b>Open it in your browser instead:</b></p><ol>'+steps.map(function(s){return '<li>'+s+'</li>';}).join("")+'</ol><button type="button" class="ghost sm" data-copylink>Copy link</button></div>';
  }
  if (kind === "unavailable") {
    steps = ios ? ['Open the <b>Settings</b> app → <b>Privacy &amp; Security</b> → <b>Location Services</b>, and turn it on.',
                   'In the same list, tap <b>Safari Websites</b> (or your browser) → <b>While Using the App</b>.',
                   'Come back here, step near a window if you’re deep inside, and tap Check again.']
          : ['Swipe down from the top of your screen and turn on <b>Location</b>.',
             'Come back here, step near a window if you’re deep inside, and tap Check again.'];
  } else if (ios) {
    steps = ['Tap <b>aA</b> on the left of the web address at the top or bottom of Safari.',
             'Tap <b>Website Settings</b> → <b>Location</b> → <b>Allow</b>.',
             'Still blocked? Open the <b>Settings</b> app → <b>Privacy &amp; Security</b> → <b>Location Services</b> → <b>Safari Websites</b> → <b>While Using the App</b>.',
             'Come back here and reload the page.'];
  } else if (android) {
    steps = ['Tap the icon on the left of the web address (a lock or two sliders).',
             'Tap <b>Permissions</b> (or Site settings) → <b>Location</b> → <b>Allow</b>.',
             'Still blocked? Swipe down from the top and turn on <b>Location</b>, or go to <b>Settings</b> → <b>Apps</b> → <b>Chrome</b> → <b>Permissions</b> → <b>Location</b> → <b>Allow</b>.',
             'Come back here and reload the page.'];
  } else {
    steps = ['Click the icon on the left of the web address and set <b>Location</b> to <b>Allow</b>.',
             'Then reload the page.'];
  }
  return '<div class="help"><p class="small"><b>How to turn it on:</b></p><ol>'+steps.map(function(s){return '<li>'+s+'</li>';}).join("")+'</ol></div>';
}
function showLocErr(el, e, fallback){
  if (e && typeof e === "object" && e.error) { el.innerHTML = esc(e.error)+(e.help ? locHelp(e.help) : ""); }
  else el.textContent = typeof e === "string" ? e : fallback;
  el.hidden = false;
}
document.addEventListener("click", function(e){
  var b = e.target.closest && e.target.closest("[data-copylink]");
  if (!b) return;
  var url = location.href;
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function(){ b.textContent = "Link copied"; }, function(){ window.prompt("Copy this link:", url); });
});
function freshLoc(){ return (lastLoc && Date.now()-lastLoc.t < 45000) ? Promise.resolve(lastLoc) : locate(); }

/* ---------------- Hosted events on this device ---------------- */
function hostList(){
  try{
    var l = JSON.parse(store("seeker:hostlist") || "[]"); if (!Array.isArray(l)) l = [];
    var legacy = store("seeker:hosted");
    if (legacy) {
      var m = legacy.match(/\\/h\\/([A-Za-z0-9_-]+)\\?k=([A-Za-z0-9_-]+)/);
      if (m && !l.some(function(x){return x.id===m[1];})) l.unshift({id:m[1], k:m[2], name:""});
      store("seeker:hosted", null); store("seeker:hostlist", JSON.stringify(l));
    }
    return l;
  }catch(e){ return []; }
}
function saveHosts(l){ store("seeker:hostlist", JSON.stringify(l.slice(0,50))); }
function addHost(e){ var l = hostList().filter(function(x){return x.id!==e.id;}); l.unshift(e); saveHosts(l); }
function ensureHost(e){ var l = hostList(), f = l.filter(function(x){return x.id===e.id;})[0]; if (!f) addHost(e); else if (e.name && f.name!==e.name){ f.name=e.name; saveHosts(l); } }
function hostLink(e){ return "/h/"+e.id+"?k="+e.k; }
function fmtWhen(iso){ try{ return new Date(iso).toLocaleString([], {weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit"}); }catch(e){ return String(iso); } }
function timeUntil(iso){ var ms = new Date(iso) - Date.now(); if (ms<=0) return "now"; var d=Math.floor(ms/86400000), h=Math.floor((ms%86400000)/3600000), m=Math.floor((ms%3600000)/60000); return (d? d+"d ":"")+(h? h+"h ":"")+m+"m"; }
function go(path){ history.pushState(null, "", path); route(); }

/* ---------------- Landing / create ---------------- */
var map = null, pin = null, circle = null, venue = null;
function landing(){
  stop();
  if (map) { try{ map.remove(); }catch(e){} } map = null; pin = null; circle = null; venue = null;
  var n = hostList().length;
  app.innerHTML =
    '<div class="brand"><span class="dot"></span>Seeker</div>'+
    '<h1>See who\\'s open to talk, only while you\\'re in the room.</h1>'+
    '<p class="muted">Pin your venue, share the code, and guests post a status that only people inside the area can see. When the event ends, everything is deleted.</p>'+
    (n || store("seeker:creator") ? '<a class="small strong" href="/events" data-nav>My events'+(n ? ' ('+n+')' : '')+' →</a>' : '')+
    '<form class="card" id="create" novalidate>'+
      '<h2>Host an event</h2>'+
      '<label for="ev-name">Event name<input type="text" id="ev-name" maxlength="60" placeholder="Friday singles night, Chatham" required></label>'+
      '<div class="field"><p class="flabel">Venue</p>'+
        '<div class="seg" role="group" aria-label="How to set the venue">'+
          '<button type="button" class="segbtn" id="v-here" aria-pressed="false">I\\'m at the venue</button>'+
          '<button type="button" class="segbtn" id="v-search" aria-pressed="false">Search address or postcode</button>'+
        '</div>'+
        '<div id="v-searchbox" class="field" hidden><div class="copyline"><input type="text" id="v-q" maxlength="120" placeholder="Postcode, or club name and town" aria-label="Address or postcode"><button type="button" class="quiet sm" id="v-go">Search</button></div><div id="v-results" class="results"></div></div>'+
        '<div id="v-map" class="map" hidden></div>'+
        '<p class="note" id="v-status">Use your location if you\\'re there now, or search to set it up from anywhere.</p>'+
      '</div>'+
      '<label for="ev-preset">Type of event<select id="ev-preset"><option value="social">Social or singles night</option><option value="network">Networking or conference</option><option value="custom">Custom statuses</option></select></label>'+
      '<label for="ev-statuses">Status options <span class="note">One per line, 2 to 8</span><textarea id="ev-statuses"></textarea></label>'+
      '<label for="ev-meet">Meeting point <span class="note">Optional. Where guests who both wave can meet up.</span><input type="text" id="ev-meet" maxlength="80" placeholder="The Seeker sign by the main bar"></label>'+
      '<div class="row">'+
        '<label for="ev-radius">Area radius<select id="ev-radius"><option value="50">50 m (one room)</option><option value="100" selected>100 m (a venue)</option><option value="200">200 m (large venue)</option><option value="400">400 m (festival site)</option></select></label>'+
        '<label for="ev-hours">Runs for<select id="ev-hours"><option value="2">2 hours</option><option value="4" selected>4 hours</option><option value="6">6 hours</option><option value="8">8 hours</option><option value="12">12 hours</option></select></label>'+
      '</div>'+
      '<div class="row">'+
        '<label for="ev-start">Starts<select id="ev-start"><option value="now">Now</option><option value="later">At a set time</option></select></label>'+
        '<label for="ev-when" id="ev-when-wrap" hidden>Date and time<input type="datetime-local" id="ev-when"></label>'+
      '</div>'+
      '<label class="check" for="ev-browse"><input type="checkbox" id="ev-browse" checked><span>Let guests look around first<br><span class="note">Guests can see the board before posting a status. They stay invisible and can’t wave until they post one. Everyone sees how many people are looking.</span></span></label>'+
      '<label class="check" for="ev-qr"><input type="checkbox" id="ev-qr"><span>Require on-site QR check-in<br><span class="note">Guests must scan a code you display at the venue. It changes every 2 minutes, so a screenshot shared outside stops working.</span></span></label>'+
      '<p class="err" id="create-err" hidden></p>'+
      '<button type="submit" id="create-btn">Create event</button>'+
    '</form>'+
    '<div class="card"><h3>How it stays safe</h3>'+
      '<p class="small muted">Only works inside the area. Adults only. No open messaging, just waves. Block and report go straight to the host, and three reports hide someone automatically. Guest locations are checked, never stored.</p></div>'+
    '<footer>Seeker · Made in Kent, UK · Free while in early access</footer>';

  var preset = $("#ev-preset"), ta = $("#ev-statuses"), status = $("#v-status");
  function fill(){ if (preset.value !== "custom") ta.value = PRESETS[preset.value].join("\\n"); }
  preset.addEventListener("change", fill); fill();
  function radius(){ return Number($("#ev-radius").value); }
  $("#ev-radius").addEventListener("change", function(){ if (circle) circle.setRadius(radius()); });
  $("#ev-start").addEventListener("change", function(){ $("#ev-when-wrap").hidden = this.value !== "later"; });
  function mode(which){ $("#v-here").setAttribute("aria-pressed", String(which==="here")); $("#v-search").setAttribute("aria-pressed", String(which==="search")); $("#v-searchbox").hidden = which !== "search"; }

  function showMap(lat, lng, label){
    venue = {lat:lat, lng:lng};
    var el = $("#v-map"); el.hidden = false;
    if (!window.L) { el.hidden = true; status.textContent = "Venue set"+(label? ": "+label : "")+". The map didn\\'t load, so the pin can\\'t be adjusted."; return; }
    if (!map) {
      map = L.map(el, {scrollWheelZoom:false});
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19, attribution:"© OpenStreetMap contributors"}).addTo(map);
      pin = L.marker([lat,lng], {draggable:true, keyboard:true, title:"Venue"}).addTo(map);
      circle = L.circle([lat,lng], {radius:radius(), color:"#e08a1e", weight:2, fillOpacity:.12}).addTo(map);
      function moveTo(p){ pin.setLatLng(p); circle.setLatLng(p); venue = {lat:p.lat, lng:p.lng}; }
      pin.on("dragend", function(){ moveTo(pin.getLatLng()); });
      map.on("click", function(e){ moveTo(e.latlng); });
    } else { pin.setLatLng([lat,lng]); circle.setLatLng([lat,lng]); }
    map.setView([lat,lng], 17);
    setTimeout(function(){ map.invalidateSize(); }, 60);
    status.textContent = (label ? label+". " : "")+"Drag the pin or tap the map to put it on the venue. The circle is the area where Seeker works.";
  }

  $("#v-here").onclick = function(){
    mode("here"); status.textContent = "Getting your location…";
    locate().then(function(loc){
      if (loc.error) { status.textContent = loc.error+" Or search for the address instead."; return; }
      showMap(loc.lat, loc.lng, loc.acc > 100 ? "Your location is rough indoors (±"+Math.round(loc.acc)+" m), so check the pin" : "");
    });
  };
  $("#v-search").onclick = function(){ mode("search"); $("#v-q").focus(); };
  function search(){
    var q = $("#v-q").value.trim(), box = $("#v-results");
    if (q.length < 3) { box.innerHTML = '<p class="err">Type at least 3 characters.</p>'; return; }
    box.innerHTML = '<p class="note">Searching…</p>';
    api("/api/geocode?q="+encodeURIComponent(q)).then(function(d){
      if (d.error) { box.innerHTML = '<p class="err">'+esc(d.error)+'</p>'; return; }
      if (!d.results.length) { box.innerHTML = '<p class="note">No matches. Try the postcode, or the venue name with the town.</p>'; return; }
      box.innerHTML = d.results.map(function(r,i){ return '<button type="button" class="result" data-i="'+i+'">'+esc(r.name)+'</button>'; }).join("");
      box.querySelectorAll("[data-i]").forEach(function(b){ b.onclick = function(){ var r = d.results[Number(b.getAttribute("data-i"))]; box.innerHTML = ""; showMap(r.lat, r.lng, r.name.split(",").slice(0,2).join(",")); }; });
    });
  }
  $("#v-go").onclick = search;
  $("#v-q").addEventListener("keydown", function(e){ if (e.key === "Enter") { e.preventDefault(); search(); } });

  $("#create").addEventListener("submit", function(e){
    e.preventDefault();
    var btn = $("#create-btn"), err = $("#create-err");
    err.hidden = true;
    function show(msg){ err.textContent = msg; err.hidden = false; }
    if (!$("#ev-name").value.trim()) return show("Give the event a name.");
    if (!venue) return show("Set the venue first: use your location or search for the address.");
    var startsAt = null;
    if ($("#ev-start").value === "later") {
      var v = $("#ev-when").value; if (!v) return show("Pick the date and time the event starts.");
      var t = new Date(v); if (isNaN(t)) return show("That start time isn\\'t valid.");
      startsAt = t.toISOString();
    }
    btn.disabled = true; btn.textContent = "Creating…";
    api("/api/events", {body:{
      name: $("#ev-name").value, loc: {lat:venue.lat, lng:venue.lng, acc:10, source:"map"}, radius: radius(), hours: Number($("#ev-hours").value),
      statuses: ta.value.split("\\n"), qrRequired: $("#ev-qr").checked, startsAt: startsAt, meetSpot: $("#ev-meet").value, browseAllowed: $("#ev-browse").checked,
      creatorKey: store("seeker:creator") || ""
    }}).then(function(d){
      if (d.error) { show(d.error); btn.disabled = false; btn.textContent = "Create event"; return; }
      if (d.creatorKey) store("seeker:creator", d.creatorKey);
      addHost({id:d.id, k:d.hostKey, name:d.name});
      go(hostLink({id:d.id, k:d.hostKey}));
    });
  });
}

/* ---------------- My events ---------------- */
function eventsPage(){
  stop();
  var confirmReset = false, claimed = false;
  app.innerHTML =
    '<div class="brand"><span class="dot"></span>Seeker</div>'+
    '<div><h1>My events</h1><p class="muted">Every event you\\'ve created, live, coming up and finished.</p></div>'+
    '<div class="card" id="ev-list"><p class="muted">Loading…</p></div>'+
    '<button type="button" id="new-ev">Host a new event</button>'+
    '<div class="card" id="ck-card" hidden></div>';
  $("#new-ev").onclick = function(){ go("/"); };
  function creatorCard(){
    var ck = store("seeker:creator"), card = $("#ck-card");
    if (!card) return;
    if (!ck) { card.hidden = true; return; }
    card.hidden = false;
    card.innerHTML = '<h3>Your creator link</h3>'+
      '<p class="small muted">Open it on any phone or laptop to see all your events here. Save it somewhere safe, like your notes or an email to yourself. Anyone with it can manage your events, so don\\'t share it.</p>'+
      '<div class="copyline"><input type="text" id="ck-link" readonly value="'+esc(location.origin+"/c/"+ck)+'" aria-label="Creator link"><button type="button" class="quiet sm" id="ck-copy">Copy</button></div>'+
      '<button type="button" class="linkbtn" id="ck-reset">'+(confirmReset ? 'Tap again to reset. Your old link will stop working.' : 'Reset my creator link')+'</button>';
    $("#ck-copy").onclick = function(){ var inp=$("#ck-link"), b=$("#ck-copy"); (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(function(){ b.textContent="Copied"; }, function(){ inp.select(); }); };
    $("#ck-reset").onclick = function(){
      if (!confirmReset) { confirmReset = true; creatorCard(); return; }
      confirmReset = false;
      api("/api/creator/"+encodeURIComponent(ck)+"/reset", {body:{}}).then(function(d){ if (d.creatorKey) store("seeker:creator", d.creatorKey); creatorCard(); });
    };
  }
  function render(list){
    var box = $("#ev-list"); if (!box) return;
    if (!list.length) { box.innerHTML = '<p class="empty">No events yet. Create one and it will show up here.</p>'; return; }
    var order = {live:0, upcoming:1, ended:2};
    list.sort(function(a,b){ return (order[a.state]-order[b.state]) || (a.state==="ended" ? new Date(b.endsAt) - new Date(a.endsAt) : new Date(a.startsAt||0) - new Date(b.startsAt||0)); });
    box.innerHTML = list.map(function(s){
      var badge = s.state==="live" ? '<span class="pill" style="--hue:var(--ok)">Live</span>'
        : s.state==="upcoming" ? '<span class="pill" style="--hue:var(--accent)">Starts '+esc(fmtWhen(s.startsAt))+'</span>'
        : '<span class="pill" style="--hue:var(--muted)">Ended</span>';
      var meta = s.state==="live" ? s.here+' in the room · '+s.joined+' joined'+(s.reports? ' · <b class="warn">'+s.reports+' report'+(s.reports>1?'s':'')+'</b>':'')+' · '+timeLeft(s.endsAt)
        : s.state==="upcoming" ? 'Opens in '+timeUntil(s.startsAt)
        : s.joined+' joined · ended '+esc(fmtWhen(s.endsAt));
      return '<div class="evrow"><div class="who"><span class="name">'+esc(s.name || "Event")+'</span>'+badge+'<span class="small muted">'+meta+'</span></div>'+
        '<div class="acts"><a class="btnlink sm" href="'+esc(hostLink({id:s.id, k:s.k}))+'" data-nav>'+(s.state==="ended"?"Report":"Open")+'</a></div></div>';
    }).join("");
  }
  function fetchList(){
    var ck = store("seeker:creator");
    if (!ck) { render([]); creatorCard(); return; }
    api("/api/creator/"+encodeURIComponent(ck)).then(function(d){
      var box = $("#ev-list"); if (!box) return;
      if (d.reason === "bad_creator") { store("seeker:creator", null); box.innerHTML = '<p class="err">'+esc(d.error)+'</p>'; creatorCard(); return; }
      if (d.error) { box.innerHTML = '<p class="err">'+esc(d.error)+'</p>'; return; }
      (d.events||[]).forEach(function(s){ ensureHost({id:s.id, k:s.k, name:s.name}); });
      render(d.events || []); creatorCard();
    });
  }
  function load(){
    var l = hostList();
    if (!claimed && l.length) {
      claimed = true;
      api("/api/creator/claim", {body:{creatorKey: store("seeker:creator") || "", events: l.map(function(x){ return {id:x.id, k:x.k}; })}}).then(function(d){
        if (d.creatorKey) store("seeker:creator", d.creatorKey);
        fetchList();
      });
      return;
    }
    fetchList();
  }
  load(); poll = setInterval(load, 30000);
}

/* ---------------- Host dashboard ---------------- */
function host(id, k){
  stop();
  var confirmEnd = false;
  function load(){
    api("/api/host/"+encodeURIComponent(id)+"?k="+encodeURIComponent(k)).then(function(d){
      if (d.error) { stop(); app.innerHTML = '<div class="brand"><span class="dot"></span>Seeker</div><div class="card"><h2>Can\\'t open this event</h2><p class="muted">'+esc(d.error)+'</p><button type="button" id="home">Host a new event</button></div>'; $("#home").onclick=goHome; return; }
      if (d.ended) { stop(); return hostSummary(d.summary); }
      renderHost(d);
    });
  }
  function renderHost(d){
    var ev = d.event, s = d.stats;
    ensureHost({id:id, k:k, name:ev.name});
    var active = document.activeElement && document.activeElement.id;
    var reports = d.reports.length ? d.reports.map(function(r){
      return '<div class="report-item"><p><b>'+esc(r.toAlias)+'</b> reported by '+esc(r.fromAlias)+'</p>'+
        (r.reason ? '<p class="small muted">“'+esc(r.reason)+'”</p>' : '')+
        '<div class="row">'+(r.toHidden ? '<p class="small muted">Removed from the board</p>' : '<button type="button" class="danger sm" data-remove="'+esc(r.toId)+'">Remove '+esc(r.toAlias)+'</button>')+
        '<button type="button" class="ghost sm" data-dismiss="'+esc(r.id)+'">Dismiss</button></div></div>';
    }).join("") : '<p class="empty">No reports. Anything guests report shows up here.</p>';
    app.innerHTML =
      '<div class="brand"><span class="dot"></span>Seeker · Host</div>'+
      '<a class="small" href="/events" data-nav>← All my events</a>'+
      '<div><h1>'+esc(ev.name)+'</h1><p class="muted">'+(new Date(ev.startsAt) > Date.now() ? 'Starts '+esc(fmtWhen(ev.startsAt))+' (in '+timeUntil(ev.startsAt)+') · ' : timeLeft(ev.endsAt)+' · ')+ev.radius+' m area</p></div>'+
      '<div class="card"><h2>'+(ev.qrRequired ? 'Display this at the entrance' : 'Let guests scan in')+'</h2>'+
        '<div class="qr">'+d.qr.svg+'</div>'+
        (ev.qrRequired ? '<p class="note">This code changes every 2 minutes. Keep this screen open where guests can scan it.</p>' :
          '<div class="copyline"><input type="text" id="share" readonly value="'+esc(d.qr.shareUrl)+'" aria-label="Guest link"><button type="button" class="quiet sm" id="copy">Copy guest link</button></div><p class="note">This is the link guests use, the same as the QR. Share it freely.</p>')+
      '</div>'+
      '<div class="stats">'+
        '<div class="stat"><b>'+s.here+'</b><span>In the room now</span></div>'+
        '<div class="stat"><b>'+s.joined+'</b><span>Joined</span></div>'+
        '<div class="stat"><b>'+s.waves+'</b><span>Waves sent</span></div>'+
        '<div class="stat"><b>'+s.matches+'</b><span>Mutual waves</span></div>'+
      '</div>'+
      (ev.browseAllowed ? '<p class="note">'+(s.browsing===1 ? '1 person is' : s.browsing+' people are')+' looking around without a status right now.</p>' : '')+
      '<div class="card"><h2>Reports</h2>'+reports+'</div>'+
      (ev.meetSpot ? '<div class="card"><h3>Meeting point</h3><p class="muted">'+esc(ev.meetSpot)+'</p><p class="note">Guests who both wave are sent here. Put a sign up so they can find it.</p></div>' : '')+
      '<div class="card"><h3>Statuses at this event</h3><div class="chips">'+ev.statuses.map(function(x){return pill(ev.statuses,x);}).join("")+'</div></div>'+
      '<div class="card"><h3>End the event</h3><p class="small muted">Deletes every guest, status, wave and report now. You keep the totals for your records.</p>'+
        (confirmEnd ? '<div class="row"><button type="button" class="danger" id="end-yes">Yes, end and delete</button><button type="button" class="ghost" id="end-no">Keep it running</button></div>' : '<button type="button" class="danger" id="end">End event now</button>')+
      '</div>'+
      '<p class="note">Find this event again any time in <a href="/events" data-nav>My events</a>. On another phone, open your creator link (it’s on the My events page).</p>';
    var copy = $("#copy");
    if (copy) copy.onclick = function(){ var inp=$("#share"); (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(function(){copy.textContent="Copied";}, function(){inp.select();}); };
    app.querySelectorAll("[data-remove]").forEach(function(b){ b.onclick=function(){ b.disabled=true; api("/api/host/"+id+"/remove?k="+encodeURIComponent(k),{body:{guestId:b.getAttribute("data-remove")}}).then(load); }; });
    app.querySelectorAll("[data-dismiss]").forEach(function(b){ b.onclick=function(){ b.disabled=true; api("/api/host/"+id+"/dismiss?k="+encodeURIComponent(k),{body:{reportId:b.getAttribute("data-dismiss")}}).then(load); }; });
    var end = $("#end"); if (end) end.onclick=function(){ confirmEnd=true; renderHost(d); };
    var no = $("#end-no"); if (no) no.onclick=function(){ confirmEnd=false; renderHost(d); };
    var yes = $("#end-yes"); if (yes) yes.onclick=function(){ yes.disabled=true; api("/api/host/"+id+"/end?k="+encodeURIComponent(k),{body:{}}).then(load); };
    if (active && document.getElementById(active)) document.getElementById(active).focus();
  }
  load(); poll = setInterval(load, 20000);
}
function hostSummary(s){
  app.innerHTML =
    '<div class="brand"><span class="dot"></span>Seeker · Event report</div>'+
    '<div><h1>'+esc(s.name)+'</h1><p class="muted">Ended '+new Date(s.endedAt).toLocaleString()+'. All guest data has been deleted.</p></div>'+
    '<div class="stats">'+
      '<div class="stat"><b>'+s.joined+'</b><span>Guests joined</span></div>'+
      '<div class="stat"><b>'+s.waves+'</b><span>Waves sent</span></div>'+
      '<div class="stat"><b>'+s.matches+'</b><span>Mutual waves</span></div>'+
      '<div class="stat"><b>'+s.reports+'</b><span>Reports</span></div>'+
    '</div>'+
    '<p class="note">These totals stay available on this link for 90 days.</p>'+
    '<button type="button" id="home">Host another event</button>';
  $("#home").onclick = goHome;
}
function goHome(){ go("/"); }

/* ---------------- Guest ---------------- */
function guest(id, code){
  stop();
  var tokenKey = "seeker:g:"+id, ev = null;
  if (code) store("seeker:c:"+id, code);
  api("/api/events/"+encodeURIComponent(id)).then(function(d){
    if (d.error) return ended(d);
    ev = d;
    start();
  });
  function start(){
    if (new Date(ev.startsAt) > Date.now()) return notStarted();
    if (store(tokenKey)) board(); else joinForm();
  }
  function notStarted(){
    stop();
    app.innerHTML =
      '<div class="brand"><span class="dot"></span>Seeker</div>'+
      '<div class="card lock"><div class="ring">SOON</div><h2>'+esc(ev.name)+'</h2>'+
      '<p class="muted">Starts '+esc(fmtWhen(ev.startsAt))+', in '+timeUntil(ev.startsAt)+'.</p>'+
      '<p class="note">Keep this page open or come back when you\\'re at the venue. It opens by itself.</p></div>';
    poll = setInterval(function(){
      if (new Date(ev.startsAt) <= Date.now()) { stop(); start(); return; }
      var p = app.querySelector(".lock .muted"); if (p) p.textContent = "Starts "+fmtWhen(ev.startsAt)+", in "+timeUntil(ev.startsAt)+".";
    }, 30000);
  }

  /* Join as a journey: one question per screen, ending with a preview. mode "join" or "declare" (a looker posting a status). */
  function journey(mode){
    var a = {alias:"", status:ev.statuses[0], line:"", findMe:"", vis:"all"};
    var steps = (mode==="join" ? ["rules"] : []).concat(["alias","status","line","findMe","vis","go"]), i = 0;
    var Q = {
      alias:["What should people call you tonight?","A first name or a nickname. A little mystery is allowed."],
      status:["What’s your status tonight?","Only people inside the venue can see it. You can change it any time."],
      line:["Say one thing about you.","Optional. One line to make someone curious."],
      findMe:["How will your match spot you?","What you’re wearing or where you’ll be. Nobody sees this until you match and you’re both ready to meet."],
      vis:["Who can see you?","You can change this later."],
      go:["Ready to go live?","This is how you’ll appear. We check you’re inside the venue first. Your location is never stored."]
    };
    function draw(err){
      var k = steps[i], body = "", n = steps.length;
      if (k==="rules") body =
        (ev.qrRequired && !store("seeker:c:"+id) ? '<p class="small muted">This event needs on-site check-in. Scan the QR code the host is displaying.</p>' : '')+
        '<div class="trust"><span>No sign-up</span><span>No payment</span><span>No phone number</span><span>Deleted when the night ends</span></div>'+
        '<h2 class="q">Before you step in</h2><ol class="small rules">'+
        '<li><b>No means no.</b> An unmatch or a block is final. Leave that person alone.</li><li><b>No photos</b> of other guests or their screens.</li>'+
        '<li><b>Staff can remove you</b> from the app and from the venue.</li><li><b>18+ only.</b></li></ol>'+
        '<label class="check" for="j-ok"><input type="checkbox" id="j-ok"><span>I’m 18 or over and I agree to the house rules</span></label>';
      else {
        body = '<h2 class="q">'+Q[k][0]+'</h2>';
        if (k==="alias") body += '<input type="text" id="j-in" maxlength="24" placeholder="First name or nickname" value="'+esc(a.alias)+'">';
        if (k==="line") body += '<input type="text" id="j-in" maxlength="80" placeholder="Ask me about my dog" value="'+esc(a.line)+'">';
        if (k==="findMe") body += '<input type="text" id="j-in" maxlength="60" placeholder="Green jacket, near the bar" value="'+esc(a.findMe)+'">';
        if (k==="status") body += '<div class="chips big">'+ev.statuses.map(function(s){return '<button type="button" class="chip" aria-pressed="'+(s===a.status)+'" data-s="'+esc(s)+'">'+esc(s)+'</button>';}).join("")+'</div>';
        if (k==="vis") body += '<div class="chips big"><button type="button" class="chip" aria-pressed="'+(a.vis==="all")+'" data-v="all">Everyone in the room</button><button type="button" class="chip" aria-pressed="'+(a.vis==="match")+'" data-v="match">Only people with my status</button></div>';
        if (k==="go") body += '<div class="preview"><span class="name">'+esc(a.alias)+'</span>'+pill(ev.statuses,a.status)+(a.line?'<span class="line">'+esc(a.line)+'</span>':'')+(a.vis==="match"?'<span class="note">Discreet mode on</span>':'')+'</div>';
        body += '<p class="note">'+Q[k][1]+'</p>';
      }
      app.innerHTML =
        '<div class="brand"><span class="dot"></span>Seeker</div>'+
        '<div class="small muted">'+esc(ev.name)+' · '+timeLeft(ev.endsAt)+'</div>'+
        '<div class="prog" aria-hidden="true"><i style="width:'+Math.round((i+1)/n*100)+'%"></i></div>'+
        '<form class="card step" id="jf" novalidate>'+body+
        '<p class="err" id="j-err"'+(err?'':' hidden')+'>'+(err?esc(err):'')+'</p>'+
        '<button type="submit" id="j-next">'+(k==="rules"?"Let’s go":k==="go"?"Check my location and join":k==="line"&&!a.line?"Skip":"Next")+'</button>'+
        (k==="rules" && ev.browseAllowed ? '<button type="button" class="ghost" id="j-look">Just look around first</button><p class="note">Look around and nobody sees you. You can’t wave until you post a status.</p>' : '')+
        (i>0 || mode==="declare" ? '<button type="button" class="linkbtn" id="j-back">'+(i>0?"Back":"Keep looking")+'</button>' : '')+
        '</form>';
      var inp = $("#j-in"); if (inp) { inp.focus(); inp.oninput=function(){ $("#j-err").hidden=true; if (k==="line") $("#j-next").textContent = inp.value.trim() ? "Next" : "Skip"; }; }
      app.querySelectorAll("[data-s]").forEach(function(c){ c.onclick=function(){ a.status=c.getAttribute("data-s"); i++; draw(); }; });
      app.querySelectorAll("[data-v]").forEach(function(c){ c.onclick=function(){ a.vis=c.getAttribute("data-v"); i++; draw(); }; });
      var bk = $("#j-back"); if (bk) bk.onclick=function(){ if (i>0) { i--; draw(); } else { editing=false; refresh(); } };
      var lk = $("#j-look"); if (lk) lk.onclick=function(){
        if (!$("#j-ok").checked) return draw("Tick the box to agree to the house rules first.");
        lk.disabled=true; lk.textContent="Checking your location…";
        locate().then(function(loc){ if (loc.error) throw loc;
          return api("/api/events/"+id+"/join",{body:{mode:"browse",adult:true,rules:true,loc:loc,code:store("seeker:c:"+id)}});
        }).then(function(d){ if (d.error) throw d.error; store(tokenKey, d.token); board(); })
        .catch(function(e){ showLocErr($("#j-err"), e, "Something went wrong. Try again."); lk.disabled=false; lk.textContent="Just look around first"; });
      };
      $("#jf").addEventListener("submit", function(e){
        e.preventDefault();
        if (k==="rules" && !$("#j-ok").checked) return draw("Tick the box to agree to the house rules first.");
        if (inp) a[k] = inp.value.trim();
        if (k==="alias" && !a.alias) return draw("Pick a name people will see.");
        if (k==="findMe" && a.findMe.length < 3) return draw("Add how people can find you, like what you’re wearing or where you’re standing.");
        if (k!=="go") { i++; return draw(); }
        var btn=$("#j-next"); btn.disabled=true; btn.textContent="Checking your location…";
        var body = {alias:a.alias,status:a.status,line:a.line,findMe:a.findMe,visibility:a.vis};
        (mode==="join" ? locate() : freshLoc()).then(function(loc){ if (loc.error) throw loc;
          body.loc = loc;
          if (mode==="join") { body.adult=true; body.rules=true; body.code=store("seeker:c:"+id); }
          return api("/api/events/"+id+"/"+(mode==="join"?"join":"declare"), mode==="join" ? {body:body} : {token:store(tokenKey),body:body});
        }).then(function(d){
          if (d.error) throw d.error;
          if (mode==="join") { store(tokenKey, d.token); flash="You’re live. Wave at someone you like the look of."; board(); }
          else { editing=false; flash="You’re on the board now."; refresh(); }
        }).catch(function(e){ showLocErr($("#j-err"), e, "Something went wrong. Try again."); btn.disabled=false; btn.textContent="Check my location and join"; });
      });
    }
    draw();
  }
  function joinForm(){ journey("join"); }

  var editing = false, openMenu = null, flash = "", confirmUnmatch = null;
  function board(){
    watchLoc();
    refresh(); poll = setInterval(function(){ if(!editing) refresh(); }, 15000);
  }
  function refresh(){
    freshLoc().then(function(loc){
      if (loc.error) return locked(loc.error, "no_location", loc.help);
      return api("/api/events/"+id+"/board",{token:store(tokenKey),body:{loc:loc}}).then(function(d){
        if (d._status===404) { stop(); return ended(d); }
        if (d.reason==="no_guest" || d.reason==="removed") {
          store(tokenKey,null);
          if (d.reason==="removed") { stop(); app.innerHTML='<div class="brand"><span class="dot"></span>Seeker</div><div class="card lock"><h2>You\\'ve been removed</h2><p class="muted">The host has removed you from this event.</p></div>'; return; }
          return joinForm();
        }
        if (d.error) return locked(d.error, d.reason);
        renderBoard(d);
      });
    });
  }
  function locked(msg, reason, help){
    app.innerHTML =
      '<div class="brand"><span class="dot"></span>Seeker</div>'+
      '<div class="card lock"><div class="ring">'+(reason==="outside"?"OUT":"?")+'</div><h2>'+(reason==="outside"?"You\\'ve left the area":"Location needed")+'</h2>'+
      '<p class="muted">'+esc(msg)+'</p>'+(help ? locHelp(help) : '')+'<button type="button" id="retry">Check again</button>'+
      '<button type="button" class="linkbtn" id="leave">Leave this event</button></div>';
    $("#retry").onclick=function(){ lastLoc=null; refresh(); };
    $("#leave").onclick=leave;
  }
  function leave(){
    api("/api/events/"+id+"/leave",{token:store(tokenKey),body:{}}).then(function(){ store(tokenKey,null); stop(); joinForm(); });
  }
  function renderBoard(d){
    if (d.me.mode === "browse") return renderBrowse(d);
    var me = d.me, st = d.event.statuses;
    var people = d.people.slice().sort(function(a,b){ return (b.mutual-a.mutual)||(b.wavedMe-a.wavedMe)||a.alias.localeCompare(b.alias); });
    var list = people.length ? people.map(function(p){
      var act = p.mutual ? '<span class="small" style="color:var(--ok);font-weight:700">Both waved</span>'
        : p.iWaved ? '<button type="button" class="quiet sm" disabled>Waved</button>'
        : '<button type="button" class="sm" data-wave="'+esc(p.id)+'">'+(p.wavedMe?"Wave back":"Wave")+'</button>';
      return '<div class="person"><div class="who"><span class="name">'+esc(p.alias)+'</span>'+pill(st,p.status)+
        (p.line?'<span class="line">'+esc(p.line)+'</span>':'')+
        (p.wavedMe && !p.mutual ? '<span class="small" style="color:var(--accent);font-weight:700">Waved at you</span>':'')+
        '</div><div class="acts">'+act+'<button type="button" class="linkbtn" data-menu="'+esc(p.id)+'">More</button></div>'+
        (p.mutual ? matchCard(p, d.event.meetSpot) : '')+
        (openMenu===p.id ? '<div class="menu"><button type="button" class="ghost sm" data-block="'+esc(p.id)+'">Block</button>'+
          '<input type="text" id="r-'+esc(p.id)+'" maxlength="200" placeholder="What happened? (optional)" style="flex:1 1 180px">'+
          '<button type="button" class="danger sm" data-report="'+esc(p.id)+'">Report to host</button></div>' : '')+
        '</div>';
    }).join("") : '<p class="empty">Nobody else is visible yet. People appear here as they join'+(me.visibility==="match"?" with the same status as you":"")+'.</p>';
    app.innerHTML =
      '<div class="brand"><span class="dot"></span>Seeker</div>'+
      '<div><h1>'+esc(d.event.name)+'</h1><div class="status-bar"><span class="live"></span>Inside the venue · '+timeLeft(d.event.endsAt)+'</div></div>'+
      (flash ? '<p class="small" style="color:var(--ok);font-weight:600">'+esc(flash)+'</p>' : '')+
      (editing ? editForm(me, st) :
        '<div class="card"><div class="person" style="padding:0"><div class="who"><span class="small muted">You</span><span class="name">'+esc(me.alias)+'</span>'+pill(st,me.status)+
        (me.line?'<span class="line">'+esc(me.line)+'</span>':'')+(me.visibility==="match"?'<span class="note">Discreet mode on</span>':'')+
        '</div><div class="acts"><button type="button" class="quiet sm" id="edit">Edit</button></div></div></div>')+
      '<div class="card"><h2>In the room · '+people.length+'</h2>'+(d.browsing ? '<p class="note">'+(d.browsing===1 ? '1 person is' : d.browsing+' people are')+' looking around without a status.</p>' : '')+'<div>'+list+'</div></div>'+
      '<button type="button" class="linkbtn" id="leave">Leave and delete my status</button>';
    flash = "";
    var ed=$("#edit"); if(ed) ed.onclick=function(){ editing=true; renderBoard(d); };
    if (editing) bindEdit(d);
    $("#leave").onclick=leave;
    app.querySelectorAll("[data-wave]").forEach(function(b){ b.onclick=function(){ b.disabled=true;
      freshLoc().then(function(loc){ return api("/api/events/"+id+"/wave",{token:store(tokenKey),body:{to:b.getAttribute("data-wave"),loc:loc}}); })
        .then(function(r){ if(r.error){ flash=""; alert2(r.error); } else if(r.mutual) flash="You both waved. Tap I’m ready to meet whenever you are."; refresh(); }); }; });
    app.querySelectorAll("[data-beacon]").forEach(function(b){ b.onclick=function(){ var pid=b.getAttribute("data-beacon"); var p=d.people.filter(function(x){return x.id===pid;})[0]; if (p) beacon(p, id, store(tokenKey), refresh); }; });
    app.querySelectorAll("[data-share]").forEach(function(b){ b.onclick=function(){ b.disabled=true;
      freshLoc().then(function(loc){ return api("/api/events/"+id+"/share",{token:store(tokenKey),body:{to:b.getAttribute("data-share"),loc:loc}}); })
        .then(function(r){ if(r.error){ alert2(r.error); return; } flash = r.both ? "You’re both ready. Check your word, then go and say hi." : "You’re ready. You’ll both see how to find each other once they’re ready too."; refresh(); }); }; });
    app.querySelectorAll("[data-unmatch]").forEach(function(b){ b.onclick=function(){ var pid=b.getAttribute("data-unmatch");
      if (confirmUnmatch!==pid) { confirmUnmatch=pid; renderBoard(d); return; }
      b.disabled=true; confirmUnmatch=null;
      api("/api/events/"+id+"/unwave",{token:store(tokenKey),body:{to:pid}}).then(function(){ flash="Unmatched. They can no longer see your description or find you with the beacon."; refresh(); }); }; });
    app.querySelectorAll("[data-menu]").forEach(function(b){ b.onclick=function(){ var pid=b.getAttribute("data-menu"); openMenu = openMenu===pid?null:pid; renderBoard(d); }; });
    app.querySelectorAll("[data-block]").forEach(function(b){ b.onclick=function(){ b.disabled=true;
      api("/api/events/"+id+"/block",{token:store(tokenKey),body:{to:b.getAttribute("data-block")}}).then(function(){ openMenu=null; flash="Blocked. You won't see each other again at this event."; refresh(); }); }; });
    app.querySelectorAll("[data-report]").forEach(function(b){ b.onclick=function(){ b.disabled=true; var pid=b.getAttribute("data-report"), r=document.getElementById("r-"+pid);
      api("/api/events/"+id+"/report",{token:store(tokenKey),body:{to:pid,reason:r?r.value:""}}).then(function(){ openMenu=null; flash="Reported to the host and blocked."; refresh(); }); }; });
  }
  function renderBrowse(d){
    var st = d.event.statuses;
    var list = d.people.length ? d.people.map(function(p){
      return '<div class="person"><div class="who"><span class="name">'+esc(p.alias)+'</span>'+pill(st,p.status)+
        (p.line?'<span class="line">'+esc(p.line)+'</span>':'')+'</div>'+
        '<div class="acts"><button type="button" class="linkbtn" data-menu="'+esc(p.id)+'">More</button></div>'+
        (openMenu===p.id ? '<div class="menu"><button type="button" class="ghost sm" data-block="'+esc(p.id)+'">Block</button>'+
          '<input type="text" id="r-'+esc(p.id)+'" maxlength="200" placeholder="What happened? (optional)" style="flex:1 1 180px">'+
          '<button type="button" class="danger sm" data-report="'+esc(p.id)+'">Report to host</button></div>' : '')+
        '</div>';
    }).join("") : '<p class="empty">Nobody has posted a status yet.</p>';
    app.innerHTML =
      '<div class="brand"><span class="dot"></span>Seeker</div>'+
      '<div><h1>'+esc(d.event.name)+'</h1><div class="status-bar"><span class="live"></span>Inside the venue · '+timeLeft(d.event.endsAt)+'</div></div>'+
      (flash ? '<p class="small" style="color:var(--ok);font-weight:600">'+esc(flash)+'</p>' : '')+
      ('<div class="card"><h3>You’re looking around</h3><p class="small muted">Nobody can see you. To wave at someone, post a status. You’ll show up on the board like everyone else.</p>'+
        '<button type="button" id="declare-open">Post a status</button></div>')+
      '<div class="card"><h2>In the room · '+d.people.length+'</h2>'+(d.browsing ? '<p class="note">'+(d.browsing===1 ? '1 other person is' : d.browsing+' others are')+' looking around too.</p>' : '')+'<div>'+list+'</div></div>'+
      '<button type="button" class="linkbtn" id="leave">Leave</button>';
    flash = "";
    var op=$("#declare-open"); if (op) op.onclick=function(){ editing=true; journey("declare"); };
    $("#leave").onclick=leave;
    app.querySelectorAll("[data-menu]").forEach(function(b){ b.onclick=function(){ var pid=b.getAttribute("data-menu"); openMenu = openMenu===pid?null:pid; renderBrowse(d); }; });
    app.querySelectorAll("[data-block]").forEach(function(b){ b.onclick=function(){ b.disabled=true;
      api("/api/events/"+id+"/block",{token:store(tokenKey),body:{to:b.getAttribute("data-block")}}).then(function(){ openMenu=null; flash="Blocked."; refresh(); }); }; });
    app.querySelectorAll("[data-report]").forEach(function(b){ b.onclick=function(){ b.disabled=true; var pid=b.getAttribute("data-report"), r=document.getElementById("r-"+pid);
      api("/api/events/"+id+"/report",{token:store(tokenKey),body:{to:pid,reason:r?r.value:""}}).then(function(){ openMenu=null; flash="Reported to the host and blocked."; refresh(); }); }; });
  }
  function matchCard(p, meetSpot){
    var a = esc(p.alias), body;
    if (p.findMe) {
      body = (meetSpot ? '<p class="meet">You’re both ready. Meet at <b>'+esc(meetSpot)+'</b>.</p>' : '<p class="meet">You’re both ready to meet.</p>')+
        '<div class="mrow"><span>Look for: <b>'+esc(p.findMe)+'</b></span></div>'+
        (p.matchWord ? '<div class="mrow"><span>Your word: <b class="word">'+esc(p.matchWord)+'</b></span><span class="small">Say it when you meet. Only you and '+a+' know it.</span></div>' : '');
    } else if (p.iShared) {
      body = '<p class="meet">You both waved.</p><div class="mrow"><span class="small">You’re ready. Waiting for '+a+'. Nothing is revealed until they’re ready too, and if they never tap, nobody is told.</span></div>';
    } else {
      body = '<p class="meet">You both waved.</p><div class="mrow"><button type="button" class="quiet sm" data-share="'+esc(p.id)+'">I’m ready to meet</button><span class="small">'+
        (p.theyShared ? a+' is ready when you are.' : 'No rush. When you’re both ready, you’ll see how to find each other and a word only you two know.')+'</span></div>';
    }
    return '<div class="match">'+body+
      '<div class="mrow"><button type="button" class="sm" data-beacon="'+esc(p.id)+'">Find each other</button>'+
        '<span class="small">'+(p.theirBeacon ? '<b>'+a+' is holding their phone up now.</b>' : 'Both screens light up only when you both hold them up.')+'</span></div>'+
      '<button type="button" class="linkbtn" data-unmatch="'+esc(p.id)+'">'+(confirmUnmatch===p.id ? 'Tap again to unmatch' : 'Unmatch')+'</button>'+
    '</div>';
  }
  function alert2(msg){ flash=""; var p=document.createElement("p"); p.className="err"; p.textContent=msg; app.insertBefore(p, app.children[2]||null); }
  function editForm(me, st){
    return '<form class="card" id="edit-form" novalidate><h3>Edit your status</h3><div class="chips" id="e-status">'+
      st.map(function(s){return '<button type="button" class="chip" aria-pressed="'+(s===me.status)+'" data-s="'+esc(s)+'">'+esc(s)+'</button>';}).join("")+'</div>'+
      '<label for="e-line">A line about you<input type="text" id="e-line" maxlength="80" value="'+esc(me.line)+'"></label>'+
      '<label for="e-find">How to find you<input type="text" id="e-find" maxlength="60" value="'+esc(me.findMe)+'"></label>'+
      '<label class="check" for="e-discreet"><input type="checkbox" id="e-discreet"'+(me.visibility==="match"?" checked":"")+'><span>Discreet mode</span></label>'+
      '<p class="err" id="edit-err" hidden></p><div class="row"><button type="submit">Save</button><button type="button" class="ghost" id="e-cancel">Cancel</button></div></form>';
  }
  function bindEdit(d){
    var picked = d.me.status;
    app.querySelectorAll("#e-status .chip").forEach(function(c){ c.onclick=function(){ picked=c.getAttribute("data-s"); app.querySelectorAll("#e-status .chip").forEach(function(x){x.setAttribute("aria-pressed",String(x===c));}); }; });
    $("#e-cancel").onclick=function(){ editing=false; renderBoard(d); };
    $("#edit-form").addEventListener("submit", function(e){ e.preventDefault();
      if ($("#e-find").value.trim().length < 3) { var er0=$("#edit-err"); er0.textContent="Add how people can find you, like what you’re wearing or where you’re standing."; er0.hidden=false; return; }
      freshLoc().then(function(loc){ return api("/api/events/"+id+"/me",{token:store(tokenKey),body:{status:picked,line:$("#e-line").value,findMe:$("#e-find").value,visibility:$("#e-discreet").checked?"match":"all",loc:loc}}); })
        .then(function(r){ if(r.error){ var er=$("#edit-err"); er.textContent=r.error; er.hidden=false; return; } editing=false; flash="Saved."; refresh(); });
    });
  }
}
/* ---------------- Find-each-other beacon (both-or-neither) ---------------- */
var wake = null, bTimer = null;
function beacon(p, eventId, token, onDone){
  var old = document.getElementById("beacon"); if (old) old.remove();
  if (bTimer) { clearInterval(bTimer); bTimer = null; }
  var a = esc(p.alias);
  var el = document.createElement("div");
  el.id = "beacon"; el.className = "beacon waiting"; el.setAttribute("role","dialog"); el.setAttribute("aria-label","Find each other");
  el.innerHTML = '<i></i><i></i><div class="bcap"><b id="b-title">Waiting for '+a+'</b><span id="b-text">Keep this open. Your screen lights up only when '+a+' holds theirs up too.</span><button type="button" id="beacon-close">Stop</button></div>';
  document.body.appendChild(el);
  var bars = el.querySelectorAll("i"), title = el.querySelector("#b-title"), text = el.querySelector("#b-text"), live = true;
  function tick(on){ return freshLoc().then(function(loc){ return api("/api/events/"+eventId+"/beacon",{token:token, body:{to:p.id, on:on, loc:loc}}); }); }
  function show(r){
    if (!live) return;
    if (r.error || r.state === "ended") {
      el.classList.add("waiting"); bars[0].style.background = ""; bars[1].style.background = "";
      title.textContent = "Beacon off"; text.textContent = r.error || "This match has ended.";
      if (bTimer) { clearInterval(bTimer); bTimer = null; }
      return;
    }
    if (r.state === "both" && r.colours) {
      el.classList.remove("waiting"); bars[0].style.background = r.colours.top; bars[1].style.background = r.colours.bottom;
      title.textContent = "Hold your phone up"; text.textContent = p.alias+"’s screen shows the same two colours right now.";
    } else {
      el.classList.add("waiting"); bars[0].style.background = ""; bars[1].style.background = "";
      title.textContent = "Waiting for "+p.alias; text.textContent = "Keep this open. Your screen lights up only when "+p.alias+" holds theirs up too.";
    }
  }
  function close(){
    live = false; if (bTimer) { clearInterval(bTimer); bTimer = null; }
    el.remove(); try{ if (wake) { wake.release(); wake = null; } }catch(e){}
    tick(false).then(function(){ if (onDone) onDone(); });
  }
  el.querySelector("#beacon-close").addEventListener("click", function(e){ e.stopPropagation(); close(); });
  el.addEventListener("keydown", function(e){ if (e.key === "Escape") close(); });
  tick(true).then(show);
  bTimer = setInterval(function(){ tick(true).then(show); }, 4000);
  try{ if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function(w){ wake = w; }, function(){}); }catch(e){}
  setTimeout(function(){ var c=document.getElementById("beacon-close"); if (c) c.focus(); }, 50);
}

function ended(d){
  stop();
  app.innerHTML =
    '<div class="brand"><span class="dot"></span>Seeker</div>'+
    '<div class="card lock"><div class="ring">END</div><h2>'+(d && d.ended ? (d.name ? esc(d.name)+" has ended" : "This event has ended") : "Event not found")+'</h2>'+
    '<p class="muted">'+(d && d.ended ? "Every status, wave and report from it has been deleted." : "Check the link or ask the host for a new code.")+'</p></div>'+
    '<div class="card"><h2>Host your own Seeker</h2><p class="muted">Running a night out, a wedding or a meetup? Hosting is free while Seeker is in early access.</p><button type="button" id="host-own">Host an event</button></div>';
  $("#host-own").onclick=function(){ history.pushState(null,"","/"); route(); };
}

function route(){
  var p = location.pathname, q = new URLSearchParams(location.search);
  var m;
  if (p === "/events") return eventsPage();
  if ((m = p.match(/^\\/c\\/([A-Za-z0-9_-]+)/))) { store("seeker:creator", m[1]); history.replaceState(null, "", "/events"); return eventsPage(); }
  if ((m = p.match(/^\\/h\\/([A-Za-z0-9_-]+)/))) return host(m[1], q.get("k")||"");
  if ((m = p.match(/^\\/e\\/([A-Za-z0-9_-]+)/))) {
    var c = q.get("c");
    if (c) { try{ store("seeker:c:"+m[1], c); history.replaceState(null,"","/e/"+m[1]); }catch(e){} }
    return guest(m[1], c);
  }
  landing();
}
window.addEventListener("popstate", route);
document.addEventListener("click", function(e){
  var a = e.target.closest && e.target.closest("a[data-nav]");
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute("href")); }
});
route();
})();
</script>
</body>
</html>`;
