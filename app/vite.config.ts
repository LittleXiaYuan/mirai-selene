import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    // 三个页面都要进生产构建，否则部署上去只有落地页能用。
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "index.html"),
        studio: path.resolve(__dirname, "mirai-studio.html"),
        vn: path.resolve(__dirname, "mirai-vn.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5274,
    proxy: {
      // 本地开发时把用户系统请求转给本机 serve.mjs（生产环境由同一个进程处理）
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      // 统一服务器自己就认 /mirai-api，不要再 rewrite
      "/mirai-api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
