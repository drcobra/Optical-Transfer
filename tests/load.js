// Loads the browser scripts into one isolated global, in page order, so the
// tests exercise exactly the files the page ships.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPTS = [
  "js/vendor/qrcode.js",
  "js/vendor/jsQR.js",
  "js/protocol.js",
  "js/fountain.js",
  "js/container.js",
  "js/receiver.js",
  "js/qr.js",
];

export function loadApp() {
  const sandbox = {
    console,
    crypto,
    TextEncoder,
    TextDecoder,
    Blob,
    CompressionStream,
    DecompressionStream,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: file });
  }
  return { OT: sandbox.OT, jsQR: sandbox.jsQR };
}
