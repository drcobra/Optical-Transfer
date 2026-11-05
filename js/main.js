(function () {
  const { $ } = OT.dom;

  function route() {
    const view = location.hash === "#receive" ? "receive" : "send";
    for (const name of ["send", "receive"]) {
      $("view-" + name).hidden = name !== view;
      const tab = $("tab-" + name);
      if (name === view) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
  }

  OT.initSend();
  OT.initReceive();
  window.addEventListener("hashchange", route);
  route();

  // Offline support needs a real http(s) origin; it is skipped when opened from disk.
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
