// Run with: node --test tests/
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// Model.js is a QML `.pragma library` script: plain JS once the pragma goes.
function loadModel() {
  const source = readFileSync(join(root, "Model.js"), "utf8").replace(/^\.pragma library\s*$/m, "")
  const context = {}
  vm.createContext(context)
  vm.runInContext(source, context)
  return context
}

const Model = loadModel()
const ID = "e3285e6b-3e79-4d7c-bf96-d920f973b122"

beforeEach(() => {
  Model.resetLimiter()
  Model.cacheClear()
})

function card(overrides) {
  return Object.assign({
    object: "card",
    id: ID,
    name: "Lightning Bolt",
    mana_cost: "{R}",
    type_line: "Instant",
    set: "clu",
    set_name: "Ravnica: Clue Edition",
    rarity: "uncommon",
    prices: { usd: "1.25", eur: "0.90" },
    image_uris: { normal: "https://cards.scryfall.io/normal/front/e/3/" + ID + ".jpg?1706239968" },
    scryfall_uri: "https://scryfall.com/card/clu/141/lightning-bolt?utm_source=api"
  }, overrides)
}

function list(data, total) {
  return JSON.stringify({ object: "list", total_cards: total ?? data.length, has_more: false, data })
}

// ---------------------------------------------------------------- parsing

test("parses a normal search response", () => {
  const result = Model.parseSearchResponse(list([card()]), 0, 200)
  assert.equal(result.ok, true)
  assert.equal(result.total, 1)
  const c = result.cards[0]
  assert.equal(c.name, "Lightning Bolt")
  assert.equal(c.manaCost, "{R}")
  assert.equal(c.setCode, "CLU")
  assert.equal(c.rarity, "uncommon")
  assert.equal(c.usd, "1.25")
  assert.equal(c.images.length, 1)
  assert.ok(c.pageUrl.startsWith("https://scryfall.com/card/"))
})

test("double-faced cards take images and mana cost from their faces", () => {
  const transform = Model.normalizeCard(card({
    image_uris: undefined,
    mana_cost: undefined,
    card_faces: [
      { mana_cost: "{U}", image_uris: { normal: "https://cards.scryfall.io/normal/front/6/9/x.jpg?1" } },
      { mana_cost: "", image_uris: { normal: "https://cards.scryfall.io/normal/back/6/9/x.jpg?1" } }
    ]
  }))
  assert.equal(transform.images.length, 2)
  assert.match(transform.images[1], /\/back\//)
  assert.equal(transform.manaCost, "{U}")

  const modal = Model.normalizeCard(card({ mana_cost: undefined, card_faces: [{ mana_cost: "{1}{R}" }, { mana_cost: "{2}{G}" }] }))
  assert.equal(modal.manaCost, "{1}{R} // {2}{G}")

  // A top-level cost (split cards) wins over the faces'.
  const split = Model.normalizeCard(card({ mana_cost: "{1}{R} // {R}", card_faces: [{ mana_cost: "{1}{R}" }, { mana_cost: "{R}" }] }))
  assert.equal(split.manaCost, "{1}{R} // {R}")
})

test("no matches is an empty success, not an error", () => {
  const body = JSON.stringify({ object: "error", code: "not_found", status: 404, details: "No match." })
  const result = Model.parseSearchResponse(body, 0, 404)
  assert.equal(result.ok, true)
  assert.equal(result.cards.length, 0)
})

test("API errors surface bounded details", () => {
  const body = JSON.stringify({ object: "error", code: "bad_request", details: "x".repeat(5000) })
  const result = Model.parseSearchResponse(body, 0, 400)
  assert.equal(result.error, "api")
  assert.ok(result.details.length <= Model.LIMITS.details)
})

test("curl's exit code decides network and size failures", () => {
  const good = list([card()])
  // Timeout mid-body: partial JSON, but a network problem, not bad data.
  assert.equal(Model.parseSearchResponse(good.slice(0, 40), 28, 200).error, "network")
  // Never started.
  assert.equal(Model.parseSearchResponse("", -1, 0).error, "network")
  assert.equal(Model.parseSearchResponse("", 0, 0).error, "network")
  assert.equal(Model.parseSearchResponse(good.slice(0, 40), Model.CURL_FILESIZE_EXCEEDED, 200).error, "too-large")
})

test("malformed responses fail cleanly", () => {
  assert.equal(Model.parseSearchResponse("<html>nope</html>", 0, 502).error, "invalid")
  assert.equal(Model.parseSearchResponse(JSON.stringify({ object: "card" }), 0, 200).error, "invalid")
})

test("HTTP 429 is recognised from the status line or the JSON body", () => {
  const body = JSON.stringify({ object: "error", code: "rate_limited", status: 429, details: "Too many requests" })
  assert.equal(Model.parseSearchResponse(body, 0, 429).error, "rate-limited")
  assert.equal(Model.parseSearchResponse(body, 0, 0).error, "rate-limited")
  assert.equal(Model.parseSearchResponse("<html>slow down</html>", 0, 429).error, "rate-limited")
  // Even when curl also failed, a 429 is what matters.
  assert.equal(Model.parseSearchResponse("", Model.CURL_FILESIZE_EXCEEDED, 429).error, "rate-limited")
})

test("every error kind the model returns is a listed one", () => {
  const kinds = [
    Model.parseSearchResponse("", 6, 0),
    Model.parseSearchResponse("", Model.CURL_FILESIZE_EXCEEDED, 0),
    Model.parseSearchResponse("<html>", 0, 500),
    Model.parseSearchResponse(JSON.stringify({ object: "error", code: "bad_request" }), 0, 400),
    Model.parseSearchResponse("", 0, 429)
  ].map((r) => r.error)
  for (const kind of kinds) assert.ok(Model.ERROR_KINDS.includes(kind), kind)
})

test("Scryfall's whole page is kept, so maxResults can slice it without a refetch", () => {
  const many = Array.from({ length: 200 }, () => card())
  const result = Model.parseSearchResponse(list(many, 5000), 0, 200)
  assert.equal(result.cards.length, Model.MAX_API_RESULTS)
  assert.equal(result.total, 5000)
  assert.equal(Model.clampMaxResults(9999), Model.MAX_API_RESULTS)
  assert.equal(Model.clampMaxResults("nope"), 40)
})

test("curl's status trailer splits from the body", () => {
  const good = list([card()])
  let r = Model.splitStatus(good + "\n200")
  assert.equal(r.body, good)
  assert.equal(r.status, 200)
  r = Model.splitStatus("\n000")
  assert.equal(r.body, "")
  assert.equal(r.status, 0)
  assert.equal(Model.splitStatus("{}").status, 0)
  assert.equal(Model.splitStatus("").status, 0)
})

// ---------------------------------------------------------------- untrusted data

test("strings are bounded, stripped of control characters, and left literal", () => {
  const markup = '<img src="https://example.invalid/tracker"><b>Bolt</b>'
  // Literal: PlainText rendering (checked below) is what makes markup inert.
  assert.equal(Model.normalizeCard(card({ name: markup })).name, markup)
  const c = Model.normalizeCard(card({ name: "Bolt\u0000\u001b[31m" + "a".repeat(1000) }))
  assert.ok(c.name.length <= Model.LIMITS.name)
  assert.ok(!/[\u0000-\u001F]/.test(c.name))
})

test("truncation never cuts an emoji in half", () => {
  const dragon = "\u{1F409}"
  // 499 letters then a dragon: a 500-unit cut would land between its halves.
  const query = Model.normalizeQuery("a".repeat(Model.MAX_QUERY_CHARS - 1) + dragon)
  assert.equal(query, "a".repeat(Model.MAX_QUERY_CHARS - 1))
  assert.ok(Model.buildSearchUrl(query, "name").startsWith(Model.API_SEARCH))
  assert.match(Model.buildSearchUrl(dragon + " dragon", "name"), /%F0%9F%90%89/)
  const name = Model.normalizeCard(card({ name: "a".repeat(Model.LIMITS.name - 2) + dragon + dragon })).name
  assert.doesNotThrow(() => encodeURIComponent(name))
})

test("image and page URLs must be Scryfall's own HTTPS hosts", () => {
  const bad = [
    "https://example.invalid/tracker.png",
    "http://cards.scryfall.io/normal/front/a.jpg",
    "https://cards.scryfall.io.evil.example/a.jpg",
    "https://cards.scryfall.io/a.jpg?x=<script>",
    "javascript:alert(1)",
    "file:///etc/passwd"
  ]
  for (const url of bad) assert.equal(Model.isCardImageUrl(url), false, url)
  const c = Model.normalizeCard(card({ image_uris: { normal: bad[0] }, scryfall_uri: "https://evil.example/card" }))
  assert.equal(c.images.length, 0)
  assert.equal(c.pageUrl, "")
  assert.equal(Model.isCardPageUrl("https://scryfall.com.evil.example/card/x"), false)
})

test("records without a valid id or name are dropped", () => {
  assert.equal(Model.normalizeCard(card({ id: "../../etc" })), null)
  assert.equal(Model.normalizeCard(card({ name: "   " })), null)
  assert.equal(Model.normalizeCard(null), null)
})

test("prices, rarity and set code are validated", () => {
  const c = Model.normalizeCard(card({ prices: { usd: "1e9", eur: "<b>1</b>", usd_foil: "3.50" }, rarity: "legendary<script>", set: "<x>" }))
  assert.equal(c.usd, "3.50")
  assert.equal(c.eur, "")
  assert.equal(c.rarity, "")
  assert.equal(c.setCode, "")
})

test("search command is an argv with the query percent-encoded", () => {
  const url = Model.buildSearchUrl('t:dragon"; rm -rf ~ #', "usd")
  const cmd = Model.searchCommand(url)
  assert.equal(cmd[0], "curl")
  assert.equal(cmd[cmd.length - 1], url)
  assert.equal(cmd[cmd.indexOf("-w") + 1], "\n%{http_code}")
  assert.ok(!/[\s";#]/.test(url.split("?")[1]))
  assert.match(url, /&order=usd&/)
  assert.match(Model.buildSearchUrl("bolt", "bogus"), /&order=name&/)
  // Only Scryfall search URLs are ever handed to curl.
  assert.equal(Model.searchCommand("https://evil.example/?q=x").length, 0)
  assert.equal(Model.searchCommand("").length, 0)
})

// ---------------------------------------------------------------- etiquette

test("a search is its URL: whitespace-only edits are the same search", () => {
  assert.equal(Model.buildSearchUrl("bolt", "name"), Model.buildSearchUrl("  bolt ", "name"))
  assert.notEqual(Model.buildSearchUrl("bolt", "name"), Model.buildSearchUrl("bolt", "usd"))
  assert.equal(Model.buildSearchUrl("   ", "name"), "")
})

test("typing searches from three characters; Enter searches anything", () => {
  assert.equal(Model.isLiveQuery("bo"), false)
  assert.equal(Model.isLiveQuery("  bo  "), false)
  assert.equal(Model.isLiveQuery("bol"), true)
  assert.ok(Model.buildSearchUrl("b", "name").startsWith(Model.API_SEARCH))
})

test("searches are spaced at least a second apart, under Scryfall's 2/s limit", () => {
  assert.equal(Model.requestDelay(10000), 0)
  Model.noteRequestStarted(10000)
  assert.equal(Model.requestDelay(10000), Model.SEARCH_MIN_INTERVAL_MS)
  assert.equal(Model.requestDelay(10600), 400)
  assert.equal(Model.requestDelay(11000), 0)
  assert.ok(Model.SEARCH_MIN_INTERVAL_MS >= 500, "never faster than Scryfall's hard limit")
})

test("a 429 pauses every search past Scryfall's 30 s lockout, doubling on repeats", () => {
  const first = Model.noteRateLimited(0)
  assert.ok(first > 30000)
  assert.equal(Model.cooldownRemaining(0), first)
  // Spacing alone would allow a request; the cooldown still holds it.
  Model.noteRequestStarted(-5000)
  assert.equal(Model.requestDelay(20000), first - 20000)

  assert.equal(Model.noteRateLimited(first + 1000), first * 2)
  let wait
  for (let i = 0; i < 10; i++) wait = Model.noteRateLimited(first + 2000 + i)
  assert.equal(wait, Model.RATE_LIMIT_MAX_COOLDOWN_MS)

  // Strikes are forgotten after a quiet window.
  const later = first + 2000 + Model.STRIKE_WINDOW_MS + Model.RATE_LIMIT_MAX_COOLDOWN_MS
  assert.equal(Model.noteRateLimited(later), first)
})

test("successful results are cached for 24 hours, least recently used evicted", () => {
  const ok = Model.parseSearchResponse(list([card()]), 0, 200)
  const url = Model.buildSearchUrl("bolt", "name")
  Model.cachePut(url, ok, 0)
  assert.equal(Model.cacheGet(url, Model.CACHE_TTL_MS - 1), ok)
  assert.equal(Model.cacheGet(url, Model.CACHE_TTL_MS), null)

  // Failures are never cached, so they can be retried.
  Model.cachePut(url, Model.parseSearchResponse("", 6, 0), 0)
  assert.equal(Model.cacheGet(url, 1), null)

  for (let i = 0; i < Model.CACHE_MAX_ENTRIES; i++) Model.cachePut("u" + i, ok, 0)
  Model.cacheGet("u0", 1) // touch the oldest, so u1 is now least recent
  Model.cachePut("extra", ok, 2)
  assert.equal(Model.cacheGet("u0", 3), ok)
  assert.equal(Model.cacheGet("u1", 3), null)
  assert.equal(Model.cacheGet("extra", 3), ok)
})

test("expired entries are swept on every put, not only when hit", () => {
  const ok = Model.parseSearchResponse(list([card()]), 0, 200)
  Model.cachePut("old", ok, 0)
  Model.cachePut("new", ok, Model.CACHE_TTL_MS)
  assert.equal(Model.cache.has("old"), false)
  assert.equal(Model.cache.size, 1)
})

// The panel's state machine: what happens next for the search it wants.
test("nextStep: idle, cached, busy, wait, start", () => {
  const A = Model.buildSearchUrl("goblin guide", "name")
  const B = Model.buildSearchUrl("goblin king", "name")
  const state = (o) => Object.assign({ pendingUrl: A, shownUrl: "", failedUrl: "", inflightUrl: "" }, o)
  const ok = Model.parseSearchResponse(list([card()]), 0, 200)

  assert.equal(Model.nextStep(state({ pendingUrl: "" }), 0).action, "idle")
  assert.equal(Model.nextStep(state({ shownUrl: A }), 0).action, "idle")
  // A failure is not retried on its own.
  assert.equal(Model.nextStep(state({ failedUrl: A }), 0).action, "idle")
  assert.equal(Model.nextStep(state(), 0).action, "start")

  // One request in flight; the newest query waits for it.
  assert.equal(Model.nextStep(state({ pendingUrl: B, inflightUrl: A }), 0).action, "busy")

  // Spacing after a start.
  Model.noteRequestStarted(0)
  const held = Model.nextStep(state(), 300)
  assert.equal(held.action, "wait")
  assert.equal(held.ms, Model.SEARCH_MIN_INTERVAL_MS - 300)

  // The cache answers without a request, even while another is in flight.
  Model.cachePut(A, ok, 0)
  const hit = Model.nextStep(state({ inflightUrl: B }), 300)
  assert.equal(hit.action, "show")
  assert.equal(hit.result, ok)
})

test("nextStep: a rate-limited search waits out the cooldown, then goes once", () => {
  const A = Model.buildSearchUrl("goblin guide", "name")
  // The panel leaves failedUrl empty for a 429, so A stays wanted.
  const state = { pendingUrl: A, shownUrl: "", failedUrl: "", inflightUrl: "" }
  const cooldown = Model.noteRateLimited(0)
  const held = Model.nextStep(state, 1000)
  assert.equal(held.action, "wait")
  assert.equal(held.ms, cooldown - 1000)
  assert.equal(Model.nextStep(state, cooldown).action, "start")
})

// ---------------------------------------------------------------- QML

test("every QML Text in the plugin renders as plain text", () => {
  const qmlFiles = readdirSync(root).filter((f) => f.endsWith(".qml"))
  for (const file of qmlFiles) {
    const source = readFileSync(join(root, file), "utf8")
    if (file === "PlainText.qml") {
      assert.match(source, /textFormat:\s*Text\.PlainText/)
      continue
    }
    assert.equal(/^\s*Text\s*\{/m.test(source), false, `${file} uses a bare Text; use PlainText`)
    assert.equal(/Text\.(RichText|StyledText|AutoText|MarkdownText)/.test(source), false, `${file} enables rich text`)
  }
})

test("every translation key the QML uses exists in en.json", () => {
  const catalog = JSON.parse(readFileSync(join(root, "i18n", "en.json"), "utf8"))
  const source = readdirSync(root).filter((f) => f.endsWith(".qml")).map((f) => readFileSync(join(root, f), "utf8")).join("\n")
  // A key ending in "." is a prefix completed at runtime, checked below.
  const used = [...source.matchAll(/strings\.tn?\("([^"]+)"/g)].map((m) => m[1]).filter((k) => !k.endsWith("."))
  for (const key of used) assert.ok(key in catalog, `missing ${key}`)
  for (const rarity of Model.RARITIES) assert.ok(`rarity.${rarity}` in catalog, `missing rarity.${rarity}`)
  for (const kind of Model.ERROR_KINDS) assert.ok(`panel.error.${kind}` in catalog, `missing panel.error.${kind}`)
})
