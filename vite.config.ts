import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gateway = process.env.CAUTEM_GATEWAY_TARGET ?? "https://127.0.0.1:17670";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/auth/oidc-config": { target: gateway, changeOrigin: true, secure: false },
      "/v1/": { target: gateway, changeOrigin: true, secure: false, ws: true },
    },
  },
});
