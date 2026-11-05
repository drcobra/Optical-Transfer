(function () {
  const OT = (globalThis.OT = globalThis.OT || {});
  const { $, WakeLock, formatBytes, showError } = OT.dom;
  const { ContainerError, MAX_FILE_BYTES, packContainer } = OT.container;
  const { FountainEncoder } = OT.fountain;
  const { HEADER_LEN, blockCount, encodeFrame, minimumBlockLen } = OT.protocol;
  const { createQr, drawQr } = OT.qr;

  // Largest byte-mode payload per QR version 40 at each error-correction level.
  const QR_CAPACITY = { L: 2953, M: 2331 };

  OT.initSend = function initSend() {
    const form = $("send-form");
    const stage = $("send-stage");
    const canvas = $("qr-canvas");
    const box = $("qr-box");
    const stats = $("send-stats");
    const error = $("send-error");
    const startButton = $("send-start");
    const wake = new WakeLock();

    let running = false;
    let raf = 0;

    function stop() {
      running = false;
      cancelAnimationFrame(raf);
      wake.release();
      if (document.fullscreenElement) document.exitFullscreen();
      stage.hidden = true;
      form.hidden = false;
    }

    async function start() {
      showError(error, undefined);
      const file = $("send-file").files[0];
      const text = $("send-text").value;
      const frameBytes = Number($("send-size").value);
      const fps = Number($("send-fps").value);
      const ecc = $("send-ecc").value;

      if (!file && !text) return showError(error, "Choose a file or enter some text first.");
      if (file && file.size > MAX_FILE_BYTES) {
        return showError(
          error,
          `That file is ${formatBytes(file.size)}; the limit is ${Math.floor(MAX_FILE_BYTES / 1048576)} MB.`,
        );
      }

      startButton.disabled = true;
      try {
        const payload = file
          ? { name: file.name, mime: file.type, isText: false, data: new Uint8Array(await file.arrayBuffer()) }
          : { name: "text.txt", mime: "text/plain", isText: true, data: new TextEncoder().encode(text) };
        const container = await packContainer(payload);

        const blockLen = Math.max(frameBytes - HEADER_LEN, minimumBlockLen(container.length));
        if (blockLen + HEADER_LEN > QR_CAPACITY[ecc]) throw new ContainerError("This transfer is too large to encode.");

        const sessionId = crypto.getRandomValues(new Uint32Array(1))[0];
        const info = { sessionId, blockLen, totalLen: container.length, k: blockCount(container.length, blockLen) };
        const encoder = new FountainEncoder(container, blockLen, sessionId);

        form.hidden = true;
        stage.hidden = false;
        running = true;
        wake.acquire();

        let seq = 0;
        let last = 0;
        let version;
        const interval = 1000 / fps;

        const tick = (now) => {
          if (!running) return;
          if (now - last >= interval) {
            last = now;
            const bytes = encodeFrame(info, seq, encoder.payload(seq));
            const qr = createQr(bytes, ecc, version);
            if (version === undefined) version = qr.version;
            drawQr(canvas, qr.matrix, Math.max(Math.floor(box.clientWidth * devicePixelRatio), 1));
            const pass = Math.floor(seq / info.k) + 1;
            stats.textContent =
              `Frame ${seq + 1} · ${info.k} blocks · pass ${pass} · ${formatBytes(container.length)} total · ` +
              `≈ ${formatBytes(blockLen * fps)}/s`;
            seq = (seq + 1) % 0x100000000;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        stop();
        showError(error, e instanceof Error ? e.message : "Could not start.");
      } finally {
        startButton.disabled = false;
      }
    }

    startButton.addEventListener("click", start);
    $("send-stop").addEventListener("click", stop);
    $("send-full").addEventListener("click", () => box.requestFullscreen && box.requestFullscreen());
    // Wake locks are released when the page is hidden; take one again on return.
    document.addEventListener("visibilitychange", () => {
      if (running && document.visibilityState === "visible") wake.acquire();
    });
  };
})();
