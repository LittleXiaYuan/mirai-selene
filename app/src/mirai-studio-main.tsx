import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MiraiStudio } from "./MiraiStudio";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root 挂载点");

createRoot(root).render(
  <StrictMode>
    <MiraiStudio />
  </StrictMode>,
);
