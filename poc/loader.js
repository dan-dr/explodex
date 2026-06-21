/*
 * Explodex Renderer Loader
 *
 * Loads the SDK, then DOM plugin entrypoints from ./explodex/plugins/<id>/index.js
 */
(function () {
  const SDK_URL = "./explodex/explodex-sdk.js";
  const PLUGINS = [
    "./explodex/plugins/reasoning-effort-prefix/index.js",
    "./explodex/plugins/pin-scope-menu/index.js",
    "./explodex/plugins/usage-reset-sidebar/index.js",
  ];

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve(url);
      s.onerror = (e) => reject(new Error(`Failed to load ${url}: ${e}`));
      document.head.appendChild(s);
    });
  }

  async function load() {
    if (!window.Explodex?.version) {
      await loadScript(SDK_URL);
      console.info("[Explodex] SDK loaded via loader");
    }
    for (const pluginUrl of PLUGINS) {
      try {
        await loadScript(pluginUrl);
        console.info("[Explodex] plugin loaded", pluginUrl);
      } catch (err) {
        console.warn("[Explodex] plugin failed", pluginUrl, err);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => load().catch(console.warn), {
      once: true,
    });
  } else {
    load().catch(console.warn);
  }
})();
