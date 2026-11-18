import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Arc 要求 Geist 做显示字体、Inter 做正文字体。
// 用 fontsource 本地打包，不依赖 Google Fonts（国内更稳）。
import "@fontsource-variable/inter";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";

import "./app.css";
import "../index.css";
import { MiraiApp } from "./MiraiApp";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root 挂载点");

createRoot(root).render(
  <StrictMode>
    <MiraiApp />
  </StrictMode>,
);
