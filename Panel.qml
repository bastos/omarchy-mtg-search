import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Card search panel. Typing searches Scryfall; the list shows matching cards
// and the side shows the highlighted card's image, set, rarity and prices.
//
// How Scryfall's API is spared is listed in README.md ("Network and
// safety"); the limits and the cache live in Model.js. Every field from the
// API is bounded and validated there and drawn here as plain text.
Panel {
  id: root
  moduleName: "bastos.mtg-search"
  manageIpc: false // BarWidget owns the IPC target, so it works before this loads.

  property var anchorItem: null
  property var hostWidget: null
  // The bar tracks the widget in its slot, not this nested panel.
  readonly property var barIdentity: hostWidget || root

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property color accent: Commons.Color.accent
  readonly property color urgent: Commons.Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property int maxResults: Model.clampMaxResults(setting("maxResults", 40))
  readonly property string order: Model.normalizeOrder(setting("order", "name"))
  readonly property bool showPrices: setting("showPrices", true) !== false

  property string query: ""
  // Every card from the last successful search (Scryfall's page of up to
  // 175). maxResults only decides how many are listed, so changing it never
  // fetches again.
  property var allCards: []
  readonly property var cards: allCards.slice(0, maxResults)
  property int total: 0
  property string errorKind: ""
  property string errorDetails: ""
  property int selectedIndex: 0
  property int faceIndex: 0
  property string notice: ""
  property int cooldownLeft: 0

  // A search is identified by its request URL (in flight: searchProc.url).
  property string pendingUrl: "" // the one wanted
  property string shownUrl: ""   // the one whose results are on screen
  property string failedUrl: ""  // the one that last failed; not retried until searched again
  readonly property bool searching: pendingUrl !== "" && pendingUrl !== shownUrl && pendingUrl !== failedUrl

  readonly property var selectedCard: selectedIndex >= 0 && selectedIndex < cards.length ? cards[selectedIndex] : null
  readonly property int faceCount: selectedCard ? selectedCard.images.length : 0
  readonly property string selectedImage: faceCount > 0 ? selectedCard.images[Math.min(faceIndex, faceCount - 1)] : ""
  // Follows selectedImage once it settles, so holding an arrow key loads only
  // the card it stops on rather than every card it passes.
  property string previewImage: ""
  onSelectedImageChanged: {
    if (selectedImage === "") previewImage = ""
    else previewDelay.restart()
  }

  Timer {
    id: previewDelay
    interval: 120
    onTriggered: root.previewImage = root.selectedImage
  }

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  readonly property string countLabel: {
    if (cooldownLeft > 0 && errorKind === "rate-limited")
      return strings.t("panel.waiting").arg(Commons.I18n.formatNumber(Math.ceil(cooldownLeft / 1000)))
    if (searching) return strings.t("panel.searching")
    if (cards.length === 0) return ""
    var all = strings.tn("panel.results", total).arg(Commons.I18n.formatNumber(total))
    if (total <= cards.length) return all
    return strings.t("panel.resultsShown").arg(Commons.I18n.formatNumber(cards.length)).arg(all)
  }

  readonly property string statusMessage: {
    if (cards.length > 0) return ""
    // While a 429 cooldown runs the search is still wanted, so this comes
    // before "Searching…".
    if (errorKind === "rate-limited") return strings.t("panel.error.rate-limited")
    if (searching) return strings.t("panel.searching")
    if (errorKind === "api") return strings.t("panel.error.api").arg(errorDetails)
    if (errorKind !== "") return strings.t("panel.error." + errorKind)
    if (shownUrl !== "") return strings.t("panel.noResults")
    if (query.trim() !== "" && !Model.isLiveQuery(query)) return strings.t("panel.typeMore")
    return strings.t("panel.hint")
  }

  onCardsChanged: if (selectedIndex >= cards.length) selectedIndex = Math.max(0, cards.length - 1)
  onSelectedIndexChanged: faceIndex = 0
  // Re-sort only while the panel is up; a closed panel catches up when it
  // opens, since open() runs the search for the current order.
  onOrderChanged: if (opened) runSearch(false)

  // ---------------------------------------------------------------- lifecycle

  // KeyboardPanel focuses focusTarget on open, but lazily built content does
  // not exist yet on the first open, so focus the field once it does.
  function focusSearch() {
    Qt.callLater(function() {
      var content = panel.loadedContent
      if (root.opened && content) content.searchField.forceActiveFocus()
    })
  }

  // `force` searches even below the typing threshold (Enter, IPC). Otherwise
  // this is a no-op unless the query or order changed since what is shown.
  function open(force) {
    root.controller.show()
    runSearch(force === true)
    focusSearch()
  }

  // Nothing is sent while closed: drop the queued keystroke and the request
  // waiting on the limiter. open() picks the query up again. A request
  // already in flight still finishes and is cached.
  function close() {
    searchDebounce.stop()
    requestTimer.stop()
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // Open the panel with a query already typed (IPC `search`).
  function searchFor(text) {
    // Set query first, so the field's onTextChanged sees nothing new.
    query = Model.normalizeQuery(text)
    var content = panel.ensureContent()
    if (content) content.searchField.text = query
    open(true)
  }

  // ---------------------------------------------------------------- search

  function setQuery(text) {
    query = text
    searchDebounce.restart()
  }

  function clearResults() {
    allCards = []
    total = 0
    errorKind = ""
    errorDetails = ""
    selectedIndex = 0
    shownUrl = ""
    failedUrl = ""
  }

  // The user asked for a search (typed, Enter, reopened, re-sorted).
  function runSearch(force) {
    searchDebounce.stop()
    var url = Model.buildSearchUrl(query, order)
    // Typing never sends a short query; it only keeps what is already shown.
    if (!force && url !== shownUrl && !Model.isLiveQuery(query)) url = ""
    pendingUrl = url
    if (url === "") clearResults()
    // Searching again is how a failed search is retried.
    else failedUrl = ""
    step()
  }

  // Do whatever Model.nextStep says the wanted search needs now.
  function step() {
    if (!root.opened) return
    cooldownLeft = Model.cooldownRemaining(Date.now())
    var next = Model.nextStep({
      pendingUrl: pendingUrl,
      shownUrl: shownUrl,
      failedUrl: failedUrl,
      inflightUrl: searchProc.url
    }, Date.now())
    if (next.action === "show") {
      showResult(pendingUrl, next.result)
    } else if (next.action === "wait") {
      requestTimer.interval = Math.ceil(next.ms)
      requestTimer.restart()
    } else if (next.action === "start") {
      searchProc.url = pendingUrl
      runExitCode = -1
      Model.noteRequestStarted(Date.now())
      searchProc.command = Model.searchCommand(pendingUrl)
      searchProc.running = true
    }
  }

  // One curl run has ended, successfully or not.
  function settle(output, exitCode) {
    var ranUrl = searchProc.url
    searchProc.url = ""
    var response = Model.splitStatus(output)
    var result = Model.parseSearchResponse(response.body, exitCode, response.status)
    if (result.error === "rate-limited") Model.noteRateLimited(Date.now())
    // Cached even if the query moved on: going back to it is then free.
    else Model.cachePut(ranUrl, result, Date.now())
    if (ranUrl === pendingUrl) showResult(ranUrl, result)
    step()
  }

  function showResult(url, result) {
    errorKind = result.error
    errorDetails = result.details
    allCards = result.cards
    total = result.total
    shownUrl = result.ok ? url : ""
    // A rate-limited search stays wanted, so step() sends it once the
    // cooldown ends; any other failure waits for the user.
    failedUrl = result.ok || result.error === "rate-limited" ? "" : url
    selectedIndex = 0
    faceIndex = 0
    if (panel.loadedContent) panel.loadedContent.resultsList.positionViewAtBeginning()
  }

  Timer {
    id: searchDebounce
    interval: 400
    onTriggered: root.runSearch(false)
  }

  // Holds the wanted search until the limiter allows it.
  Timer {
    id: requestTimer
    onTriggered: root.step()
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.opened && root.cooldownLeft > 0
    onTriggered: root.cooldownLeft = Model.cooldownRemaining(Date.now())
  }

  property int runExitCode: -1

  Process {
    id: searchProc
    property string url: ""
    stdout: StdioCollector { id: searchOutput; waitForEnd: true }
    onExited: function(exitCode) { root.runExitCode = exitCode }
    // Fires after exited, and is the only signal from a curl that failed to
    // start (runExitCode is still -1 then, and its output is not this run's).
    onRunningChanged: {
      if (running || url === "") return
      root.settle(root.runExitCode < 0 ? "" : String(searchOutput.text || ""), root.runExitCode)
    }
  }

  // ---------------------------------------------------------------- actions

  function move(delta) {
    if (cards.length === 0) return
    selectedIndex = Util.clamp(selectedIndex + delta, 0, cards.length - 1)
  }

  function flip(delta) {
    if (faceCount < 2) return
    faceIndex = (faceIndex + delta + faceCount) % faceCount
  }

  function openSelected() {
    var card = selectedCard
    if (!card || !Model.isCardPageUrl(card.pageUrl)) return
    // Close first: the panel holds keyboard focus, and the browser should
    // take it.
    close()
    Quickshell.execDetached(["omarchy-launch-browser", card.pageUrl])
  }

  function copySelected() {
    var card = selectedCard
    if (!card) return
    Quickshell.execDetached(["wl-copy", "--", card.name])
    notice = strings.t("panel.copied").arg(card.name)
    noticeTimer.restart()
  }

  Timer {
    id: noticeTimer
    interval: 2000
    onTriggered: root.notice = ""
  }

  // ---------------------------------------------------------------- surface

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: panel.loadedContent ? panel.loadedContent.searchField : null
    contentWidth: panel.fittedContentWidth(Style.space(640))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight)

    content: Item {
      id: contentRoot
      property alias searchField: searchInput
      property alias resultsList: resultsList
      anchors.fill: parent
      implicitHeight: column.implicitHeight

      // Sees every key before the search line; what it leaves is typed.
      // Edits and reading direction go through the shell's own helpers so
      // they behave as in every other Omarchy search field.
      Item {
        id: keyHandler
        Keys.onPressed: function(event) {
          var ctrlOnly = event.modifiers === Qt.ControlModifier
          var key = Util.readingKey(event)
          if (event.key === Qt.Key_Escape) {
            root.close()
          } else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
            root.switchPanel((event.modifiers & Qt.ShiftModifier) || event.key === Qt.Key_Backtab ? -1 : 1)
          } else if (event.key === Qt.Key_Down || (ctrlOnly && (event.key === Qt.Key_J || event.key === Qt.Key_N))) {
            root.move(1)
          } else if (event.key === Qt.Key_Up || (ctrlOnly && (event.key === Qt.Key_K || event.key === Qt.Key_P))) {
            root.move(-1)
          } else if (event.key === Qt.Key_PageDown) {
            root.move(5)
          } else if (event.key === Qt.Key_PageUp) {
            root.move(-5)
          } else if (key === Qt.Key_Right) {
            root.flip(1)
          } else if (key === Qt.Key_Left) {
            root.flip(-1)
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            // With nothing to open, Enter searches now: below the typing
            // threshold, or without waiting for the keystroke debounce.
            if (root.selectedCard) root.openSelected()
            else root.runSearch(true)
          } else if (ctrlOnly && event.key === Qt.Key_C) {
            root.copySelected()
          } else if (Util.editsFilter(event, searchInput.text)) {
            searchInput.text = Util.editedFilter(event, searchInput.text)
          } else {
            return
          }
          event.accepted = true
        }
      }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(10)

        // ---- Search line
        Item {
          width: parent.width
          height: Style.space(30)

          PlainText {
            id: searchGlyph
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: Model.SEARCH_GLYPH
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
          }

          // Unbounded here on purpose: Model.normalizeQuery bounds the
          // query, without cutting an emoji in half.
          FilterInput {
            id: searchInput
            anchors.left: searchGlyph.right
            anchors.leftMargin: Style.space(10)
            anchors.right: countText.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            keyHandler: keyHandler
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            onTextChanged: if (text !== root.query) root.setQuery(text)
          }

          PlainText {
            anchors.fill: searchInput
            verticalAlignment: Text.AlignVCenter
            visible: searchInput.text === "" && !searchInput.preeditText
            text: strings.t("panel.placeholder")
            color: root.foreground
            opacity: 0.58
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            elide: Text.ElideRight
          }

          PlainText {
            id: countText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.countLabel
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }
        }

        PanelSeparator { foreground: root.foreground }

        // ---- Results + preview
        Item {
          width: parent.width
          height: Style.space(400)

          ListView {
            id: resultsList
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            anchors.right: preview.left
            anchors.rightMargin: Style.space(14)
            model: root.cards
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            currentIndex: root.selectedIndex
            onCurrentIndexChanged: if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)

            delegate: Item {
              id: row
              required property var modelData
              required property int index
              readonly property bool selected: index === root.selectedIndex

              width: ListView.view.width
              height: Style.space(44)

              Rectangle {
                anchors.fill: parent
                radius: Style.cornerRadius
                color: row.selected
                  ? Style.selectedFillFor(root.foreground, root.accent)
                  : (rowMouse.containsMouse ? Style.hoverFillFor(root.foreground, root.accent) : "transparent")
              }

              Column {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)

                Item {
                  width: parent.width
                  height: nameText.implicitHeight

                  PlainText {
                    id: nameText
                    anchors.left: parent.left
                    // Leave room for the mana cost as drawn (it is capped and
                    // elided), not as it would be at full length.
                    width: Math.max(0, Math.min(implicitWidth,
                      parent.width - (manaText.width > 0 ? manaText.width + Style.space(8) : 0)))
                    text: row.modelData.name
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: row.selected
                    elide: Text.ElideRight
                  }

                  PlainText {
                    id: manaText
                    anchors.right: parent.right
                    width: Math.min(implicitWidth, parent.width * 0.45)
                    horizontalAlignment: Text.AlignRight
                    text: row.modelData.manaCost
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideLeft
                  }
                }

                PlainText {
                  width: parent.width
                  text: row.modelData.setCode !== ""
                    ? row.modelData.typeLine + "  ·  " + row.modelData.setCode
                    : row.modelData.typeLine
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              MouseArea {
                id: rowMouse
                anchors.fill: parent
                hoverEnabled: true
                onClicked: root.selectedIndex = row.index
                onDoubleClicked: {
                  root.selectedIndex = row.index
                  root.openSelected()
                }
              }
            }
          }

          PlainText {
            anchors.centerIn: resultsList
            width: resultsList.width - Style.space(20)
            visible: root.statusMessage !== ""
            text: root.statusMessage
            color: root.errorKind !== "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
          }

          Column {
            id: preview
            anchors.right: parent.right
            anchors.top: parent.top
            width: Style.space(240)
            spacing: Style.space(6)

            Item {
              id: cardFrame
              width: parent.width
              // Scryfall's "normal" images are 488x680.
              height: Math.round(width * 680 / 488)
              readonly property real cornerRadius: width * Model.CORNER_RADIUS_RATIO
              // The mask's two offscreen layers exist only while there is a
              // card on a visible panel.
              readonly property bool rounded: panel.visible && root.previewImage !== ""

              Rectangle {
                anchors.fill: parent
                radius: cardFrame.cornerRadius
                color: root.foreground
                opacity: 0.06
                visible: root.selectedCard !== null && cardImage.status !== Image.Ready
              }

              PlainText {
                anchors.centerIn: parent
                visible: root.selectedCard !== null && root.selectedImage === ""
                text: strings.t("panel.noImage")
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }

              // Scryfall's JPEGs are square-cornered, with the scanner's
              // white or black background filling the corners. Mask them to
              // the card's own rounded corners.
              Item {
                id: cornerMask
                anchors.fill: parent
                visible: false
                layer.enabled: cardFrame.rounded

                Rectangle {
                  anchors.fill: parent
                  radius: cardFrame.cornerRadius
                  color: "white"
                  antialiasing: true
                }
              }

              // previewImage only ever holds URLs Model.normalizeCard checked.
              SizedImage {
                id: cardImage
                anchors.fill: parent
                url: root.previewImage
                visible: status === Image.Ready
                layer.enabled: cardFrame.rounded
                layer.smooth: true
                layer.effect: MultiEffect {
                  maskEnabled: true
                  maskSource: cornerMask
                  maskThresholdMin: 0.5
                  maskSpreadAtMin: 1.0
                }
              }

              MouseArea {
                anchors.fill: parent
                enabled: root.faceCount > 1
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: root.flip(1)
              }
            }

            PlainText {
              width: parent.width
              visible: root.faceCount > 1
              text: strings.t("panel.face").arg(Commons.I18n.formatNumber(root.faceIndex + 1)).arg(Commons.I18n.formatNumber(root.faceCount))
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
            }

            PlainText {
              width: parent.width
              visible: root.selectedCard !== null
              text: {
                var card = root.selectedCard
                if (!card) return ""
                var parts = []
                if (card.setName !== "") parts.push(card.setName)
                if (card.rarity !== "") parts.push(strings.t("rarity." + card.rarity))
                return parts.join("  ·  ")
              }
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              horizontalAlignment: Text.AlignHCenter
              elide: Text.ElideRight
            }

            PlainText {
              width: parent.width
              visible: root.showPrices && text !== ""
              text: {
                var card = root.selectedCard
                if (!card) return ""
                var parts = []
                if (card.usd !== "") parts.push("$" + Commons.I18n.formatNumber(Number(card.usd), 2))
                if (card.eur !== "") parts.push("€" + Commons.I18n.formatNumber(Number(card.eur), 2))
                return parts.join("  ·  ")
              }
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              horizontalAlignment: Text.AlignHCenter
              // Prices read the same way in a right-to-left layout.
              LayoutMirroring.enabled: false
            }
          }
        }

        PanelSeparator { foreground: root.foreground }

        PlainText {
          width: parent.width
          text: root.notice !== "" ? root.notice : strings.t("panel.footer")
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
