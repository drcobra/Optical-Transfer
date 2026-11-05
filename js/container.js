// The container is what the fountain stream actually carries: file metadata,
// a SHA-256 of the original bytes, and the (optionally gzipped) body.
//
//  0  u8   container version (1)
//  1  u8   flags: bit0 = body is gzip, bit1 = payload is a text snippet
//  2  u16  name length
//  4  u16  media type length
//  6  32B  SHA-256 of the original (uncompressed) bytes
// 38  ...  name (UTF-8), media type (UTF-8), body
(function () {
  const OT = (globalThis.OT = globalThis.OT || {});
  const { MAX_TRANSFER_BYTES } = OT.protocol;

  const MAX_FILE_BYTES = MAX_TRANSFER_BYTES - 1024;
  const VERSION = 1;
  const FLAG_GZIP = 1;
  const FLAG_TEXT = 2;
  const FIXED_LEN = 38;

  class ContainerError extends Error {}

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const gzipSupported = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

  async function sha256(data) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  }

  async function readCapped(stream, limit) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new ContainerError("Decompressed data exceeds the size limit.");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function pipe(data, transform, limit) {
    return readCapped(new Blob([data]).stream().pipeThrough(transform), limit);
  }

  /** payload: { name, mime, isText, data: Uint8Array } */
  async function packContainer(payload) {
    if (payload.data.length > MAX_FILE_BYTES) {
      throw new ContainerError(`Too large: the limit is ${Math.floor(MAX_FILE_BYTES / 1048576)} MB.`);
    }
    const name = encoder.encode(payload.name.slice(0, 255));
    const mime = encoder.encode(payload.mime.slice(0, 127));
    let body = payload.data;
    let flags = payload.isText ? FLAG_TEXT : 0;
    if (gzipSupported && body.length > 0) {
      const zipped = await pipe(body, new CompressionStream("gzip"), MAX_TRANSFER_BYTES * 2);
      if (zipped.length < body.length) {
        body = zipped;
        flags |= FLAG_GZIP;
      }
    }
    const out = new Uint8Array(FIXED_LEN + name.length + mime.length + body.length);
    const view = new DataView(out.buffer);
    out[0] = VERSION;
    out[1] = flags;
    view.setUint16(2, name.length);
    view.setUint16(4, mime.length);
    out.set(await sha256(payload.data), 6);
    out.set(name, FIXED_LEN);
    out.set(mime, FIXED_LEN + name.length);
    out.set(body, FIXED_LEN + name.length + mime.length);
    if (out.length > MAX_TRANSFER_BYTES) throw new ContainerError("Too large to transfer.");
    return out;
  }

  async function unpackContainer(bytes) {
    if (bytes.length < FIXED_LEN) throw new ContainerError("Transfer is truncated.");
    if (bytes[0] !== VERSION) throw new ContainerError("Unsupported container version; update this app.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = bytes[1];
    const nameLen = view.getUint16(2);
    const mimeLen = view.getUint16(4);
    const bodyStart = FIXED_LEN + nameLen + mimeLen;
    if (bodyStart > bytes.length) throw new ContainerError("Transfer header is damaged.");
    let name;
    let mime;
    try {
      name = decoder.decode(bytes.subarray(FIXED_LEN, FIXED_LEN + nameLen));
      mime = decoder.decode(bytes.subarray(FIXED_LEN + nameLen, bodyStart));
    } catch {
      throw new ContainerError("Transfer header is damaged.");
    }
    let data = bytes.subarray(bodyStart);
    if (flags & FLAG_GZIP) {
      if (!gzipSupported) throw new ContainerError("This browser cannot decompress the transfer.");
      try {
        data = await pipe(data, new DecompressionStream("gzip"), MAX_FILE_BYTES);
      } catch (error) {
        if (error instanceof ContainerError) throw error;
        throw new ContainerError("Decompression failed.");
      }
    }
    const expected = bytes.subarray(6, 38);
    const actual = await sha256(data);
    if (actual.some((byte, i) => byte !== expected[i])) {
      throw new ContainerError("Checksum mismatch: the received data is damaged.");
    }
    return { name, mime, isText: (flags & FLAG_TEXT) !== 0, data };
  }

  /** A name that is safe to hand to a download: no path parts, no control characters. */
  function safeFileName(name) {
    const base = (name.split(/[\\/]/).pop() || "").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
    return base && base !== "." && base !== ".." ? base : "received.bin";
  }

  OT.container = { MAX_FILE_BYTES, ContainerError, packContainer, unpackContainer, safeFileName };
})();
