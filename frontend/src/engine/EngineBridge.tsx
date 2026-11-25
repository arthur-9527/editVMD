/**
 * EngineBridge：headless 组件，负责所有「与引擎耦合」的副作用。
 *
 * 返回 null —— 它不渲染任何东西，只是把 store 与引擎连起来：
 *
 *   1. 选择镜像：store 的 selection / gizmoVisible → engine.setSelectedBone / setSelectedMaterial；
 *   2. 骨架叠加层：boneOverlayMode（none/all/main）+ 主骨骼白名单 → engine.setBoneOverlayMode；
 *   3. 相机轨镜像：clip.camera 数组 → engine.attachCamera；
 *   4. 视口双击选骨 / 3D 手柄拖拽的处理函数（作为 props 交给 <EngineHost>）；
 *   5. 跳帧物理重置：seek 跨度大时下一帧 resetPhysics（避免刚体爆炸）。
 *
 * ★ 它被放在 <Viewport> 里、与 <EngineHost> 同级，
 *   这样引擎就绪时 `engineRef` 已经可用，副作用不会抢跑。
 */

import { useCallback, useEffect, useRef } from "react";
import type { BoneOverlayMode, EngineHostHandle, GizmoDragHandler, RaycastHandler } from "./EngineHost.tsx";
import type { BoneKeyframe, Quat4, Vec3Like } from "../doc/types.ts";
import { insertBoneKey, makeBoneKeyframe, poseAtFrame } from "../doc/clip-ops.ts";
import { usePlaybackFrameRef } from "../state/playback-store.tsx";
import { useStudioActions, useStudioSelector } from "../state/studio-store.tsx";

/** 跳帧超过这个帧数才重置物理（连续平滑拖动不需要） */
const RESET_PHYSICS_FRAME_THRESHOLD = 2;

export interface EngineBridgeProps {
  engineRef: { current: EngineHostHandle | null };
  /**
   * 视口骨架显示模式（下侧栏「关键帧」工具栏切换）。
   *
   *   `all`  —— 整具骨架（改动前的原生样式）；
   *   `main` —— 只画主骨骼 + 足 IK 的方块标记（方便鼠标点选）；
   *   `none` —— 不显示。
   */
  boneOverlayMode: BoneOverlayMode;
  /**
   * 要显示的主骨骼白名单（`lib/bone-overlay.ts` 计算），`main` 模式使用。
   */
  boneOverlayBones?: readonly string[];
}

export interface EngineBridgeCallbacks {
  onRaycast: RaycastHandler;
  onGizmoDrag: GizmoDragHandler;
}

/**
 * 生成视口交互回调。
 *
 * ★ 单独导出成 hook，是因为回调必须在 <EngineHost> 构造前就绪
 *   （引擎构造期一次性注册），而回调内部又要读最新的 clip。
 *   用 ref 保存 clip，回调本身保持引用稳定。
 */
export function useEngineCallbacks(
  engineRef: { current: EngineHostHandle | null },
  /** 当前骨架显示模式。`all` 模式下骨骼太多，禁用视口选骨以免误选。 */
  boneOverlayMode: BoneOverlayMode = "none",
): EngineBridgeCallbacks {
  const clip = useStudioSelector((s) => s.clip);
  const clipRef = useRef(clip);
  clipRef.current = clip;

  const currentFrameRef = usePlaybackFrameRef();
  const { commit, setSelection, setGizmoVisible } = useStudioActions();

  const dragDirtyRef = useRef(false);

  const onRaycast = useCallback<RaycastHandler>(
    (modelName, _material, bone) => {
      // ★ 「全部骨骼」模式下骨骼太多，用户明确要求不可选中：直接忽略视口点选
      if (boneOverlayMode === "all") return;
      if (!modelName) {
        // 点在空处 → 只收起手柄，不动选择（保留属性面板上下文）
        setGizmoVisible(false);
        return;
      }
      if (bone) {
        setSelection({ kind: "bone", name: bone });
        // 伸手到视口里双击骨骼本身就是「我要抓它」的表示
        setGizmoVisible(true);
      }
    },
    [setSelection, setGizmoVisible, boneOverlayMode],
  );

  const onGizmoDrag = useCallback<GizmoDragHandler>(
    (e) => {
      const handle = engineRef.current;
      if (!handle) return;

      if (e.phase === "start") {
        dragDirtyRef.current = false;
        setSelection({ kind: "bone", name: e.boneName });
        setGizmoVisible(true);
        return;
      }

      const clipNow = clipRef.current;
      const frame = Math.round(Math.max(0, Math.min(clipNow.frameCount, currentFrameRef.current)));
      const bone = e.boneName;
      const track = clipNow.boneTracks[bone] ?? [];
      const existing = track.find((k) => k.frame === frame);

      let rotation: Quat4;
      let translation: Vec3Like;
      if (existing) {
        rotation = e.kind === "rotate" ? e.localRotation : existing.rotation;
        translation = e.kind === "translate" ? e.localTranslation : existing.translation;
      } else {
        // 该帧还没有关键帧：先让引擎停到该帧，读回当前姿态补齐未拖动的通道
        handle.syncClip(clipNow, frame);
        const pose = handle.getBoneLocalPose(bone) ?? poseAtFrame(clipNow, bone, frame);
        rotation = e.kind === "rotate" ? e.localRotation : pose.rotation;
        translation = e.kind === "translate" ? e.localTranslation : pose.translation;
      }

      const nextKf: BoneKeyframe = existing
        ? { ...existing, rotation, translation }
        : makeBoneKeyframe(bone, frame, { rotation, translation });
      const nextClip = insertBoneKey(clipNow, bone, nextKf);
      clipRef.current = nextClip;

      // 拖拽期间直接推给引擎（不进历史）
      handle.syncClip(nextClip, frame);

      if (e.phase === "end") {
        if (dragDirtyRef.current) commit(nextClip, { label: "手柄调整骨骼" });
        dragDirtyRef.current = false;
      } else {
        dragDirtyRef.current = true;
      }
    },
    [engineRef, currentFrameRef, setSelection, setGizmoVisible, commit],
  );

  return { onRaycast, onGizmoDrag };
}

/** 与引擎同步的副作用（选择 / 叠加层 / 相机 / 物理） */
export function EngineBridge({ engineRef, boneOverlayMode, boneOverlayBones }: EngineBridgeProps) {
  const selection = useStudioSelector((s) => s.selection);
  const gizmoVisible = useStudioSelector((s) => s.gizmoVisible);
  const selectedMaterial = useStudioSelector((s) => s.selectedMaterial);
  const cameraTrack = useStudioSelector((s) => s.clip.camera);

  // ---------------------------------------------------------------- 选择镜像
  useEffect(() => {
    const handle = engineRef.current;
    if (!handle) return;
    const bone = selection.kind === "bone" ? selection.name : null;
    // gizmo 与骨骼选择解耦：只有明确要求时才挂手柄。
    // ★ 骨架显示关闭时必须摘掉手柄 —— 否则关掉骨骼后旋转球还留在视口里。
    const showGizmo = gizmoVisible && boneOverlayMode !== "none";
    // ★ 高亮恒生效：选中骨骼名**始终**交给引擎 —— 骨架叠加层（整具 / 主骨方块）
    //   据此高亮该骨，点侧栏任意骨骼都能在模型上看清是哪一根。
    //   以前传的是 `showGizmo ? bone : null`，没开手柄时等于把选择也丢了。
    handle.setSelectedBone(bone);
    // 手柄单独开关：只有明确要求、且骨架可见时才显示（关骨骼要收起旋转球）。
    handle.setGizmoEnabled(showGizmo);
  }, [selection, gizmoVisible, boneOverlayMode, engineRef]);

  // 材质高亮（与骨骼选择互斥，store 已保证）
  useEffect(() => {
    engineRef.current?.setSelectedMaterial(selectedMaterial);
  }, [selectedMaterial, engineRef]);

  // ---------------------------------------------------------------- 骨架叠加层
  // ★ 三态 + 主骨骼白名单：all 用引擎原生整具骨架；main 只画主骨方块
  useEffect(() => {
    engineRef.current?.setBoneOverlayMode(boneOverlayMode, boneOverlayBones);
  }, [boneOverlayMode, boneOverlayBones, engineRef]);

  // ---------------------------------------------------------------- 相机轨镜像
  // 编辑相机后数组引用变化 → 立刻推到引擎，视口立即反映新镜头。
  useEffect(() => {
    engineRef.current?.attachCamera(cameraTrack);
  }, [cameraTrack, engineRef]);

  return null;
}

/** 暴露给 App：seek 后按需重置物理 */
export function usePhysicsReset(engineRef: { current: EngineHostHandle | null }) {
  const lastSeekFrameRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return useCallback(
    (frame: number) => {
      const prev = lastSeekFrameRef.current;
      lastSeekFrameRef.current = frame;
      if (prev !== null && Math.abs(frame - prev) <= RESET_PHYSICS_FRAME_THRESHOLD) return;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      // ★ 延迟一帧：引擎下一 tick 才把新姿态传播到物理
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        engineRef.current?.resetPhysics();
      });
    },
    [engineRef],
  );
}
