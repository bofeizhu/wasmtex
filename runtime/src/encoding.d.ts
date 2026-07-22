// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//
// Minimal ambient declarations for the WHATWG Encoding Standard globals.
// The build tsconfig deliberately pins `lib: ["ES2022"]` with `types: []`
// (no DOM, no WebWorker, no Node ambients — see tsconfig.json) so that
// browser-/worker-unsafe globals cannot leak into library code. TextDecoder/
// TextEncoder are Encoding-Standard globals present in every target runtime
// (browsers, workers, Node ≥ 11) but live in TS's dom/webworker libs, so the
// hardened config needs this narrow declaration instead of a whole lib.
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

declare class TextEncoder {
  constructor();
  encode(input?: string): Uint8Array;
}
