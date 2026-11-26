/**
 * 左栏：品牌头 + 紧凑菜单 + 可折叠分组（骨骼 / 表情）。
 *
 * 分组逻辑沿用 MMD 日文骨名约定，把几十根骨骼归到可读的类别里，
 * 避免平铺成一坨。列表用虚拟化以外的简单渲染 —— 骨骼数量通常 < 200。
 * 表情同样按名字归类成可折叠分组（见 left/MorphList.tsx）。
 */

import { useState, type ReactNode } from "react";
import {
  Box,
  ChevronRight,
  FolderUp,
  HardDriveDownload,
  HelpCircle,
  Image,
  Redo2,
  Save,
  Undo2,
  Upload,
  Video,
} from "lucide-react";
import { Card } from "./primitives/Card.tsx";
import { Field } from "./primitives/Field.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./primitives/Menu.tsx";
import { PanelStack, type PanelStackSection } from "./layout/PanelStack.tsx";
import { cn } from "./cn.ts";
import { fmtShortcut } from "./platform.ts";
import { BoneTree } from "./left/BoneTree.tsx";
import { MorphList } from "./left/MorphList.tsx";
import type { BoneHierarchyEntry } from "../lib/animation.ts";
import type { MorphMeta } from "../lib/morph-meta.ts";
import type { Selection } from "../doc/types.ts";

export interface LeftPanelProps {
  /** Clip 库（库 / 编排阶段新增；不传则不显示该分组） */
  clipLibrary?: ReactNode;
  boneNames: readonly string[];
  /** 引擎侧骨架层级（有则用父子树渲染，无则退回扁平列表） */
  skeleton?: readonly BoneHierarchyEntry[];
  morphNames: readonly string[];
  /**
   * 表情的**权威分类**（PMX `panel` 字节，见 `lib/morph-meta.ts`）。
   * 不传 / 为空时，MorphList 回落到按名字猜（旧行为）。
   */
  morphMeta?: ReadonlyMap<string, MorphMeta> | null;
  /** 骨架名 → 该骨骼在当前 clip 里的关键帧数（照源 bone-list：名字右边的数字） */
  boneKeyCounts?: Readonly<Record<string, number>>;
  /** 表情名 → 关键帧数 */
  morphKeyCounts?: Readonly<Record<string, number>>;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  // ---- 上传：外部文件 → 系统存储 ----
  onPickPmx: () => void;
  onPickVmd: () => void;
  // ---- 导入 / 保存（系统存储）----
  /** 打开系统资源弹窗并停在「模型」页（导入模型） */
  onOpenAssetsModels?: () => void;
  /** 打开系统资源弹窗并停在「VMD」页（导入 VMD） */
  onOpenAssetsVmd?: () => void;
  /** 把动作库里所有动作保存进系统存储（origin=generated） */
  onSaveActions?: () => void;
  /** 后端是否可用（不可用时系统相关菜单置灰） */
  systemAvailable?: boolean;
  onExportVmd: (tracks: "all" | "motion" | "morphs") => void;
  /** 导出相机 VMD（独立文件） */
  onExportCamera?: () => void;
  onReset: () => void;
  busy: boolean;
  hasModel: boolean;
  hasClip: boolean;
  /** 相机轨道帧数（0 = 无相机） */
  cameraCount?: number;
  /** 撤销 / 重做（App 的 history） */
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;

  // ---- 相机编辑（P1）----
  /** 相机轨是否作为编辑对象 */
  cameraSelected?: boolean;
  /** 点击「相机」行 */
  onSelectCamera?: () => void;

  // ---- 设置（P1）----
  /** 相机轨是否驱动视口 */
  cameraVmdEnabled?: boolean;
  onToggleCameraVmd?: () => void;

  // ---- 参考视频窗口 ----
  /** 参考视频悬浮窗是否打开 */
  videoWindowOpen?: boolean;
  onToggleVideoWindow?: () => void;
}

export default function LeftPanel({
  clipLibrary,
  boneNames,
  skeleton,
  morphNames,
  morphMeta,
  boneKeyCounts,
  morphKeyCounts,
  selection,
  onSelect,
  onPickPmx,
  onPickVmd,
  onOpenAssetsModels,
  onOpenAssetsVmd,
  onSaveActions,
  systemAvailable = true,
  onExportVmd,
  onExportCamera,
  onReset,
  busy,
  hasModel,
  hasClip,
  cameraCount = 0,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  cameraSelected = false,
  onSelectCamera,
  cameraVmdEnabled = true,
  onToggleCameraVmd,
  videoWindowOpen = false,
  onToggleVideoWindow,
}: LeftPanelProps) {
  const [query, setQuery] = useState("");

  const sections: PanelStackSection[] = [
    ...(clipLibrary
      ? [
          {
            id: "clips",
            label: "动作",
            count: undefined,
            children: clipLibrary,
          } satisfies PanelStackSection,
        ]
      : []),
    {
      id: "bones",
      label: "骨骼",
      count: boneNames.length,
      children: (
        <BoneTree
          skeleton={skeleton ?? []}
          fallbackBones={boneNames}
          boneKeyCounts={boneKeyCounts}
          selection={selection}
          onSelect={onSelect}
          query={query}
        />
      ),
    },
    {
      id: "morphs",
      label: "表情",
      count: morphNames.length,
      children: (
        <MorphList
          morphNames={morphNames}
          morphMeta={morphMeta}
          morphKeyCounts={morphKeyCounts}
          selection={selection}
          onSelect={onSelect}
          query={query}
        />
      ),
    },
  ];

  return (
    <Card className="w-[220px] shrink-0">
      {/* 品牌头 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[12.5px] font-semibold tracking-tight text-fg">editVMD</span>
        <span className="rounded-full bg-accent/15 px-1.5 py-px font-mono text-[9.5px] text-accent">v0.1</span>

        {/* 撤销 / 重做：紧贴品牌名右侧，与「当前文档可能被改过」这个语境一致 */}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title={`撤销 (${fmtShortcut("mod+z")})`}
            onClick={onUndo}
            disabled={!canUndo}
            className={cn(
              "grid size-5 place-items-center rounded transition-colors",
              canUndo
                ? "text-dim hover:bg-white/[0.07] hover:text-fg"
                : "cursor-not-allowed text-faint/40",
            )}
          >
            <Undo2 size={12} strokeWidth={2} />
          </button>
          <button
            type="button"
            title={`重做 (${fmtShortcut("mod+shift+z")})`}
            onClick={onRedo}
            disabled={!canRedo}
            className={cn(
              "grid size-5 place-items-center rounded transition-colors",
              canRedo
                ? "text-dim hover:bg-white/[0.07] hover:text-fg"
                : "cursor-not-allowed text-faint/40",
            )}
          >
            <Redo2 size={12} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* 紧凑菜单 */}
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-line px-1">
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="rounded px-2 py-1 text-[11.5px] text-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
            >
              文件
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            {/* ---- 上传：外部文件 → 系统存储 ---- */}
            <MenuItem
              icon={<FolderUp size={12} />}
              shortcut={fmtShortcut("mod+o")}
              onClick={onPickPmx}
              disabled={busy || !systemAvailable}
            >
              上传模型
            </MenuItem>
            <MenuItem
              icon={<Upload size={12} />}
              shortcut={fmtShortcut("mod+i")}
              onClick={onPickVmd}
              disabled={busy || !systemAvailable}
            >
              上传 VMD
            </MenuItem>

            {/* ---- 导入：系统存储 → 当前工作区（uploaded / generated 一视同仁） ---- */}
            <div className="my-1 h-px bg-line" />
            <MenuItem
              icon={<Box size={12} />}
              onClick={onOpenAssetsModels}
              disabled={busy || !systemAvailable}
            >
              载入模型
            </MenuItem>
            <MenuItem
              icon={<Box size={12} />}
              onClick={onOpenAssetsVmd}
              disabled={busy || !systemAvailable}
            >
              导入 VMD
            </MenuItem>

            {/* ---- 保存动作：编排块 → 动作库（不落盘，落盘用动作库每行的存盘）---- */}
            <MenuItem
              icon={<HardDriveDownload size={12} />}
              onClick={onSaveActions}
              disabled={busy}
            >
              保存动作
            </MenuItem>

            {/* ---- 导出到本地磁盘 ---- */}
            <div className="my-1 h-px bg-line" />
            <MenuItem
              icon={<Save size={12} />}
              onClick={() => onExportVmd("all")}
              disabled={!hasClip}
              shortcut={fmtShortcut("mod+s")}
            >
              下载 VMD 到本地
            </MenuItem>
            <MenuItem onClick={() => onExportVmd("motion")} disabled={!hasClip}>
              导出动作
            </MenuItem>
            <MenuItem onClick={() => onExportVmd("morphs")} disabled={!hasClip}>
              导出表情
            </MenuItem>
            <MenuItem onClick={onExportCamera} disabled={cameraCount === 0}>
              导出相机 VMD{cameraCount > 0 ? `（${cameraCount} 帧）` : ""}
            </MenuItem>
            <div className="my-1 h-px bg-line" />
            <MenuItem danger onClick={onReset} disabled={busy}>
              清空编排
            </MenuItem>
          </MenuContent>
        </Menu>

        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="rounded px-2 py-1 text-[11.5px] text-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
            >
              设置
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem
              icon={<Image size={12} />}
              onClick={onToggleCameraVmd}
              checked={cameraVmdEnabled}
              disabled={cameraCount === 0}
            >
              相机轨驱动视口
            </MenuItem>
            <MenuItem
              icon={<Video size={12} />}
              onClick={onToggleVideoWindow}
              checked={videoWindowOpen}
            >
              打开视频捕捉窗口
            </MenuItem>
          </MenuContent>
        </Menu>

        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="rounded px-2 py-1 text-[11.5px] text-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
            >
              帮助
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem icon={<HelpCircle size={12} />} disabled>
              WebGPU 检测说明
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {/* 搜索 */}
      <div className="shrink-0 p-2">
        <Field
          type="search"
          placeholder="搜索骨骼 / 表情…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 text-[11.5px]"
        />
      </div>

      {/* 分组栈 */}
      <PanelStack sections={sections} storageKey="editvmd.panelStack.left" className="flex-1" />

      {/* 相机 —— 一条轨道而不是一个列表项，所以是「可选中」的行而不是可展开的分组 */}
      <button
        type="button"
        onClick={onSelectCamera}
        disabled={cameraCount === 0}
        title={cameraCount === 0 ? "当前动作没有相机轨" : "选中相机轨以编辑其通道"}
        className={cn(
          "flex h-8 w-full shrink-0 items-center gap-2 border-t border-line px-2 text-[11px] transition-colors",
          cameraSelected
            ? "bg-accent/[0.08] text-accent"
            : "text-dim hover:bg-white/[0.04] hover:text-fg",
          cameraCount === 0 && "cursor-not-allowed opacity-40",
        )}
      >
        <span className="inline-flex w-3 shrink-0 justify-center text-[8px] leading-none" aria-hidden>
          {cameraSelected ? "●" : ""}
        </span>
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.1em]">相机</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
          {cameraCount > 0 ? cameraCount : "—"}
        </span>
      </button>

      {/* 底部提示 */}
      <div className="flex h-6 shrink-0 items-center gap-1 border-t border-line px-2 text-[10px] text-faint">
        <ChevronRight size={10} className="shrink-0" />
        <span className="truncate">
          {hasModel ? (hasClip ? "已加载模型与动作" : "已加载模型，等待导入 VMD") : "尚未加载模型"}
          {!systemAvailable && "（后端未连接）"}
        </span>
      </div>
    </Card>
  );
}
