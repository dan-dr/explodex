import { definePlugin } from "@explodex/sdk";

export default definePlugin({
  setup(api) {
    api.log.info("Usage and Reset Glance migration is staged for the next registry feature.");
  },
});
