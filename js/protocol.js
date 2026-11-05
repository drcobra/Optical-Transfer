// Wire format of one QR frame. Every frame is self-describing so a receiver
// can join a stream mid-flight; there is no handshake and no back-channel.
//
//  0  u8   magic 'O'
//  1  u8   magic 'Q'
//  2  u8   format version
//  3  u8   flags (reserved, must be 0)
//  4  u32  session id (random per stream)
//  8  u32  sequence number
// 12  u16  k: number of source blocks
// 14  u16  blockLen: payload bytes in this frame
// 16  u32  totalLen: length of the transferred container
// 20  u32  CRC-32 of bytes 0..19 followed by the payload
// 24  ...  payload (blockLen bytes)
(function () {
  const OT = (globalThis.OT = globalThis.OT || {});

  const MAGIC_0 = 0x4f;
  const MAGIC_1 = 0x51;
  const FORMAT_VERSION = 1;
  const HEADER_LEN = 24;
  const MAX_BLOCKS = 0xffff;
  const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(...parts) {
    let crc = 0xffffffff;
    for (const part of parts) {
      for (let i = 0; i < part.length; i++) crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** Number of source blocks a container of this size splits into. */
  function blockCount(totalLen, blockLen) {
    return Math.max(1, Math.ceil(totalLen / blockLen));
  }

  /** Smallest frame payload that lets a container fit in the u16 block counter. */
  function minimumBlockLen(totalLen) {
    return Math.max(1, Math.ceil(totalLen / MAX_BLOCKS));
  }

  /** info: { sessionId, k, blockLen, totalLen } */
  function encodeFrame(info, seq, payload) {
    if (payload.length !== info.blockLen) throw new RangeError("payload length must equal blockLen");
    const out = new Uint8Array(HEADER_LEN + payload.length);
    const view = new DataView(out.buffer);
    out[0] = MAGIC_0;
    out[1] = MAGIC_1;
    out[2] = FORMAT_VERSION;
    out[3] = 0;
    view.setUint32(4, info.sessionId >>> 0);
    view.setUint32(8, seq >>> 0);
    view.setUint16(12, info.k);
    view.setUint16(14, info.blockLen);
    view.setUint32(16, info.totalLen >>> 0);
    out.set(payload, HEADER_LEN);
    view.setUint32(20, crc32(out.subarray(0, 20), payload));
    return out;
  }

  /** Returns a frame object, or an error string:
   *  "too-short" | "not-ours" | "version" | "corrupt" | "invalid". */
  function decodeFrame(bytes) {
    if (bytes.length < HEADER_LEN) return "too-short";
    if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) return "not-ours";
    if (bytes[2] !== FORMAT_VERSION) return "version";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const k = view.getUint16(12);
    const blockLen = view.getUint16(14);
    const totalLen = view.getUint32(16);
    if (bytes.length !== HEADER_LEN + blockLen) return "corrupt";
    const payload = bytes.subarray(HEADER_LEN);
    if (crc32(bytes.subarray(0, 20), payload) !== view.getUint32(20)) return "corrupt";
    if (bytes[3] !== 0 || k < 1 || blockLen < 1 || totalLen < 1) return "invalid";
    if (totalLen > MAX_TRANSFER_BYTES || blockCount(totalLen, blockLen) !== k) return "invalid";
    return { sessionId: view.getUint32(4), seq: view.getUint32(8), k, blockLen, totalLen, payload };
  }

  OT.protocol = {
    HEADER_LEN,
    MAX_BLOCKS,
    MAX_TRANSFER_BYTES,
    crc32,
    blockCount,
    minimumBlockLen,
    encodeFrame,
    decodeFrame,
    isFrame: (value) => typeof value !== "string",
  };
})();
