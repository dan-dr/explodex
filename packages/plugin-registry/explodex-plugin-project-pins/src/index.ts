import { definePlugin } from "@explodex/sdk";

export default definePlugin({
  setup(api) {
    api.log.info("Project Pins migration is staged for the next registry feature.");
  },
});
