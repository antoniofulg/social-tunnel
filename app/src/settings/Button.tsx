// Concept A/B control: 28 px (small 24 px), 6 px radius. A disabled button stays focusable
// (`aria-disabled`) and ignores its click.
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  small?: boolean;
  type?: "button" | "submit";
}

export function Button({ children, onClick, disabled = false, small = false, type = "button" }: Props) {
  const size = small ? "h-6 px-[9px] text-xs" : "h-7 px-3 text-[13px]";
  const look = disabled
    ? "cursor-default border-transparent bg-hover text-text-3"
    : "border-btn-border bg-btn text-text shadow-[0_.5px_1.5px_rgba(0,0,0,.12)] hover:bg-btn-hover active:brightness-95";
  return (
    <button
      type={type}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-control border-[.5px] ${size} ${look}`}
    >
      {children}
    </button>
  );
}
