import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom", // provides window, document, localStorage
    include: ["tests-js/**/*.test.js"],
  },
});
