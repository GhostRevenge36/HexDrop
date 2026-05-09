// HexDrop background service worker.
// ExtensionPay polls in the background to keep the user's paid status current.
//
// Per ExtensionPay docs (https://github.com/Glench/ExtPay):
//   - importScripts() loads ExtPay.js (Manifest V3 service worker style)
//   - extpay.startBackground() starts the polling loop
//   - The same ExtPay('hexdrop') instance is used in popup.html / viewer.html
//     by re-instantiating with the same ID — they share state via chrome.storage.

importScripts('ExtPay.js');

const extpay = ExtPay('hexdrop');
extpay.startBackground();
