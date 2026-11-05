// LT fountain code over fixed-size blocks.
//
// The first k frames carry the source blocks themselves (so a clean pass needs
// no decoding); every later frame is the XOR of a pseudorandom subset chosen
// from the frame's sequence number, with subset sizes drawn from a robust
// soliton distribution. A receiver rebuilds the data from any sufficiently
// large set of frames, in any order.
//
// Sender and receiver must derive identical subsets. The distribution is built
// from +, -, *, / only (all correctly rounded by IEEE-754) and an integer
// square root: Math.log/Math.sqrt are not guaranteed bit-identical across
// engines, and a one-ulp difference would silently desync the two ends.
(function () {
  const OT = (globalThis.OT = globalThis.OT || {});
  const { MAX_BLOCKS } = OT.protocol;

  function isqrt(n) {
    let x = Math.floor(Math.sqrt(n));
    while (x * x > n) x--;
    while ((x + 1) * (x + 1) <= n) x++;
    return x;
  }

  const cdfCache = new Map();

  /** Cumulative robust-soliton distribution; entry i is P(degree <= i + 1). */
  function solitonCdf(k) {
    const cached = cdfCache.get(k);
    if (cached) return cached;
    const weights = new Float64Array(k);
    if (k === 1) {
      weights[0] = 1;
    } else {
      // R ~ 0.4 sqrt(k) and a fixed ln(R/delta) of 2 stand in for the textbook
      // logarithms; the shape is what matters, not the exact constants.
      const r = Math.max(1, (isqrt(k) * 2) / 5);
      const spike = Math.min(k, Math.max(1, Math.floor(k / r)));
      for (let d = 1; d <= k; d++) {
        let w = d === 1 ? 1 / k : 1 / (d * (d - 1));
        if (d < spike) w += r / (d * k);
        else if (d === spike) w += (r * 2) / k;
        weights[d - 1] = w;
      }
    }
    let sum = 0;
    for (let i = 0; i < k; i++) sum += weights[i];
    const cdf = new Float64Array(k);
    let acc = 0;
    for (let i = 0; i < k; i++) {
      acc += weights[i] / sum;
      cdf[i] = acc;
    }
    cdf[k - 1] = 1;
    if (cdfCache.size > 8) cdfCache.clear();
    cdfCache.set(k, cdf);
    return cdf;
  }

  // xorshift32, seeded from the session and sequence number
  function makeRng(sessionId, seq) {
    let state = (Math.imul(sessionId ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seq + 1, 0xc2b2ae35)) >>> 0;
    if (state === 0) state = 0x1234567;
    const next = () => {
      let x = state;
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      state = x;
      return x;
    };
    for (let i = 0; i < 4; i++) next();
    return next;
  }

  /** The source blocks XORed into frame `seq`. */
  function blockIndices(k, sessionId, seq) {
    if (seq < k) return [seq];
    const next = makeRng(sessionId, seq);
    const cdf = solitonCdf(k);
    const u = next() / 4294967296;
    let lo = 0;
    let hi = k - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] >= u) hi = mid;
      else lo = mid + 1;
    }
    const degree = lo + 1;
    const chosen = new Set();
    while (chosen.size < degree) chosen.add(next() % k);
    return [...chosen].sort((a, b) => a - b);
  }

  function xorInto(dst, src) {
    for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
  }

  class FountainEncoder {
    constructor(data, blockLen, sessionId) {
      this.blockLen = blockLen;
      this.sessionId = sessionId;
      this.k = Math.max(1, Math.ceil(data.length / blockLen));
      if (this.k > MAX_BLOCKS) throw new RangeError("payload needs more than 65535 blocks; raise the frame size");
      this.blocks = [];
      for (let i = 0; i < this.k; i++) {
        const block = new Uint8Array(blockLen); // zero-padded tail
        block.set(data.subarray(i * blockLen, (i + 1) * blockLen));
        this.blocks.push(block);
      }
    }

    payload(seq) {
      const out = new Uint8Array(this.blockLen);
      for (const i of blockIndices(this.k, this.sessionId, seq)) xorInto(out, this.blocks[i]);
      return out;
    }
  }

  /** Peeling decoder. Feed it frames in any order; duplicates are ignored. */
  class FountainDecoder {
    constructor(k, blockLen, totalLen, sessionId) {
      this.k = k;
      this.blockLen = blockLen;
      this.totalLen = totalLen;
      this.sessionId = sessionId;
      this.blocks = new Array(k).fill(undefined);
      this.waiting = new Map(); // block index -> Set of equations mentioning it
      this.seen = new Set();
      this.solved = 0;
    }

    get received() {
      return this.seen.size;
    }

    get complete() {
      return this.solved === this.k;
    }

    /** Returns false when the frame was a duplicate. */
    add(seq, payload) {
      if (this.seen.has(seq) || payload.length !== this.blockLen) return false;
      this.seen.add(seq);
      if (this.complete) return true;

      const data = payload.slice();
      const indices = [];
      for (const i of blockIndices(this.k, this.sessionId, seq)) {
        const known = this.blocks[i];
        if (known) xorInto(data, known);
        else indices.push(i);
      }
      this._place({ indices, data });
      return true;
    }

    _place(first) {
      const queue = [first];
      while (queue.length > 0) {
        const eq = queue.pop();
        if (eq.indices.length === 0) continue;
        if (eq.indices.length > 1) {
          for (const i of eq.indices) {
            let set = this.waiting.get(i);
            if (!set) this.waiting.set(i, (set = new Set()));
            set.add(eq);
          }
          continue;
        }
        const index = eq.indices[0];
        if (this.blocks[index]) continue;
        this.blocks[index] = eq.data;
        this.solved++;
        const dependants = this.waiting.get(index);
        this.waiting.delete(index);
        if (!dependants) continue;
        for (const other of dependants) {
          // The equation that just solved this block may still be listed here.
          if (other === eq) continue;
          other.indices = other.indices.filter((i) => i !== index);
          xorInto(other.data, eq.data);
          if (other.indices.length <= 1) queue.push(other);
        }
      }
    }

    /** The reassembled container bytes, or undefined until complete. */
    result() {
      if (!this.complete) return undefined;
      const out = new Uint8Array(this.k * this.blockLen);
      this.blocks.forEach((block, i) => out.set(block, i * this.blockLen));
      return out.subarray(0, this.totalLen);
    }
  }

  OT.fountain = { solitonCdf, blockIndices, FountainEncoder, FountainDecoder };
})();
