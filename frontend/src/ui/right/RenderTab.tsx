/**
 * 右栏「画面」页：预设 + 实时调参。
 *
 * 两类控件
 * --------
 *   - 预设：写 localStorage，提示「刷新后生效」（bootstrap 参数只能在构造 Engine 时传）；
 *   - 滑块 / 开关 / 颜色：实时调用 onApplyLive，同时写 localStorage。
 *
 * 滑块用 rAF 节流：拖动时每帧最多推一次引擎 + 写一次存储，避免高频 setState。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, FileJson } from "lucide-react";
import {
  PRESETS,
  getPreset,
  type LiveSettings,
  type Vec3Tuple,
} from "../../engine/render-presets.ts";
import { loadSettings, saveSettings } from "../../engine/render-settings.ts";
import { Button } from "../primitives/Button.tsx";
import { ColorField } from "../primitives/ColorField.tsx";
import { Segmented } from "../primitives/Segmented.tsx";
import { Slider } from "../primitives/Slider.tsx";
import { Switch } from "../primitives/Switch.tsx";

interface Props {
  /** 引擎就绪后把实时设置推给它 */
  onApplyLive: (live: LiveSettings) => void;
}

const PRESET_OPTIONS = PRESETS.map((p) => ({ value: p.id, label: p.label }));

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-3 pt-3 pb-1">
      <h3 className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-faint">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export function RenderTab({ onApplyLive }: Props) {
  const [settings, setSettings] = useState(() => loadSettings());
  const pendingRef = useRef<number | null>(null);
  const latestRef = useRef<LiveSettings>(settings.live);

  useEffect(() => {
    return () => {
      if (pendingRef.current !== null) cancelAnimationFrame(pendingRef.current);
    };
  }, []);

  /** 更新一项：立即改 UI 状态 → rAF 合并推送引擎与存储 */
  const patch = useCallback(
    <K extends keyof LiveSettings>(key: K, value: LiveSettings[K]) => {
      const nextLive = { ...latestRef.current, [key]: value };
      latestRef.current = nextLive;
      setSettings((s) => ({ ...s, live: nextLive }));

      if (pendingRef.current !== null) cancelAnimationFrame(pendingRef.current);
      pendingRef.current = requestAnimationFrame(() => {
        pendingRef.current = null;
        onApplyLive(latestRef.current);
        saveSettings({ presetId: getPreset(settings.presetId).id, live: latestRef.current });
      });
    },
    [onApplyLive, settings.presetId],
  );

  const choosePreset = useCallback((id: string) => {
    const preset = getPreset(id);
    latestRef.current = preset.live;
    setSettings({ presetId: preset.id, live: preset.live });
    saveSettings({ presetId: preset.id, live: preset.live });
  }, []);

  const resetAll = useCallback(() => {
    const preset = getPreset(settings.presetId);
    latestRef.current = preset.live;
    setSettings({ presetId: preset.id, live: preset.live });
    saveSettings({ presetId: preset.id, live: preset.live });
    onApplyLive(preset.live);
  }, [onApplyLive, settings.presetId]);

  const exportJson = useCallback(() => {
    const data = JSON.stringify({ presetId: settings.presetId, live: latestRef.current }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `editvmd-render-${settings.presetId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [settings.presetId]);

  const live = settings.live;
  const currentPreset = getPreset(settings.presetId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <Group title="预设">
          <Segmented options={PRESET_OPTIONS} value={settings.presetId} onChange={choosePreset} />
          <p className="text-[10.5px] leading-[1.5] text-faint">{currentPreset.hint}</p>
          <p className="text-[10px] leading-[1.5] text-faint/80">
            预设含构造期参数（背景色 / 色调映射 / 泛光开关），切换后需<b className="text-dim">刷新页面</b>才生效。
          </p>
        </Group>

        <div className="mx-3 h-px bg-line" />

        <Group title="光照">
          <Slider
            label="环境光"
            value={live.worldStrength}
            min={0}
            max={3}
            step={0.05}
            digits={2}
            onChange={(v) => patch("worldStrength", v)}
          />
          <Slider
            label="主光"
            value={live.sunStrength}
            min={0}
            max={3}
            step={0.05}
            digits={2}
            onChange={(v) => patch("sunStrength", v)}
          />
          <Slider
            label="阴影浓度"
            value={live.sunShadow}
            min={0}
            max={1}
            step={0.05}
            digits={2}
            onChange={(v) => patch("sunShadow", v)}
          />
          <ColorField label="环境光颜色" value={live.worldColor} onChange={(v) => patch("worldColor", v)} />
          <ColorField label="主光颜色" value={live.sunColor} onChange={(v) => patch("sunColor", v)} />
        </Group>

        <div className="mx-3 h-px bg-line" />

        <Group title="泛光">
          <Slider
            label="强度"
            value={live.bloomIntensity}
            min={0}
            max={2}
            step={0.05}
            digits={2}
            onChange={(v) => patch("bloomIntensity", v)}
          />
          <Slider
            label="阈值"
            value={live.bloomThreshold}
            min={0}
            max={1}
            step={0.01}
            digits={2}
            onChange={(v) => patch("bloomThreshold", v)}
          />
        </Group>

        <div className="mx-3 h-px bg-line" />

        <Group title="描边">
          <Switch
            label="启用 MMD 描边"
            checked={live.outlineEnabled}
            onCheckedChange={(v) => patch("outlineEnabled", v)}
          />
          <Slider
            label="宽度"
            value={live.outlineWidth}
            min={0.1}
            max={3}
            step={0.05}
            digits={2}
            disabled={!live.outlineEnabled}
            onChange={(v) => patch("outlineWidth", v)}
          />
          <ColorField
            label="描边颜色"
            value={live.outlineColor}
            disabled={!live.outlineEnabled}
            onChange={(v) => patch("outlineColor", v)}
          />
        </Group>

        <div className="mx-3 h-px bg-line" />

        <Group title="调色">
          <Slider
            label="饱和度"
            value={live.gradeSaturation}
            min={0}
            max={2}
            step={0.02}
            digits={2}
            onChange={(v) => patch("gradeSaturation", v)}
          />
          <Slider
            label="对比度"
            value={live.gradeContrast}
            min={0.5}
            max={1.6}
            step={0.01}
            digits={2}
            onChange={(v) => patch("gradeContrast", v)}
          />
          <ColorField label="阴影" value={live.gradeShadows} onChange={(v) => patch("gradeShadows", v)} />
          <ColorField label="中间调" value={live.gradeMidtones} onChange={(v) => patch("gradeMidtones", v)} />
          <ColorField label="高光" value={live.gradeHighlights} onChange={(v) => patch("gradeHighlights", v)} />
        </Group>

        <div className="mx-3 h-px bg-line" />

        <Group title="场景">
          <Switch label="显示地面" checked={live.groundVisible} onCheckedChange={(v) => patch("groundVisible", v)} />
          {/* 网格是地面着色器自带的一层（引擎没有独立 GridHelper）：
              间距 / 不透明度改了需要重建地面，见 render-settings.ts */}
          <Switch
            label="显示网格"
            checked={live.groundGrid}
            disabled={!live.groundVisible}
            onCheckedChange={(v) => patch("groundGrid", v)}
          />
          <Slider
            label="网格间距"
            value={live.gridSpacing}
            min={1}
            max={12}
            step={0.2}
            digits={1}
            disabled={!live.groundVisible || !live.groundGrid}
            onChange={(v) => patch("gridSpacing", v)}
          />
          <Slider
            label="网格不透明度"
            value={live.gridOpacity}
            min={0}
            max={1}
            step={0.02}
            digits={2}
            disabled={!live.groundVisible || !live.groundGrid}
            onChange={(v) => patch("gridOpacity", v)}
          />
          <Switch
            label="地面镜面反射"
            checked={live.groundMirror}
            disabled={!live.groundVisible}
            onCheckedChange={(v) => patch("groundMirror", v)}
          />
          <Switch label="开启雾" checked={live.fogEnabled} onCheckedChange={(v) => patch("fogEnabled", v)} />
          <Slider
            label="雾浓度"
            value={live.fogAmount}
            min={0}
            max={1}
            step={0.02}
            digits={2}
            disabled={!live.fogEnabled}
            onChange={(v) => patch("fogAmount", v)}
          />
        </Group>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-2">
        <Button variant="secondary" size="sm" onClick={resetAll} className="flex-1">
          <RotateCcw size={12} />
          重置
        </Button>
        <Button variant="ghost" size="sm" onClick={exportJson} className="flex-1">
          <FileJson size={12} />
          导出 JSON
        </Button>
      </div>
    </div>
  );
}

export type { Vec3Tuple };
