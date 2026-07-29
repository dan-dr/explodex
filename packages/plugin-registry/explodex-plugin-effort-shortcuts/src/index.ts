import { definePlugin } from "@explodex/sdk";

export default definePlugin({
  setup(api) {
    api.log.info("Effort Shortcuts migration is staged for the next registry feature.");
  },
});
