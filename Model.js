.pragma library

// Pure helpers for the Scryfall card search plugin. Everything that comes
// back from the network is untrusted: it is bounded, validated, and reduced
// to plain strings here before any QML sees it. The QML side renders all of
// it with Text.PlainText.

var GLYPH = String.fromCodePoint(0xF0639) // nf-md-cards_outline
var SEARCH_GLYPH = String.fromCodePoint(0xF0349) // nf-md-magnify

var API_SEARCH = "https://api.scryfall.com/cards/search"
// Scryfall asks for a User-Agent that names the app accurately; keep the
// version in step with manifest.json.
var USER_AGENT = "OmarchyMtgSearch/0.1.0 (+https://github.com/bastos/omarchy-mtg-search)"

// Typing searches from three characters; Enter searches anything shorter.
// One- and two-character queries match thousands of cards and return
// Scryfall's largest pages, so they are not worth sending on every keystroke.
var MIN_LIVE_QUERY_CHARS = 3
var MAX_QUERY_CHARS = 500
var MAX_RESPONSE_BYTES = 8000000
var MAX_API_RESULTS = 175
var ORDERS = ["name", "released", "edhrec", "usd", "cmc", "rarity"]
var RARITIES = ["common", "uncommon", "rare", "mythic", "special", "bonus"]
var ERROR_KINDS = ["network", "too-large", "invalid", "api", "rate-limited"]

// Real cards round their corners at about 4.75% of the card's width; that is
// also the radius scryfall.com draws its card images with.
var CORNER_RADIUS_RATIO = 0.0475

// curl exit codes the panel tells apart. Anything else non-zero is "network".
var CURL_FILESIZE_EXCEEDED = 63

// ---------------------------------------------------------------- etiquette
//
// Scryfall (https://scryfall.com/docs/api/rate-limits) hard-limits
// /cards/search to 2 requests a second, answers overload with HTTP 429 and a
// 30 second lockout, bans clients that keep going, and asks that responses be
// cached for at least 24 hours (card data and prices change once a day).
// README.md lists the whole policy; the numbers live here.
//
// This script is a `.pragma library`, so the state below is one instance
// shared by every bar on every monitor: the limits hold for the whole shell,
// not per panel.

// Half Scryfall's limit: at most one search a second, ever.
var SEARCH_MIN_INTERVAL_MS = 1000
// First 429: wait out Scryfall's 30 s lockout plus a margin. Each further 429
// within STRIKE_WINDOW_MS doubles the wait, up to ten minutes.
var RATE_LIMIT_COOLDOWN_MS = 35000
var RATE_LIMIT_MAX_COOLDOWN_MS = 600000
var STRIKE_WINDOW_MS = 600000
var CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Each entry holds up to 175 cards; twenty recent queries is plenty to make
// backspacing and re-sorting free without holding megabytes for days.
var CACHE_MAX_ENTRIES = 20

function freshLimiter() {
  return { lastStart: -Infinity, cooldownUntil: 0, strikes: 0, lastStrike: -Infinity }
}

var limiter = freshLimiter()
var cache = new Map()

// Milliseconds until a search may start: the spacing since the last one, or
// what is left of a rate-limit cooldown, whichever is longer.
function requestDelay(now) {
  return Math.max(0, limiter.lastStart + SEARCH_MIN_INTERVAL_MS - now, limiter.cooldownUntil - now)
}

function cooldownRemaining(now) {
  return Math.max(0, limiter.cooldownUntil - now)
}

function noteRequestStarted(now) {
  limiter.lastStart = now
}

// Records a 429 and returns how long every search now waits.
function noteRateLimited(now) {
  limiter.strikes = now - limiter.lastStrike < STRIKE_WINDOW_MS ? limiter.strikes + 1 : 1
  limiter.lastStrike = now
  var wait = Math.min(RATE_LIMIT_MAX_COOLDOWN_MS, RATE_LIMIT_COOLDOWN_MS * Math.pow(2, limiter.strikes - 1))
  limiter.cooldownUntil = Math.max(limiter.cooldownUntil, now + wait)
  return wait
}

function resetLimiter() {
  limiter = freshLimiter()
}

// A cached successful result for this URL, or null. Hits move to the back,
// so the least recently used entry is the one evicted.
function cacheGet(url, now) {
  var entry = cache.get(url)
  if (!entry) return null
  cache.delete(url)
  if (now - entry.at >= CACHE_TTL_MS) return null
  cache.set(url, entry)
  return entry.result
}

function cachePut(url, result, now) {
  if (!url || !result || !result.ok) return
  cache.delete(url)
  cache.set(url, { at: now, result: result })
  // Expired entries go too, not only the oldest beyond the cap.
  cache.forEach(function(entry, key) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key)
  })
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value)
}

function cacheClear() {
  cache.clear()
}

// What the panel does next for the search it wants:
//   { action: "idle" }            nothing to do (none wanted, shown, or failed)
//   { action: "show", result }    answered from the cache, no request
//   { action: "busy" }            a request is in flight; its end steps again
//   { action: "wait", ms }        the limiter holds the request this long
//   { action: "start" }           send it now
// `state` is { pendingUrl, shownUrl, failedUrl, inflightUrl }. A failed URL
// is not retried until the user searches again; a rate-limited one is not
// marked failed, so it waits out the cooldown and then goes once.
function nextStep(state, now) {
  var url = state.pendingUrl
  if (url === "" || url === state.shownUrl || url === state.failedUrl) return { action: "idle" }
  var cached = cacheGet(url, now)
  if (cached) return { action: "show", result: cached }
  if (state.inflightUrl !== "") return { action: "busy" }
  var wait = requestDelay(now)
  if (wait > 0) return { action: "wait", ms: wait }
  return { action: "start" }
}

// curl appends the HTTP status as a final line (-w), so the status survives
// even when the body is not JSON. Returns { body, status }; status is 0 when
// the trailer is missing (curl never reached the server).
function splitStatus(output) {
  var text = output == null ? "" : String(output)
  var match = /\n?([0-9]{3})$/.exec(text)
  if (!match) return { body: text, status: 0 }
  return { body: text.slice(0, match.index), status: parseInt(match[1], 10) }
}

// ---------------------------------------------------------------- queries

var CARD_IMAGE_RE = /^https:\/\/cards\.scryfall\.io\/[A-Za-z0-9_\-\/.]+(\?[0-9]{1,20})?$/
var CARD_PAGE_RE = /^https:\/\/scryfall\.com\/card\/[A-Za-z0-9_\-\/%]+(\?[A-Za-z0-9_=&\-]{0,100})?$/
var CARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
var PRICE_RE = /^[0-9]{1,7}(\.[0-9]{1,2})?$/
var SET_CODE_RE = /^[A-Za-z0-9]{2,8}$/

var LIMITS = {
  name: 200,
  manaCost: 120,
  typeLine: 200,
  setName: 120,
  details: 300
}

// The first `max` UTF-16 units of text, backing off one unit rather than
// cutting a surrogate pair (an emoji) in half, which encodeURIComponent
// would refuse.
function truncate(text, max) {
  if (text.length <= max) return text
  var end = max
  var last = text.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF) end--
  return text.slice(0, end)
}

// A bounded single-line string with control characters removed.
function cleanString(value, max) {
  if (value == null) return ""
  var text = String(value).replace(/[\u0000-\u001F\u007F]/g, " ").trim()
  return text.length > max ? truncate(text, max - 1) + "…" : text
}

function normalizeOrder(order) {
  return ORDERS.indexOf(order) >= 0 ? order : "name"
}

function clampMaxResults(value) {
  var n = parseInt(value, 10)
  if (isNaN(n)) n = 40
  return Math.max(1, Math.min(MAX_API_RESULTS, n))
}

function normalizeQuery(query) {
  return truncate(String(query || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim(), MAX_QUERY_CHARS).trim()
}

// Long enough to search while typing; shorter ones need Enter.
function isLiveQuery(query) {
  return normalizeQuery(query).length >= MIN_LIVE_QUERY_CHARS
}

// The request URL for a query, or "" for an empty one. The URL is the
// identity of a search: two searches are the same exactly when their URLs
// are, so a whitespace-only edit is not a new search.
function buildSearchUrl(query, order) {
  var q = normalizeQuery(query)
  if (q === "") return ""
  return API_SEARCH
    + "?q=" + encodeURIComponent(q)
    + "&order=" + normalizeOrder(order)
    + "&unique=cards"
}

// The curl argv for a search URL. Passed as an argument array, never through
// a shell; the query only ever appears percent-encoded inside the URL. Any
// other URL gets an empty command, which fails to start.
function searchCommand(url) {
  if (typeof url !== "string" || url.indexOf(API_SEARCH + "?") !== 0) return []
  return [
    "curl", "-sS",
    "--proto", "=https",
    "--max-time", "8",
    "--max-filesize", String(MAX_RESPONSE_BYTES),
    "-H", "User-Agent: " + USER_AGENT,
    "-H", "Accept: application/json",
    "-w", "\n%{http_code}",
    url
  ]
}

// ---------------------------------------------------------------- cards

function isCardImageUrl(url) {
  return typeof url === "string" && url.length <= 300 && CARD_IMAGE_RE.test(url)
}

function isCardPageUrl(url) {
  return typeof url === "string" && url.length <= 300 && CARD_PAGE_RE.test(url)
}

function cleanPrice(value) {
  return typeof value === "string" && PRICE_RE.test(value) ? value : ""
}

function normalImage(holder) {
  if (!holder || typeof holder !== "object" || !holder.image_uris || typeof holder.image_uris !== "object") return ""
  var url = holder.image_uris.normal
  return isCardImageUrl(url) ? url : ""
}

// One card as the panel needs it, or null when the record is unusable.
function normalizeCard(raw) {
  if (!raw || typeof raw !== "object") return null
  if (typeof raw.id !== "string" || !CARD_ID_RE.test(raw.id)) return null

  var name = cleanString(raw.name, LIMITS.name)
  if (name === "") return null

  var faces = Array.isArray(raw.card_faces) ? raw.card_faces.slice(0, 4) : []

  // Single-image cards (split, adventure, flip) carry one image at the top
  // level; transform and modal double-faced cards carry one per face.
  var images = []
  var top = normalImage(raw)
  if (top !== "") images.push(top)
  else {
    for (var i = 0; i < faces.length; i++) {
      var faceImage = normalImage(faces[i])
      if (faceImage !== "") images.push(faceImage)
    }
  }

  // Multi-face cards leave the top-level mana cost off and put it on each
  // face; join the faces' costs the way Scryfall writes split cards' costs.
  var manaCost = cleanString(raw.mana_cost, LIMITS.manaCost)
  if (manaCost === "" && faces.length > 0) {
    var costs = []
    for (var j = 0; j < faces.length; j++) {
      var faceCost = cleanString(faces[j] && faces[j].mana_cost, LIMITS.manaCost)
      if (faceCost !== "") costs.push(faceCost)
    }
    manaCost = cleanString(costs.join(" // "), LIMITS.manaCost)
  }

  var setCode = typeof raw.set === "string" && SET_CODE_RE.test(raw.set) ? raw.set.toUpperCase() : ""
  var rarity = RARITIES.indexOf(raw.rarity) >= 0 ? raw.rarity : ""
  var prices = raw.prices && typeof raw.prices === "object" ? raw.prices : {}

  return {
    id: raw.id,
    name: name,
    manaCost: manaCost,
    typeLine: cleanString(raw.type_line, LIMITS.typeLine),
    setCode: setCode,
    setName: cleanString(raw.set_name, LIMITS.setName),
    rarity: rarity,
    usd: cleanPrice(prices.usd) || cleanPrice(prices.usd_foil),
    eur: cleanPrice(prices.eur) || cleanPrice(prices.eur_foil),
    images: images,
    pageUrl: isCardPageUrl(raw.scryfall_uri) ? raw.scryfall_uri : ""
  }
}

// Turns a response body, curl's exit code and the HTTP status into
// { ok, cards, total, error, details }, with error one of ERROR_KINDS or "".
// Without curl's -f, Scryfall's HTTP errors arrive as JSON with exit code 0,
// so a non-zero exit always means curl itself failed (DNS, TLS, timeout,
// size cap, or -1: it never started). A query that matches nothing is an
// empty success.
function parseSearchResponse(text, exitCode, httpStatus) {
  // Checked first: a 429 must slow us down whatever else went wrong.
  if (httpStatus === 429) return failure("rate-limited", "")
  var code = exitCode || 0
  if (code === CURL_FILESIZE_EXCEEDED) return failure("too-large", "")
  if (code !== 0) return failure("network", "")

  var raw = text == null ? "" : String(text)
  if (raw.trim() === "") return failure("network", "")
  // curl already caps the body in bytes; this guards the parse regardless.
  if (raw.length > MAX_RESPONSE_BYTES) return failure("too-large", "")

  var parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return failure("invalid", "")
  }
  if (!parsed || typeof parsed !== "object") return failure("invalid", "")

  if (parsed.object === "error") {
    if (parsed.status === 429 || parsed.code === "rate_limited") return failure("rate-limited", "")
    if (parsed.code === "not_found") return { ok: true, cards: [], total: 0, error: "", details: "" }
    return failure("api", cleanString(parsed.details, LIMITS.details))
  }

  if (parsed.object !== "list" || !Array.isArray(parsed.data)) return failure("invalid", "")

  var cards = []
  for (var i = 0; i < parsed.data.length && cards.length < MAX_API_RESULTS; i++) {
    var card = normalizeCard(parsed.data[i])
    if (card) cards.push(card)
  }

  var total = parseInt(parsed.total_cards, 10)
  if (isNaN(total) || total < cards.length) total = cards.length
  total = Math.min(total, 1000000)

  return { ok: true, cards: cards, total: total, error: "", details: "" }
}

function failure(error, details) {
  return { ok: false, cards: [], total: 0, error: error, details: details || "" }
}
