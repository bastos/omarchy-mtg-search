# Changelog

## Unreleased

- Searches with more matches than fit are no longer cut off: moving past the
  last card, or clicking the row under it, lists more. Scryfall's next page
  is fetched only when the loaded cards run out, under the same rate limits
  as a search, up to 1,750 cards a search.
- ← / → now step through the selected card's printings, newest first, with
  each one's set, prices and image. They are fetched on the first press and
  paged as you go. Double-faced cards flip with Ctrl+F (or a click on the
  image) instead.
- `maxResults` is now how many cards are listed at first and added each time.

## 0.1.0

First release.

- Search Magic: The Gathering cards with the Scryfall API from the bar, by
  name or with any Scryfall query.
- Card images with rounded corners, double-faced card flipping, set,
  rarity, and USD/EUR prices.
- Open a card on scryfall.com, copy its name, and drive the panel over IPC.
- Live search that follows Scryfall's API rules: debounced, one request in
  flight, at least a second apart, a 24-hour cache, and a backoff that
  honours HTTP 429.
- `maxResults`, `order`, and `showPrices` settings.
