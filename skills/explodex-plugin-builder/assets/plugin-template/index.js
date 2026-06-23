/**
 * Explodex plugin: <name>
 *
 * <one-line description>
 */
(function registerMyPlugin(global) {
  const Explodex = global.Explodex;
  if (!Explodex?.plugins?.register) {
    console.warn("[my-plugin] Explodex SDK not loaded");
    return;
  }

  Explodex.plugins.register(
    {
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { components: c, log, mount, waitFor } = api;

      let disposed = false;

      const render = () =>
        mount("aboveComposer", () =>
          c.button({
            label: "My action",
            color: "secondary",
            size: "composerSm",
            onClick: () => log.info("clicked"),
          }),
        );

      render();
      const stopWait = waitFor("aboveComposer", render);

      log.info("ready");

      return () => {
        disposed = true;
        stopWait();
        log.info("teardown");
      };
    },
  );
})(window);