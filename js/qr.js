// QR rendering on top of the vendored `qrcode` bundle (js/vendor/qrcode.js).
(function () {
  const OT = (globalThis.OT = globalThis.OT || {});

  /** Quiet-zone modules around the code (the QR spec asks for 4). */
  const QUIET_ZONE = 4;

  // Pinning the mask skips the spec's 8-way mask scoring (several times faster)
  // and keeps every frame at identical geometry.
  const MASK_PATTERN = 4;

  /** Returns { matrix: { size, isDark(x, y) }, version }. */
  function createQr(bytes, ecc, version) {
    const qr = QRCodeLib.create([{ data: bytes, mode: "byte" }], {
      errorCorrectionLevel: ecc,
      maskPattern: MASK_PATTERN,
      version,
    });
    const size = qr.modules.size;
    return {
      matrix: { size, isDark: (x, y) => qr.modules.get(y, x) === 1 },
      version: qr.version,
    };
  }

  /** Draws on a canvas at an integer pixel scale, so modules stay perfectly crisp. */
  function drawQr(canvas, qr, availablePx) {
    const total = qr.size + QUIET_ZONE * 2;
    const scale = Math.max(1, Math.floor(availablePx / total));
    const px = total * scale;
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000";
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.isDark(x, y)) ctx.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale);
      }
    }
  }

  OT.qr = { QUIET_ZONE, createQr, drawQr };
})();
