import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import bks from "@beekeeperstudio/vite-plugin";

export default defineConfig({
  plugins: [vue(), bks()],
  build: {
    // Plugins load from the local disk, so one bundle is simplest.
    chunkSizeWarningLimit: 1000,
  },
});
