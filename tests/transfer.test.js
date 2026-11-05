import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./load.js";

const { OT, jsQR } = loadApp();
const { FountainDecoder, FountainEncoder, blockIndices } = OT.fountain;
const { HEADER_LEN, blockCount, decodeFrame, encodeFrame, isFrame } = OT.protocol;
const { ContainerError, packContainer, safeFileName, unpackContainer } = OT.container;
const { StreamReceiver } = OT.receiver;
const { QUIET_ZONE, createQr } = OT.qr;

// assert.deepEqual on large typed arrays is pathologically slow.
function assertBytes(actual, expected) {
  assert.ok(actual && Buffer.compare(actual, expected) === 0, "bytes differ");
}

function randomBytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

const info = (data, blockLen, sessionId = 7) => ({
  sessionId,
  blockLen,
  totalLen: data.length,
  k: blockCount(data.length, blockLen),
});

test("frame round-trips and rejects corruption", () => {
  const payload = randomBytes(100);
  const i = { sessionId: 0xdeadbeef, k: 3, blockLen: 100, totalLen: 250 };
  const bytes = encodeFrame(i, 5, payload);
  assert.equal(bytes.length, HEADER_LEN + 100);
  const frame = decodeFrame(bytes);
  assert.ok(isFrame(frame));
  assert.equal(frame.sessionId, 0xdeadbeef);
  assert.equal(frame.seq, 5);
  assertBytes(frame.payload, payload);

  const bad = bytes.slice();
  bad[50] ^= 1;
  assert.equal(decodeFrame(bad), "corrupt");
  assert.equal(decodeFrame(new Uint8Array(4)), "too-short");
  assert.equal(decodeFrame(new Uint8Array(40)), "not-ours");
  const future = bytes.slice();
  future[2] = 9;
  assert.equal(decodeFrame(future), "version");
});

test("golden vector: frame bytes and block selection are stable", () => {
  const bytes = encodeFrame({ sessionId: 1, k: 1, blockLen: 2, totalLen: 2 }, 0, new Uint8Array([0xab, 0xcd]));
  assert.equal(
    Buffer.from(bytes).toString("hex"),
    "4f510100" + "00000001" + "00000000" + "0001" + "0002" + "00000002" + Buffer.from(bytes).subarray(20, 24).toString("hex") + "abcd",
  );
  // Block selection must never change between releases or ends desync.
  assert.equal(blockIndices(50, 1234, 50).join(), blockIndices(50, 1234, 50).join());
  assert.equal(blockIndices(10, 1, 3).join(), "3");
  const snapshot = [100, 101, 102, 103, 104].map((seq) => blockIndices(100, 42, seq).join(","));
  assert.deepEqual(Array.from(snapshot), [
    "3,7,8,16,19,21,22,25,28,35,40,41,46,47,48,49,54,58,61,64,76,87,88,93,94",
    "0,1,2,9,10,14,15,23,28,30,31,40,46,53,64,65,66,72,76,79,82,83,91,93,94",
    "1,41",
    "2,65",
    "6,19,43",
  ]);
});

for (const [size, blockLen] of [[1, 10], [10, 10], [11, 10], [1000, 100], [100_000, 700], [1_000_000, 1000]] ) {
  test(`decodes ${size} bytes with ${blockLen}-byte blocks over a clean pass`, () => {
    const data = randomBytes(size);
    const enc = new FountainEncoder(data, blockLen, 99);
    const dec = new FountainDecoder(enc.k, blockLen, size, 99);
    for (let seq = 0; !dec.complete; seq++) {
      assert.ok(seq < enc.k + 5, "clean pass must finish within k frames");
      dec.add(seq, enc.payload(seq));
    }
    assertBytes(dec.result(), data);
  });
}

test("recovers from heavy random loss, out of order, with duplicates", () => {
  const data = randomBytes(300_000, 5);
  const blockLen = 800;
  const enc = new FountainEncoder(data, blockLen, 31337);
  const dec = new FountainDecoder(enc.k, blockLen, data.length, 31337);
  let rng = 12345;
  const rand = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
  let used = 0;
  for (let seq = 0; !dec.complete && seq < enc.k * 6; seq++) {
    if (rand() < 0.4) continue; // 40% of frames never arrive
    dec.add(seq, enc.payload(seq));
    if (rand() < 0.2) dec.add(seq, enc.payload(seq)); // duplicate
    used = dec.received;
  }
  assert.ok(dec.complete, "should complete");
  assertBytes(dec.result(), data);
  assert.ok(used < enc.k * 1.6, `overhead too high: ${used} frames for k=${enc.k}`);
});

test("works when joining mid-stream (no systematic frames seen)", () => {
  const data = randomBytes(40_000, 9);
  const enc = new FountainEncoder(data, 500, 5);
  const dec = new FountainDecoder(enc.k, 500, data.length, 5);
  let n = 0;
  for (let seq = enc.k; !dec.complete && n < enc.k * 3; seq++, n++) dec.add(seq, enc.payload(seq));
  assert.ok(dec.complete);
  assertBytes(dec.result(), data);
});

test("container: text, compression, integrity", async () => {
  const text = "hello ".repeat(5000);
  const data = new TextEncoder().encode(text);
  const packed = await packContainer({ name: "note.txt", mime: "text/plain", isText: true, data });
  assert.ok(packed.length < data.length / 5, "repetitive data is gzipped");
  const out = await unpackContainer(packed);
  assert.equal(out.name, "note.txt");
  assert.equal(out.isText, true);
  assertBytes(out.data, data);

  const random = randomBytes(2000, 3);
  const raw = await packContainer({ name: "r.bin", mime: "", isText: false, data: random });
  assert.ok(raw.length >= random.length, "incompressible data is stored as-is");
  assertBytes((await unpackContainer(raw)).data, random);

  const tampered = raw.slice();
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(unpackContainer(tampered), ContainerError);
  await assert.rejects(unpackContainer(new Uint8Array(5)), ContainerError);
});

test("safeFileName strips paths and control characters", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\x\\a:b.txt"), "a_b.txt");
  assert.equal(safeFileName(".."), "received.bin");
  assert.equal(safeFileName(""), "received.bin");
});

test("end to end through real QR codes, scan and reassembly", async () => {
  const data = randomBytes(6000, 11);
  const container = await packContainer({ name: "photo.bin", mime: "application/octet-stream", isText: false, data });
  const blockLen = 400;
  const i = info(container, blockLen, 0xabcdef01);
  const enc = new FountainEncoder(container, blockLen, i.sessionId);
  const receiver = new StreamReceiver();
  let version;
  let frames = 0;
  for (let seq = 0; !receiver.state().complete; seq++) {
    assert.ok(seq < enc.k * 3, "should finish");
    const { matrix, version: v } = createQr(encodeFrame(i, seq, enc.payload(seq)), "L", version);
    version ??= v;
    if (seq % 4 === 1) continue; // lost frame
    const scale = 4;
    const total = matrix.size + QUIET_ZONE * 2;
    const px = total * scale;
    const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
    for (let y = 0; y < matrix.size; y++)
      for (let x = 0; x < matrix.size; x++)
        if (matrix.isDark(x, y))
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const o = (((y + QUIET_ZONE) * scale + dy) * px + (x + QUIET_ZONE) * scale + dx) * 4;
              rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
            }
    const code = jsQR(rgba, px, px, { inversionAttempts: "dontInvert" });
    assert.ok(code, "jsQR decodes the frame");
    receiver.push(Uint8Array.from(code.binaryData));
    frames++;
  }
  const result = await unpackContainer(receiver.result());
  assertBytes(result.data, data);
  assert.equal(result.name, "photo.bin");
  assert.ok(frames >= enc.k - 3);
});

test("receiver ignores a brief foreign stream but switches to a persistent one", () => {
  const a = randomBytes(2000, 1);
  const b = randomBytes(2000, 2);
  const ea = new FountainEncoder(a, 100, 1);
  const eb = new FountainEncoder(b, 100, 2);
  const ia = info(a, 100, 1);
  const ib = info(b, 100, 2);
  const r = new StreamReceiver();
  for (let s = 0; s < 5; s++) r.push(encodeFrame(ia, s, ea.payload(s)));
  assert.equal(r.state().sessionId, 1);
  r.push(encodeFrame(ib, 0, eb.payload(0)));
  assert.equal(r.state().sessionId, 1);
  for (let s = 0; s < 5; s++) r.push(encodeFrame(ib, s, eb.payload(s)));
  assert.equal(r.state().sessionId, 2);
});
