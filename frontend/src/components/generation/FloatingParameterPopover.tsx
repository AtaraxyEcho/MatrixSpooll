import {
  useLayoutEffect,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export type FloatingPopoverPlacement = "auto" | "top";
export type FloatingPopoverAlign = "left" | "right";

interface FloatingParameterPopoverProps {
  id: string;
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  placement?: FloatingPopoverPlacement;
  align?: FloatingPopoverAlign;
  preferredWidth?: number;
  className?: string;
  role: "dialog" | "listbox" | "menu";
  ariaLabel: string;
  children: ReactNode;
}

export function FloatingParameterPopover({
  id,
  open,
  triggerRef,
  panelRef,
  placement = "auto",
  align = "left",
  preferredWidth,
  className = "",
  role,
  ariaLabel,
  children,
}: FloatingParameterPopoverProps) {
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const updatePosition = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const viewportPadding = 12;
      const gap = 8;
      const maximumWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
      const measuredWidth = preferredWidth ?? panelRect.width;
      const width = Math.min(maximumWidth, Math.max(triggerRect.width, measuredWidth));
      const belowSpace = window.innerHeight - triggerRect.bottom - viewportPadding;
      const aboveSpace = triggerRect.top - viewportPadding;
      const openAbove = placement === "top"
        || (placement === "auto" && panelRect.height > belowSpace && aboveSpace > belowSpace);
      const desiredTop = openAbove
        ? triggerRect.top - gap - panelRect.height
        : triggerRect.bottom + gap;
      const desiredLeft = align === "right" ? triggerRect.right - width : triggerRect.left;
      const left = Math.min(
        Math.max(viewportPadding, desiredLeft),
        Math.max(viewportPadding, window.innerWidth - viewportPadding - width),
      );
      const top = Math.min(
        Math.max(viewportPadding, desiredTop),
        Math.max(viewportPadding, window.innerHeight - viewportPadding - panelRect.height),
      );

      Object.assign(panel.style, {
        top: `${top}px`,
        left: `${left}px`,
        width: `${width}px`,
        minWidth: `${Math.min(triggerRect.width, width)}px`,
        visibility: "visible",
      } satisfies Partial<CSSProperties>);
    };

    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [align, open, panelRef, placement, preferredWidth, triggerRef]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      id={id}
      className={`home-param-popover home-param-popover--portal${className ? ` ${className}` : ""}`}
      role={role}
      aria-label={ariaLabel}
      onWheel={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
