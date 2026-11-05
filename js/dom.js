(function () {
  const OT = (globalThis.OT = globalThis.OT || {});

  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error("Missing element #" + id);
    return el;
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function showError(el, message) {
    el.textContent = message || "";
    el.hidden = !message;
  }

  /** Keeps the screen on while a transfer is running, where the browser allows it. */
  class WakeLock {
    async acquire() {
      try {
        this.sentinel = await navigator.wakeLock.request("screen");
      } catch {
        /* optional */
      }
    }
    release() {
      if (this.sentinel) this.sentinel.release().catch(() => {});
      this.sentinel = undefined;
    }
  }

  OT.dom = { $, formatBytes, showError, WakeLock };
})();
