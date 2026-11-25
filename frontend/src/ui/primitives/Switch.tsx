/**
 * macOS 开关 —— 替代原生 checkbox。
 *
 * 用 Radix Switch 拿无障碍行为（role=switch、空格/回车），
 * 视觉自己画：轨道 32×18，滑块 14 圆，选中时轨道变 accent。
 */

import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "../cn.ts";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  id?: string;
}

export function Switch({ checked, onCheckedChange, disabled, label, className, id }: SwitchProps) {
  return (
    <label
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 text-[11.5px] text-dim",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className={cn(
          "relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full",
          "border transition-colors duration-150 outline-none",
          "focus-visible:ring-2 focus-visible:ring-accent/60",
          checked ? "border-accent/70 bg-accent" : "border-line-strong bg-[#3a3a40]",
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            "block size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.45)]",
            "transition-transform duration-150",
            checked ? "translate-x-[15px]" : "translate-x-[2px]",
          )}
        />
      </SwitchPrimitive.Root>
      {label && <span>{label}</span>}
    </label>
  );
}
