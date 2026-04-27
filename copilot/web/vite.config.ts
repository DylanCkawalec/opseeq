import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 7101,
    proxy: {
      "/v1": "http://127.0.0.1:7100",
      "/graphql": "http://127.0.0.1:7100",
      "/mcp": "http://127.0.0.1:7100",
    },
  },
});
