// Turns a received stream of frames into a payload. Pure logic, no DOM, so the
// whole receive path can be tested without a camera.
(function () {
  const OT = (globalThis.OT = globalThis.OT || {});
  const { decodeFrame, isFrame } = OT.protocol;
  const { FountainDecoder } = OT.fountain;

  /** Frames from another session must repeat this many times before we switch. */
  const SWITCH_AFTER = 5;

  class StreamReceiver {
    constructor(maxBytes) {
      this.maxBytes = maxBytes;
      this.decoder = undefined;
      this.candidate = undefined;
      this.lastError = undefined;
    }

    push(bytes) {
      const frame = decodeFrame(bytes, this.maxBytes);
      if (!isFrame(frame)) {
        this.lastError = frame;
        return this.state();
      }
      this.lastError = undefined;

      const d = this.decoder;
      if (!d) {
        this._start(frame);
      } else if (
        d.sessionId !== frame.sessionId ||
        d.k !== frame.k ||
        d.blockLen !== frame.blockLen ||
        d.totalLen !== frame.totalLen
      ) {
        // A different sender took over; require a few consecutive frames so one
        // stray scan of a neighbouring screen cannot wipe progress.
        if (this.candidate && this.candidate.sessionId === frame.sessionId) this.candidate.count++;
        else this.candidate = { sessionId: frame.sessionId, count: 1 };
        if (this.candidate.count >= SWITCH_AFTER) this._start(frame);
        return this.state();
      }
      this.candidate = undefined;
      this.decoder.add(frame.seq, frame.payload);
      return this.state();
    }

    _start(frame) {
      this.decoder = new FountainDecoder(frame.k, frame.blockLen, frame.totalLen, frame.sessionId);
      this.candidate = undefined;
    }

    result() {
      return this.decoder ? this.decoder.result() : undefined;
    }

    state() {
      const d = this.decoder;
      return {
        sessionId: d ? d.sessionId : undefined,
        k: d ? d.k : 0,
        solved: d ? d.solved : 0,
        received: d ? d.received : 0,
        totalLen: d ? d.totalLen : 0,
        lastError: this.lastError,
        complete: d ? d.complete : false,
      };
    }
  }

  OT.receiver = { StreamReceiver };
})();
