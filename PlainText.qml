import QtQuick

// Every piece of text this plugin draws goes through here. Card names, oracle
// text and API errors come from the network, and Text's default AutoText
// would treat markup-shaped input as rich text.
Text {
  textFormat: Text.PlainText
}
