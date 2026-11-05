(function () {
  const OT = (globalThis.OT = globalThis.OT || {});
  const { $, WakeLock, formatBytes, showError } = OT.dom;
  const { ContainerError, safeFileName, unpackContainer } = OT.container;
  const { StreamReceiver } = OT.receiver;

  const SCAN_WIDTH = 1024;

  const LAST_ERROR_HINT = {
    version: "Seeing a code from a newer version of this app. Reload both devices.",
    "not-ours": "Seeing a QR code that does not belong to this app.",
    corrupt: "A code was read incorrectly. Hold steady.",
    invalid: "Seeing a transfer larger than the size limit set above, or a damaged code.",
  };

  OT.initReceive = function initReceive() {
    const idle = $("recv-idle");
    const live = $("recv-live");
    const done = $("recv-done");
    const video = $("recv-video");
    const error = $("recv-error");
    const stats = $("recv-stats");
    const fill = $("recv-fill");
    const bar = $("recv-bar");
    const wake = new WakeLock();
    const cameraField = $("recv-camera-field");
    const cameraSelect = $("recv-camera");

    let stream;
    let scanning = false;
    let objectUrl;

    const maxBytes = () => Number($("recv-max").value) * 1048576;

    function stopCamera() {
      scanning = false;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = undefined;
      video.srcObject = null;
      wake.release();
    }

    // Lists cameras only when there is a real choice; labels and ids need camera permission first.
    async function refreshCameras() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      let cameras;
      try {
        cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId);
      } catch {
        return;
      }
      const track = stream && stream.getVideoTracks()[0];
      const current = (track && track.getSettings().deviceId) || cameraSelect.value;
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "Automatic (rear camera)";
      cameraSelect.replaceChildren(
        auto,
        ...cameras.map((d, i) => {
          const option = document.createElement("option");
          option.value = d.deviceId;
          option.textContent = d.label || "Camera " + (i + 1);
          return option;
        }),
      );
      if (cameras.some((d) => d.deviceId === current)) cameraSelect.value = current;
      cameraField.hidden = cameras.length < 2;
    }

    async function openStream(deviceId) {
      const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      const video = deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: "environment", ...size };
      try {
        return await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        if (!deviceId || !e || e.name !== "OverconstrainedError") throw e;
        return openStream(undefined);
      }
    }

    async function switchCamera() {
      if (!scanning) return;
      // Some phones cannot open two cameras at once, so release the current one first.
      stream.getTracks().forEach((t) => t.stop());
      try {
        stream = await openStream(cameraSelect.value);
      } catch {
        reset();
        return showError(error, "Could not switch to that camera.");
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      refreshCameras();
    }

    function reset() {
      stopCamera();
      idle.querySelector(".lead").after(cameraField);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
      live.hidden = true;
      done.hidden = true;
      idle.hidden = false;
    }

    async function start() {
      showError(error, undefined);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return showError(error, "Camera access needs a secure (HTTPS) page and a supported browser.");
      }
      try {
        stream = await openStream(cameraSelect.value);
      } catch (e) {
        const name = e && e.name;
        return showError(
          error,
          name === "NotAllowedError"
            ? "Camera permission was denied. Allow it in the browser's site settings and try again."
            : name === "NotFoundError"
              ? "No camera found on this device."
              : "Could not open the camera.",
        );
      }

      video.srcObject = stream;
      await video.play().catch(() => {});
      idle.hidden = true;
      live.hidden = false;
      live.prepend(cameraField);
      refreshCameras();
      wake.acquire();
      stats.textContent = "Looking for a code…";
      fill.style.width = "0";
      bar.setAttribute("aria-valuenow", "0");
      scan();
    }

    function scan() {
      const receiver = new StreamReceiver(maxBytes());
      const scratch = document.createElement("canvas");
      const ctx = scratch.getContext("2d", { willReadFrequently: true });
      scanning = true;
      let startedAt = 0;
      let lastPaint = 0;

      const next = () => {
        if (!scanning) return;
        if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(grab);
        else requestAnimationFrame(grab);
      };

      const grab = () => {
        if (!scanning) return;
        if (video.videoWidth > 0) {
          const scale = Math.min(1, SCAN_WIDTH / video.videoWidth);
          scratch.width = Math.round(video.videoWidth * scale);
          scratch.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, scratch.width, scratch.height);
          const image = ctx.getImageData(0, 0, scratch.width, scratch.height);
          const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
          if (code) handle(Uint8Array.from(code.binaryData));
        }
        next();
      };

      const handle = (bytes) => {
        if (!startedAt) startedAt = performance.now();
        const state = receiver.push(bytes);
        if (state.complete) {
          const result = receiver.result();
          stopCamera();
          finish(result);
          return;
        }
        const now = performance.now();
        if (now - lastPaint < 100) return;
        lastPaint = now;
        const pct = state.k ? Math.floor((state.solved / state.k) * 100) : 0;
        fill.style.width = pct + "%";
        bar.setAttribute("aria-valuenow", String(pct));
        const seconds = (now - startedAt) / 1000;
        const rate = seconds > 0.5 ? (state.totalLen * (state.solved / state.k)) / seconds : 0;
        const hint = state.lastError ? " · " + (LAST_ERROR_HINT[state.lastError] || "") : "";
        stats.textContent =
          `${pct}% · ${state.solved}/${state.k} blocks · ${state.received} frames · ${formatBytes(state.totalLen)}` +
          (rate ? ` · ≈ ${formatBytes(rate)}/s` : "") +
          hint;
      };

      grab();
    }

    async function finish(bytes) {
      let payload;
      try {
        payload = await unpackContainer(bytes, maxBytes());
      } catch (e) {
        reset();
        showError(error, e instanceof ContainerError ? e.message : "The received data could not be read.");
        return;
      }
      live.hidden = true;
      done.hidden = false;
      $("done-title").textContent = payload.isText ? "Text received" : safeFileName(payload.name);
      $("done-meta").textContent = `${formatBytes(payload.data.length)} · checksum verified`;

      const textArea = $("done-text");
      const copy = $("done-copy");
      const save = $("done-save");
      textArea.hidden = copy.hidden = !payload.isText;
      if (payload.isText) textArea.value = new TextDecoder().decode(payload.data);

      // Files are only ever offered as a plain download, never rendered in-page.
      const fileName = payload.isText ? "text.txt" : safeFileName(payload.name);
      objectUrl = URL.createObjectURL(new Blob([payload.data], { type: "application/octet-stream" }));
      save.onclick = () => {
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = fileName;
        a.click();
      };
      copy.onclick = () => {
        if (navigator.clipboard) navigator.clipboard.writeText(textArea.value).then(() => (copy.textContent = "Copied"));
      };
      copy.textContent = "Copy text";
    }

    cameraSelect.addEventListener("change", switchCamera);
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", refreshCameras);
    }
    refreshCameras();
    $("recv-start").addEventListener("click", start);
    $("recv-stop").addEventListener("click", reset);
    $("done-again").addEventListener("click", reset);
    document.addEventListener("visibilitychange", () => {
      if (scanning && document.visibilityState === "visible") wake.acquire();
    });
  };
})();
