import { definePlugin } from "@explodex/sdk";
import { setupEffortShortcuts } from "./runtime";

export default definePlugin({
  setup: setupEffortShortcuts,
});
