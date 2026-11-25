import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary, useGlobalErrorCapture } from "./ui/CrashScreen.tsx";
import "./styles/index.css";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

/**
 * 根级包装：错误边界 + 全局异步错误钩子。
 *
 * ★ 边界必须在 <App> **外面** —— 放在里面时，App 自身渲染失败
 *   会连边界一起卸载，剩下的仍是白屏。
 *
 * 钩子组件单独抽出来，是因为 `useGlobalErrorCapture` 是 hook，
 * 不能直接写在 render 里。
 */
function Root() {
  useGlobalErrorCapture();
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
