/**
 * 下拉菜单。基于 Radix DropdownMenu，只做视觉封装。
 *
 * 设计要点：
 *   - 菜单项 32px 高、12px 字号、右侧可挂快捷键提示；
 *   - 分组标题用 10.5px 大写 + 字距；
 *   - 危险项文字变 danger；
 *   - 弹层用 shadow-float + raised 底，圆角 8px。
 */

import type { ReactNode } from "react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { cn } from "../cn.ts";

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;

export function MenuContent({
  children,
  className,
  align = "end",
  sideOffset = 6,
}: {
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-[188px] rounded-[8px] border border-line-strong bg-raised p-1",
          "shadow-[0_20px_50px_-12px_rgb(0_0_0/0.7),0_8px_16px_-8px_rgb(0_0_0/0.55)]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "duration-100",
          className,
        )}
      >
        {children}
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

export interface MenuItemProps {
  children: ReactNode;
  /** 选择回调（Radix 的 onSelect，键盘与鼠标都会触发） */
  onSelect?: () => void;
  /** 同 onSelect 的别名，写起来更顺手 */
  onClick?: () => void;
  disabled?: boolean;
  /** 右侧快捷键提示，如 "⌘C" */
  shortcut?: string;
  /** 危险操作 */
  danger?: boolean;
  icon?: ReactNode;
  className?: string;
  /**
   * 开关型菜单项的当前状态。
   *
   * ★ 用 `undefined` 区分「不是开关项」与「开关项且关闭」：
   *   关闭时仍占位（透明勾），菜单不会因开关状态变化而左右跳动。
   */
  checked?: boolean;
}

export function MenuItem({
  children,
  onSelect,
  onClick,
  disabled,
  shortcut,
  danger,
  icon,
  className,
  checked,
}: MenuItemProps) {
  const isToggle = checked !== undefined;
  return (
    <MenuPrimitive.Item
      disabled={disabled}
      onSelect={onSelect ?? onClick}
      className={cn(
        "flex h-7 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-[12px] outline-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        danger ? "text-danger data-[highlighted]:bg-danger/12" : "text-fg data-[highlighted]:bg-white/[0.07]",
        className,
      )}
    >
      {isToggle ? (
        <span className={cn("flex size-3.5 shrink-0 items-center justify-center", checked ? "text-accent" : "text-transparent")}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      ) : (
        icon && <span className="flex size-3.5 shrink-0 items-center justify-center text-dim">{icon}</span>
      )}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="font-mono text-[10.5px] text-faint">{shortcut}</span>}
    </MenuPrimitive.Item>
  );
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <MenuPrimitive.Label className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
      {children}
    </MenuPrimitive.Label>
  );
}
