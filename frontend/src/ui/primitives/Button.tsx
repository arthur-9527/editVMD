/**
 * 按钮。
 *
 * 变体语义：
 *   primary    主操作（导入 / 导出）
 *   secondary  次要操作（默认外观）
 *   ghost      无边框，仅 hover 有底色（工具栏、图标位）
 *   danger     破坏性（清空 / 删除）
 *
 * 一个细节：鼠标点击后主动 blur，避免焦点留在按钮上导致后续
 * Space/Enter 再次触发它（空格要留给播放）。键盘激活（detail === 0）保留焦点。
 */

import type { ButtonHTMLAttributes, MouseEvent } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../cn.ts";

const buttonVariants = cva(
  [
    "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap",
    "rounded-ctl font-medium transition-[background-color,border-color,color,opacity] duration-100",
    "disabled:pointer-events-none disabled:opacity-40",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "border border-accent/70 bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] hover:bg-[#0a7aeb] active:bg-[#0a6fd6]",
        secondary:
          "border border-line-strong bg-raised text-fg hover:bg-[#34343a] active:bg-[#2a2a2f]",
        ghost: "border border-transparent bg-transparent text-dim hover:bg-white/[0.06] hover:text-fg",
        danger:
          "border border-danger/60 bg-danger/12 text-danger hover:bg-danger/20 active:bg-danger/25",
      },
      size: {
        xs: "h-6 px-2 text-[11.5px]",
        sm: "h-7 px-2.5 text-[12px]",
        md: "h-8 px-3 text-[12.5px]",
        icon: "size-7 p-0",
        "icon-sm": "size-6 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "sm" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, onClick, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant, size }), className)}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (e.detail > 0) e.currentTarget.blur();
        onClick?.(e);
      }}
      {...props}
    />
  );
}

export { buttonVariants };
