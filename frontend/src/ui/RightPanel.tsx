/**
 * 右栏：属性 / 相机 / 画面 / 信息 四个 Tab。
 *
 * 「相机」是独立 Tab 而不是属性页里的一段：
 *   相机轨与当前选中的骨骼 / 表情互斥（选中相机时 selection 被清空），
 *   放在同一个滚动面板里会让人以为它们在编辑同一个对象。
 *
 * 「信息」也是独立 Tab：工程 / 内容 / GPU 只读统计，与可编辑的「属性」分离
 * （照 reze-studio 的 properties-inspector 把特性与信息拆开）。
 */

import { useState } from "react";
import { Card } from "./primitives/Card.tsx";
import { Segmented } from "./primitives/Segmented.tsx";
import { PropsTab, type PropsTabProps } from "./right/PropsTab.tsx";
import { InfoTab, type InfoTabProps } from "./right/InfoTab.tsx";
import { CameraSection, type CameraSectionProps } from "./right/CameraSection.tsx";
import { RenderTab } from "./right/RenderTab.tsx";
import type { LiveSettings } from "../engine/render-presets.ts";

type RightTab = "props" | "camera" | "render" | "info";

export interface RightPanelProps extends PropsTabProps {
  onApplyLive: (live: LiveSettings) => void;
  /** 相机页数据与回调（P3） */
  camera: CameraSectionProps;
  /** 是否处于相机编辑态（切过去时自动落到相机 Tab） */
  cameraSelected?: boolean;
  /** 时间轴视图：切换时重挂属性面板，丢弃未落盘的预览草稿 */
  timelineMode: "keys" | "arrange";
  /** 「信息」页数据 */
  info: InfoTabProps;
}

export default function RightPanel({
  onApplyLive,
  camera,
  cameraSelected = false,
  timelineMode,
  info,
  ...propsProps
}: RightPanelProps) {
  const [tab, setTab] = useState<RightTab>("props");

  // 相机被选中时自动切到相机页；取消时回到属性页
  const [lastCameraSelected, setLastCameraSelected] = useState(cameraSelected);
  if (cameraSelected !== lastCameraSelected) {
    setLastCameraSelected(cameraSelected);
    setTab(cameraSelected ? "camera" : "props");
  }

  const tabs = [
    { value: "props" as const, label: "属性" },
    { value: "camera" as const, label: "相机" },
    { value: "render" as const, label: "画面" },
    { value: "info" as const, label: "信息" },
  ];

  return (
    <Card className="w-[340px] shrink-0">
      <div className="shrink-0 border-b border-line px-2 py-1.5">
        <Segmented options={tabs} value={tab} onChange={setTab} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === "props" && <PropsTab key={timelineMode} {...propsProps} />}
        {tab === "camera" && <CameraSection {...camera} />}
        {tab === "render" && <RenderTab onApplyLive={onApplyLive} />}
        {tab === "info" && <InfoTab {...info} />}
      </div>
    </Card>
  );
}
