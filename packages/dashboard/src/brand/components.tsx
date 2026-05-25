/* ─────────────────────────────────────────────────────────────
   Vonzio · brand/components.tsx
   React primitives for the Sodium design system.
   Depends on tokens.css + primitives.css.
   ───────────────────────────────────────────────────────────── */
import {
  Fragment,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SVGProps,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";

/* ─── tiny SVG icons ─── */
type IconProps = SVGProps<SVGSVGElement>;
export const Icon = {
  check: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" {...p}>
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevron: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" width="14" height="14" {...p}>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  search: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" {...p}>
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  x: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" width="14" height="14" {...p}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  alert: (p: IconProps) => (
    <svg viewBox="0 0 18 18" fill="none" {...p}>
      <path d="M9 2v8M9 14v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  info: (p: IconProps) => (
    <svg viewBox="0 0 18 18" fill="none" {...p}>
      <circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 8v4M9 5.5v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  arrow: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" width="14" height="14" {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/* ─── Brand mark / wordmark / lockup ─── */
type MarkVariant = "default" | "inverse" | "mono-light" | "mono-dark";
export function Mark({ size = 28, variant = "default" }: { size?: number; variant?: MarkVariant }) {
  const palettes: Record<MarkVariant, { bg: string; fg: string }> = {
    "default": { bg: "#0E1116", fg: "#FF5722" },
    "inverse": { bg: "#FF5722", fg: "#0E1116" },
    "mono-light": { bg: "#0E1116", fg: "#FAFAF7" },
    "mono-dark": { bg: "#FAFAF7", fg: "#0E1116" },
  };
  const { bg, fg } = palettes[variant];
  return (
    <svg className="vz-mark" width={size} height={size} viewBox="0 0 64 64" aria-label="vonzio" role="img">
      <rect width="64" height="64" rx="14" fill={bg} />
      <path d="M18 22 L32 44 L46 22" fill="none" stroke={fg} strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="22" y="49" width="20" height="3.5" rx="1.75" fill={fg} />
    </svg>
  );
}

export function Wordmark({ size = 28, color }: { size?: number; color?: string }) {
  const ink = color || "currentColor";
  return (
    <svg height={size} viewBox="0 0 240 64" aria-label="vonzio" role="img">
      <text x="0" y="48" fontFamily="'DM Sans', system-ui, sans-serif" fontSize="56" fontWeight="700" letterSpacing="-1.5">
        <tspan fill="#FF5722">v</tspan>
        <tspan fill={ink}>onzio</tspan>
      </text>
    </svg>
  );
}

export function Lockup({ size = 28, variant = "default" }: { size?: number; variant?: "default" | "light" }) {
  const ink = variant === "light" ? "#FAFAF7" : "#0E1116";
  return (
    <span className="vz-lockup" style={{ height: size }}>
      <Mark size={size} variant="default" />
      <Wordmark size={size * 0.78} color={ink} />
    </span>
  );
}

/* ─── Button ─── */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "danger-ghost";
  size?: "sm";
  mono?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
};
export function Button({ variant = "primary", size, mono, icon, iconRight, children, className = "", ...rest }: ButtonProps) {
  const cls = [
    "vz-btn",
    variant === "primary" && "vz-btn--primary",
    variant === "ghost" && "vz-btn--ghost",
    variant === "danger" && "vz-btn--danger",
    variant === "danger-ghost" && "vz-btn--danger-ghost",
    size === "sm" && "vz-btn--sm",
    mono && "vz-btn--mono",
    className,
  ].filter(Boolean).join(" ");
  return (
    <button className={cls} {...rest}>
      {icon}
      {children}
      {iconRight}
    </button>
  );
}

/* ─── Field shell + Input + Textarea + Search ─── */
export function Field({ label, hint, error, children, className = "" }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`vz-field ${className}`}>
      {label && <span className="vz-field__label">{label}</span>}
      {children}
      {error ? <span className="vz-field__error">{error}</span> : hint ? <span className="vz-field__hint">{hint}</span> : null}
    </label>
  );
}
export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`vz-input ${className}`} {...rest} />;
}
export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`vz-textarea ${className}`} {...rest} />;
}
export function Search({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`vz-search ${className}`}>
      <Icon.search className="vz-search__icon" width="16" height="16" />
      <input className="vz-input" {...rest} />
    </div>
  );
}

/* ─── Select / Dropdown ─── */
export type SelectOption = { value: string; label: ReactNode };
export function Select({ value, onChange, options, placeholder = "Select…", disabled }: { value?: string; onChange?: (v: string) => void; options: SelectOption[]; placeholder?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (
    <div className="vz-select" ref={ref} data-disabled={disabled ? "true" : undefined}>
      <button
        type="button"
        className="vz-select__trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
      >
        <span style={{ color: current ? "var(--vz-ink)" : "var(--vz-muted-2)" }}>
          {current ? current.label : placeholder}
        </span>
        <Icon.chevron />
      </button>
      {open && (
        <div
          className="vz-menu"
          style={{ top: "calc(100% + 4px)", left: 0, right: 0 }}
          // Belt-and-suspenders: stop mousedown bubbling to the document
          // listener so the close-on-outside-click can't race the item click.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`vz-menu__item ${o.value === value ? "vz-menu__item--active" : ""}`}
              // Pick on mousedown so selection commits before any blur/click
              // race; close synchronously inside the same event.
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onChange?.(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type MenuItem =
  | { type: "sep" }
  | { type: "label"; label: ReactNode }
  | { type?: never; label: ReactNode; onClick?: () => void; danger?: boolean; icon?: ReactNode; kbd?: ReactNode };
export function DropdownMenu({ trigger, items, align = "left" }: { trigger: ReactNode; items: MenuItem[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
      {open && (
        <div className="vz-menu" style={{ top: "calc(100% + 6px)", [align]: 0 } as CSSProperties}>
          {items.map((it, i) => {
            if (it.type === "sep") return <div key={i} className="vz-menu__sep" />;
            if (it.type === "label") return <div key={i} className="vz-menu__label">{it.label}</div>;
            return (
              <div
                key={i}
                className={`vz-menu__item ${it.danger ? "vz-menu__item--danger" : ""}`}
                onClick={() => {
                  it.onClick?.();
                  setOpen(false);
                }}
              >
                {it.icon}
                {it.label}
                {it.kbd && <Kbd style={{ marginLeft: "auto" }}>{it.kbd}</Kbd>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Checkbox / Radio / Toggle ─── */
type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "checked"> & {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  children?: ReactNode;
};
export function Checkbox({ checked, onChange, children, ...rest }: CheckProps) {
  return (
    <label className="vz-check">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} {...rest} />
      <span className="vz-check__box"><Icon.check /></span>
      {children && <span>{children}</span>}
    </label>
  );
}
export function Radio({ checked, onChange, name, value, children, ...rest }: CheckProps & { name?: string; value?: string }) {
  return (
    <label className="vz-radio">
      <input type="radio" name={name} value={value} checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} {...rest} />
      <span className="vz-radio__box"><span className="vz-radio__dot" /></span>
      {children && <span>{children}</span>}
    </label>
  );
}
export function Toggle({ checked, onChange, children, ...rest }: CheckProps) {
  return (
    <label className="vz-toggle">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} {...rest} />
      <span className="vz-toggle__track"><span className="vz-toggle__thumb" /></span>
      {children && <span>{children}</span>}
    </label>
  );
}

/* ─── Pill / Badge / Dot ─── */
type Tone = "default" | "ok" | "warn" | "fail" | "info" | "accent";
export function Pill({ tone = "default", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  const cls = `vz-pill ${tone !== "default" ? `vz-pill--${tone}` : ""}`;
  return (
    <span className={cls}>
      {dot && <Dot tone={tone === "default" ? undefined : (tone as DotTone)} />}
      {children}
    </span>
  );
}
export function Badge({ tone = "default", children }: { tone?: "default" | "accent" | "outline"; children: ReactNode }) {
  const cls = `vz-badge ${tone !== "default" ? `vz-badge--${tone}` : ""}`;
  return <span className={cls}>{children}</span>;
}
type DotTone = "ok" | "warn" | "fail" | "accent";
export function Dot({ tone, pulse }: { tone?: DotTone; pulse?: boolean }) {
  const map: Record<DotTone, string> = {
    ok: "vz-dot--ok",
    warn: "vz-dot--warn",
    fail: "vz-dot--fail",
    accent: "vz-dot--accent",
  };
  return <span className={`vz-dot ${tone ? map[tone] : ""} ${pulse ? "vz-dot--pulse" : ""}`} />;
}

/* ─── Kbd ─── */
export function Kbd({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <kbd className="vz-kbd" style={style}>{children}</kbd>;
}

/* ─── Card / Panel ─── */
export function Card({ children, mute, flush, className = "", style, onClick }: { children: ReactNode; mute?: boolean; flush?: boolean; className?: string; style?: CSSProperties; onClick?: () => void }) {
  const cls = ["vz-card", mute && "vz-card--mute", flush && "vz-card--flush", className].filter(Boolean).join(" ");
  return <div className={cls} style={style} onClick={onClick}>{children}</div>;
}
export function Panel({ title, action, children }: { title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="vz-panel">
      {(title || action) && (
        <div className="vz-panel__header">
          <span className="vz-panel__title">{title}</span>
          <span style={{ marginLeft: "auto" }}>{action}</span>
        </div>
      )}
      <div className="vz-panel__body">{children}</div>
    </div>
  );
}

/* ─── Avatar ─── */
export function Avatar({ name = "", src, size, style }: { name?: string; src?: string; size?: "sm" | "lg"; style?: CSSProperties }) {
  const cls = `vz-avatar ${size === "sm" ? "vz-avatar--sm" : size === "lg" ? "vz-avatar--lg" : ""}`;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
  return <span className={cls} style={style}>{src ? <img src={src} alt={name} /> : initials}</span>;
}
export function AvatarStack({ children }: { children: ReactNode }) {
  return <span className="vz-avatar-stack">{children}</span>;
}

/* ─── Tabs ─── */
export type TabDef = { value: string; label: ReactNode };
export function Tabs({ tabs, value, onChange, children }: { tabs: TabDef[]; value?: string; onChange?: (v: string) => void; children?: ReactNode | ((active: string | undefined) => ReactNode) }) {
  const [internal, setInternal] = useState<string | undefined>(tabs?.[0]?.value);
  const active = value ?? internal;
  const set = onChange ?? setInternal;
  return (
    <div className="vz-tabs">
      <div className="vz-tabs__list" role="tablist">
        {tabs.map((t) => (
          <button key={t.value} role="tab" className="vz-tabs__trigger" data-active={active === t.value} onClick={() => set(t.value)}>
            {t.label}
          </button>
        ))}
      </div>
      {typeof children === "function" ? children(active) : children}
    </div>
  );
}

/* ─── Tooltip ─── */
export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <span className="vz-tip">
      {children}
      <span className="vz-tip__bubble">{label}</span>
    </span>
  );
}

/* ─── Toast / Banner ─── */
type ToastTone = "ok" | "warn" | "fail" | "info";
export function Toast({ tone = "info", title, children, onClose }: { tone?: ToastTone; title?: ReactNode; children?: ReactNode; onClose?: () => void }) {
  const tip: Record<ToastTone, ReactNode> = {
    ok: <Icon.check style={{ color: "var(--vz-ok)" }} />,
    warn: <Icon.alert style={{ color: "var(--vz-warn)" }} />,
    fail: <Icon.alert style={{ color: "var(--vz-fail)" }} />,
    info: <Icon.info style={{ color: "var(--vz-info)" }} />,
  };
  return (
    <div className={`vz-toast vz-toast--${tone}`}>
      <span className="vz-toast__icon">{tip[tone]}</span>
      <div className="vz-toast__body">
        {title && <div className="vz-toast__title">{title}</div>}
        {children && <div className="vz-toast__desc">{children}</div>}
      </div>
      {onClose && (
        <button className="vz-banner__close" onClick={onClose}>
          <Icon.x />
        </button>
      )}
    </div>
  );
}
export function Banner({ children, onClose, icon }: { children: ReactNode; onClose?: () => void; icon?: ReactNode }) {
  return (
    <div className="vz-banner">
      {icon ?? <Icon.info width="16" height="16" style={{ color: "var(--vz-sodium)" }} />}
      <span>{children}</span>
      {onClose && (
        <button className="vz-banner__close" onClick={onClose}>
          <Icon.x />
        </button>
      )}
    </div>
  );
}

/* ─── Modal ─── */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = "md",
  dismissable = true,
  children,
}: {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg" | "xl";
  /**
   * When `false`, scrim-click and Escape are ignored. A close X is
   * rendered in the header so users still have an explicit way out.
   * Use `false` for any modal that holds unsaved form state.
   * Defaults to `true` (back-compat with confirm-dialog usage).
   */
  dismissable?: boolean;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissable]);
  if (!open) return null;
  const sizeClass = size === "lg" ? "vz-modal--lg" : size === "xl" ? "vz-modal--xl" : "";
  const showHeader = title || description || (!dismissable && onClose);
  return (
    <div
      className="vz-modal__scrim"
      onClick={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className={`vz-modal ${sizeClass}`.trim()} role="dialog" aria-modal="true">
        {showHeader && (
          <div className="vz-modal__header">
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && <h3 className="vz-modal__title">{title}</h3>}
              {description && <p className="vz-modal__desc">{description}</p>}
            </div>
            {!dismissable && onClose && (
              <button
                type="button"
                className="vz-modal__close"
                onClick={onClose}
                aria-label="Close"
              >
                <Icon.x />
              </button>
            )}
          </div>
        )}
        <div className="vz-modal__body">{children}</div>
        {footer && <div className="vz-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}

/* ─── App Shell primitives — Rail / TopBar / StatusBar / PageHeader ─── */

type RailState = "collapsed" | "expanded" | "mobile-open";

export function AppShell({
  rail,
  topbar,
  statusbar,
  railState = "collapsed",
  onBackdropClick,
  children,
}: {
  rail: ReactNode;
  topbar: ReactNode;
  statusbar?: ReactNode;
  railState?: RailState;
  /** Called when the mobile rail backdrop is tapped (close the overlay). */
  onBackdropClick?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="vz-app" data-rail={railState}>
      <aside className="vz-app__rail">{rail}</aside>
      <header className="vz-app__topbar">{topbar}</header>
      <main className="vz-app__main">{children}</main>
      {statusbar && <footer className="vz-app__statusbar">{statusbar}</footer>}
      <div
        className="vz-app__backdrop"
        onClick={onBackdropClick}
        aria-hidden={railState !== "mobile-open"}
      />
    </div>
  );
}

export function Rail({ children }: { children: ReactNode }) {
  return <nav className="vz-rail">{children}</nav>;
}
export function RailBrand({ children }: { children: ReactNode }) {
  return (
    <a href="/" className="vz-rail__brand" aria-label="vonzio">
      {/* Inline SVG so the tile + V can pick up CSS-driven colors that
          flip with [data-surface]: sodium tile + white V on Paper,
          graphite tile + sodium V on Carbon. */}
      <svg
        viewBox="0 0 64 64"
        width={28}
        height={28}
        className="vz-rail__brand-mark"
        aria-hidden="true"
      >
        <rect width="64" height="64" rx="14" fill="var(--vz-brand-tile)" />
        <path
          d="M18 22 L32 44 L46 22"
          fill="none"
          stroke="var(--vz-brand-on-tile)"
          strokeWidth="6.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="22" y="49" width="20" height="3.5" rx="1.75" fill="var(--vz-brand-on-tile)" />
      </svg>
      <span className="vz-rail__brand-text">{children}</span>
    </a>
  );
}
export function RailGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="vz-rail__group">
      {label && <div className="vz-rail__label">{label}</div>}
      {children}
    </div>
  );
}
export function RailItem({
  icon,
  active,
  onClick,
  href,
  children,
}: {
  icon: ReactNode;
  active?: boolean;
  onClick?: () => void;
  href?: string;
  children: ReactNode;
}) {
  const props = {
    className: "vz-rail__item",
    "data-active": active ? "true" : undefined,
    onClick,
  } as const;
  const content = (
    <>
      <span className="vz-rail__icon" aria-hidden="true">{icon}</span>
      <span className="vz-rail__text">{children}</span>
    </>
  );
  return href ? (
    <a href={href} {...props}>{content}</a>
  ) : (
    <button type="button" {...props}>{content}</button>
  );
}
export function RailSpacer() {
  return <div className="vz-rail__spacer" />;
}
export function RailPin({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="vz-rail__pin" onClick={onToggle} aria-label={pinned ? "Collapse rail" : "Expand rail"}>
      <span className="vz-rail__icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          {pinned ? (
            <path d="M10 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      </span>
      <span className="vz-rail__text">{pinned ? "collapse" : "expand"}</span>
    </button>
  );
}

export type Crumb = { label: ReactNode; href?: string };
export function TopBar({
  crumbs,
  onCmdK,
  cmdKHint = "⌘K",
  actions,
}: {
  crumbs: Crumb[];
  onCmdK?: () => void;
  cmdKHint?: string;
  actions?: ReactNode;
}) {
  return (
    <>
      <nav className="vz-topbar__crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {c.href && !isLast ? <a href={c.href}>{c.label}</a> : <span className={isLast ? "vz-topbar__crumb-current" : undefined}>{c.label}</span>}
              {!isLast && <span className="vz-topbar__crumb-sep" aria-hidden="true">/</span>}
            </span>
          );
        })}
      </nav>
      {onCmdK && (
        <button type="button" className="vz-topbar__cmdk" onClick={onCmdK}>
          <Icon.search width="14" height="14" />
          <span className="vz-topbar__cmdk-text">Search or jump to…</span>
          <span className="vz-topbar__cmdk-hint">{cmdKHint}</span>
        </button>
      )}
      {actions && <div className="vz-topbar__actions">{actions}</div>}
    </>
  );
}

export type StatusChip = { label: ReactNode; tone?: "ok" | "warn" | "fail" | "info" | "muted" };
export function StatusBar({ chips, meta }: { chips: StatusChip[]; meta?: ReactNode }) {
  return (
    <>
      {chips.map((c, i) => (
        <Fragment key={i}>
          <span className="vz-statusbar__chip">
            {c.tone && c.tone !== "muted" && <Dot tone={c.tone === "info" ? "accent" : (c.tone as DotTone)} />}
            {c.label}
          </span>
          {i < chips.length - 1 && <span className="vz-statusbar__chip-sep" aria-hidden="true">·</span>}
        </Fragment>
      ))}
      <span className="vz-statusbar__spacer" />
      {meta && <span className="vz-statusbar__meta">{meta}</span>}
    </>
  );
}

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="vz-page-header">
      <div className="vz-page-header__main">
        {eyebrow && <span className="vz-eyebrow vz-page-header__eyebrow">{eyebrow}</span>}
        <h1 className="vz-page-header__title">{title}</h1>
        {lede && <p className="vz-page-header__lede">{lede}</p>}
      </div>
      {actions && <div className="vz-page-header__actions">{actions}</div>}
    </header>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="vz-page-body">{children}</div>;
}

/* ─── Data table ─── */

export type DataColumn<T> = {
  /** Stable identifier; used as React key and as the sort field. */
  key: string;
  /** Header label. */
  label: ReactNode;
  /** Cell renderer; defaults to (row as any)[key]. */
  render?: (row: T, index: number) => ReactNode;
  /** When true, header click toggles sort direction on this column. */
  sortable?: boolean;
  /** Override CSS width (e.g. "120px", "30%"). */
  width?: string;
  align?: "left" | "right" | "center";
  /** Mark numeric for monospace alignment. */
  numeric?: boolean;
};

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir } | null;

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  sort,
  onSortChange,
  emptyState,
  loading,
  /* Optional pagination — when both onPageChange and total are set. */
  page,
  pageSize,
  total,
  onPageChange,
  /* Optional title block above the table. */
  title,
  count,
  actions,
}: {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  emptyState?: ReactNode;
  loading?: boolean;
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  title?: ReactNode;
  count?: number;
  actions?: ReactNode;
}) {
  const cycleSort = (key: string) => {
    if (!onSortChange) return;
    if (!sort || sort.key !== key) onSortChange({ key, dir: "asc" });
    else if (sort.dir === "asc") onSortChange({ key, dir: "desc" });
    else onSortChange(null);
  };

  const hasPagination =
    typeof page === "number" && typeof pageSize === "number" && typeof total === "number" && !!onPageChange;
  const lastPage = hasPagination ? Math.max(0, Math.ceil(total / pageSize) - 1) : 0;
  const fromIdx = hasPagination ? page * pageSize + 1 : 0;
  const toIdx = hasPagination ? Math.min(total, (page + 1) * pageSize) : 0;

  const getCell = (row: T, col: DataColumn<T>, index: number): ReactNode => {
    if (col.render) return col.render(row, index);
    return (row as Record<string, unknown>)[col.key] as ReactNode;
  };

  return (
    <div className="vz-table-wrap">
      {(title || actions) && (
        <div className="vz-table-wrap__header">
          {title && (
            <div className="vz-table-wrap__title">
              <span>{title}</span>
              {typeof count === "number" && <span className="vz-table-wrap__title-count">{count}</span>}
            </div>
          )}
          {actions && <div className="vz-table-wrap__actions">{actions}</div>}
        </div>
      )}
      <div className="vz-table__scroll">
        <table className="vz-table">
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    data-sortable={c.sortable ? "true" : undefined}
                    data-sort-active={active ? "true" : undefined}
                    data-align={c.align}
                    style={c.width ? { width: c.width } : undefined}
                    onClick={c.sortable ? () => cycleSort(c.key) : undefined}
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {c.label}
                    {c.sortable && (
                      <span className="vz-table__sort-icon" aria-hidden="true">
                        {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: "center", padding: "32px 0", color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)", fontSize: 12 }}>
                  loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{ padding: 0 }}>
                  {emptyState ?? (
                    <div style={{ textAlign: "center", padding: "32px 0", color: "var(--vz-muted)", fontSize: 13 }}>
                      No rows.
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={rowKey(row)}
                  data-clickable={onRowClick ? "true" : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c) => {
                    const labelText = typeof c.label === "string" ? c.label : c.key;
                    return (
                      <td
                        key={c.key}
                        data-label={labelText}
                        data-align={c.align}
                        data-numeric={c.numeric ? "true" : undefined}
                      >
                        {getCell(row, c, index)}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {hasPagination && total > pageSize && (
        <div className="vz-table__pagination">
          <span>
            {fromIdx}–{toIdx} of {total}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => onPageChange(Math.max(0, page - 1))}
              disabled={page === 0}
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => onPageChange(Math.min(lastPage, page + 1))}
              disabled={page >= lastPage}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Stat card ─── */
export function StatCard({
  label,
  value,
  icon,
  hint,
  mono,
}: {
  label: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  /** Use DM Mono for the value (good for ratios like '3 / 12'). */
  mono?: boolean;
}) {
  return (
    <div className="vz-stat">
      <div className="vz-stat__head">
        <span className="vz-stat__label">{label}</span>
        {icon && <span className="vz-stat__icon" aria-hidden="true">{icon}</span>}
      </div>
      <div className={`vz-stat__value ${mono ? "vz-stat__value-mono" : ""}`.trim()}>{value}</div>
      {hint && <div className="vz-stat__hint">{hint}</div>}
    </div>
  );
}

/* ─── Filter chips (in-page local nav) ─── */
export type ChipDef = { value: string; label: ReactNode; count?: number };
export function ChipRow({
  chips,
  value,
  onChange,
}: {
  chips: ChipDef[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="vz-chip-row">
      {chips.map((c) => (
        <button
          key={c.value}
          type="button"
          className="vz-chip"
          data-active={value === c.value ? "true" : undefined}
          onClick={() => onChange(c.value)}
        >
          <span>{c.label}</span>
          {typeof c.count === "number" && <span className="vz-chip__count">{c.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="vz-empty">
      {icon && <div className="vz-empty__icon" aria-hidden="true">{icon}</div>}
      <h3 className="vz-empty__title">{title}</h3>
      {description && <p className="vz-empty__desc">{description}</p>}
      {action && <div className="vz-empty__action">{action}</div>}
    </div>
  );
}

/* ─── Code ─── */
export function Code({ children }: { children: ReactNode }) {
  return <code className="vz-code-inline">{children}</code>;
}
export function CodeBlock({ name = "shell", children }: { name?: string; children: ReactNode }) {
  return (
    <div className="vz-code-block">
      <div className="vz-code-block__bar">
        <span className="vz-code-block__tl"><span /><span /><span /></span>
        <span className="vz-code-block__name">{name}</span>
      </div>
      <pre className="vz-code-block__body" style={{ margin: 0 }}>{children}</pre>
    </div>
  );
}
