import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import "./ui.css";

/** 统一页面标题、用途说明与主要操作，避免重复的介绍区域。 */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {children}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

type MoreAction = {
  label: string;
  accessibleLabel?: string;
  icon: ReactNode;
  danger?: boolean;
  onSelect: () => void;
};

/** 用可键盘访问的展开区收纳低频操作；关闭或执行后把焦点交还触发按钮。 */
export function MoreActions({
  label,
  disabled = false,
  actions,
}: {
  label: string;
  disabled?: boolean;
  actions: MoreAction[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open || disabled) return;
    /** 外部点击仅关闭操作区，保持被点击目标的正常焦点行为。 */
    function dismissOutside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    /** 兼容 WebKit 点击后焦点留在页面的情况，关闭菜单并恢复触发器焦点。 */
    function dismissWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, [open, disabled]);

  return (
    <div
      className="more-actions"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-button more-actions-trigger"
        aria-label={label}
        title="更多操作"
        aria-expanded={open && !disabled}
        aria-controls={panelId}
        disabled={disabled}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen((current) => !current);
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && !disabled && (
        <div
          className="more-actions-panel"
          id={panelId}
          role="group"
          aria-label={label}
        >
          {actions.map((action) => (
            <button
              type="button"
              key={action.label}
              className={action.danger ? "more-action danger" : "more-action"}
              aria-label={action.accessibleLabel}
              onClick={() => {
                trigger.current?.focus();
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
