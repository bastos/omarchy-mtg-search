import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar icon for the MTG card search. Follows the first-party pattern: the
// widget owns the button and the panel, forwarding the open/close contract
// the bar's popout coordinator expects from the widget in its slot.
//
// The icon is a fixed glyph, so unlike weather nothing here needs the panel
// at startup: it is built the first time it is wanted, by a click or by IPC,
// instead of on every monitor whether or not it is ever opened.
BarWidget {
  id: root
  moduleName: "bastos.mtg-search"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.settings = root.settings
    target.anchorItem = button
    target.hostWidget = root
  }

  // The Loader is synchronous, so the panel exists as soon as this returns.
  function panel() {
    panelLoader.active = true
    return panelLoader.item
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panel()) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panel()) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: false
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: root.injectPanel()
  }

  ShellIpc {
    target: root.moduleName

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function search(text: string): void { if (root.panel()) panelLoader.item.searchFor(text) }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.GLYPH
    slotSize: Style.bar.statusSlot
    // The panel is the detail view.
    tooltipText: ""

    onPressed: function(b) { root.toggle() }
  }
}
