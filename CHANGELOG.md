# Changelog

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
