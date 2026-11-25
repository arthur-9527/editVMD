/**
 * 视口卡片：包住 EngineHost 的 canvas，并把状态浮层叠在右下角。
 *
 * 关键点
 * ------
 *   - EngineHost 内部依赖 position:relative 的父容器来定位 HUD，所以卡片保留 relative；
 *   - 圆角 + overflow:hidden 让 canvas 被裁成圆角（canvas 自身不认 border-radius）；
 *   - 状态浮层放在卡片内、canvas 之上，pointer-events:none 不挡鼠标；
 *   - EngineBridge 与 EngineHost 同级挂载：它只做引擎副作用，不渲染内容。
 */

import EngineHost, {
  type BoneOverlayMode,
  type EngineHostHandle,
  type GizmoDragHandler,
  type RaycastHandler,
} from "../engine/EngineHost.tsx";
import { EngineBridge } from "../engine/EngineBridge.tsx";
import { Card } from "./primitives/Card.tsx";
import { StatusHUD, type StatusKind } from "./StatusHUD.tsx";

export interface ViewportProps {
  onReady: (handle: EngineHostHandle) => void;
  onStatus: (s: { kind: StatusKind; message?: string }) => void;
  statusKind: StatusKind;
  statusMessage?: string;
  engineReady: boolean;
  busy: boolean;
  /** 引擎句柄（EngineBridge 用它做选择 / 相机 / 物理同步） */
  engineRef: { current: EngineHostHandle | null };
  /** 视口双击选骨 / 3D 手柄拖拽 */
  onRaycast: RaycastHandler;
  onGizmoDrag: GizmoDragHandler;
  /** 骨架显示模式：none / all（整具）/ main（只主骨骼方块） */
  boneOverlayMode: BoneOverlayMode;
  /** 主骨骼白名单（`main` 模式使用） */
  boneOverlayBones?: readonly string[];
  /** 是否有相机轨（有则显示「跟拍 / 环绕」切换按钮） */
  hasCameraTrack: boolean;
  /** 相机轨是否在驱动视口 */
  cameraVmdEnabled: boolean;
  onToggleCameraVmd: () => void;
}

export default function Viewport({
  onReady,
  onStatus,
  statusKind,
  statusMessage,
  engineReady,
  busy,
  engineRef,
  onRaycast,
  onGizmoDrag,
  boneOverlayMode,
  boneOverlayBones,
  hasCameraTrack,
  cameraVmdEnabled,
  onToggleCameraVmd,
}: ViewportProps) {
  return (
    <Card className="min-h-0 flex-1 overflow-hidden">
      <EngineHost onReady={onReady} onStatus={onStatus} onRaycast={onRaycast} onGizmoDrag={onGizmoDrag} />
      <EngineBridge
        engineRef={engineRef}
        boneOverlayMode={boneOverlayMode}
        boneOverlayBones={boneOverlayBones}
      />

      {/* 视口驱动源：有相机轨时给出「跟拍 / 环绕」切换 */}
      {hasCameraTrack && (
        <button
          type="button"
          onClick={onToggleCameraVmd}
          title={cameraVmdEnabled ? "相机轨驱动视口（点击改为自由环绕）" : "自由环绕（点击改为相机轨跟拍）"}
          className={
            "absolute right-3 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-ctl border transition-colors " +
            (cameraVmdEnabled
              ? "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25"
              : "border-line-strong bg-raised text-dim hover:text-fg")
          }
        >
          {cameraVmdEnabled ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m22 8-6 4 6 4V8Z" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
          )}
        </button>
      )}

      <StatusHUD kind={statusKind} message={statusMessage} engineReady={engineReady} busy={busy} />
    </Card>
  );
}
