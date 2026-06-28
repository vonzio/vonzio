import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronsUp, ChevronsDown, ChevronUp, ChevronDown, List, X } from "lucide-react";

export interface NavTurn {
  id: string;
  label: string;
}

/**
 * Floating thread navigator for long conversations. Jumps between the user's
 * questions (turn anchors `#vz-turn-<id>` rendered by MessageList) so you don't
 * have to scroll past long agent outputs:
 *   ⤒ top · ↑ previous question · ↓ next question · ⤓ bottom
 * Plus a "questions" outline popover to jump directly to any turn.
 * Only renders when the thread is long enough to be worth navigating.
 */
export function ThreadNavigator({
  scrollRef,
  turns,
  onScrollToBottom,
}: {
  scrollRef: React.RefObject<HTMLElement | null>;
  turns: NavTurn[];
  onScrollToBottom: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const rafRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Latest turns read inside the scroll handler without re-subscribing the
  // listener — `turns` gets a fresh array identity on every streaming token.
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  // Close the outline popover on an outside click or Escape.
  useEffect(() => {
    if (!outlineOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOutlineOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOutlineOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [outlineOpen]);

  const anchorFor = useCallback(
    (id: string): HTMLElement | null =>
      scrollRef.current?.querySelector(`#vz-turn-${CSS.escape(id)}`) ?? null,
    [scrollRef],
  );

  // Active turn = the last question whose anchor has scrolled to/above the
  // viewport top — i.e. the turn whose response you're currently reading.
  const recompute = useCallback(() => {
    const c = scrollRef.current;
    if (!c) return;
    setScrollable(c.scrollHeight - c.clientHeight > 240);
    const ts = turnsRef.current;
    const top = c.getBoundingClientRect().top;
    let active = 0;
    for (let i = 0; i < ts.length; i++) {
      const el = anchorFor(ts[i].id);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= top + 16) active = i;
      else break;
    }
    setActiveIndex(active);
  }, [scrollRef, anchorFor]);

  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        recompute();
      });
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    // Recompute when the thread grows (streaming) or the viewport resizes, so
    // the navigator appears/updates without needing a manual scroll.
    const ro = new ResizeObserver(onScroll);
    ro.observe(c);
    if (c.firstElementChild) ro.observe(c.firstElementChild);
    recompute();
    return () => {
      c.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [scrollRef, recompute]);

  // Refresh active/visibility when the set of turns changes (new message).
  useEffect(() => { recompute(); }, [turns, recompute]);

  const scrollToTurn = useCallback(
    (idx: number) => {
      const t = turns[idx];
      if (!t) return;
      anchorFor(t.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setOutlineOpen(false);
    },
    [turns, anchorFor],
  );

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [scrollRef]);

  // Hide until there's enough content (and at least two questions) to warrant it.
  if (turns.length < 2 || !scrollable) return null;

  const atFirst = activeIndex <= 0;
  const atLast = activeIndex >= turns.length - 1;

  return (
    <div
      ref={rootRef}
      className="absolute z-20"
      style={{ right: 14, bottom: 96, pointerEvents: "auto" }}
    >
      {outlineOpen && (
        <div
          className="absolute rounded-lg overflow-hidden"
          style={{
            right: 0,
            bottom: "calc(100% + 8px)",
            width: 280,
            maxHeight: 320,
            background: "var(--vz-card)",
            border: "1px solid var(--vz-border)",
            boxShadow: "var(--vz-shadow-md)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: "8px 10px", borderBottom: "1px solid var(--vz-border)" }}
          >
            <span style={{ fontSize: 11, fontFamily: "var(--vz-font-mono)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--vz-muted-2)" }}>
              Questions · {turns.length}
            </span>
            <button type="button" onClick={() => setOutlineOpen(false)} className="vz-action-btn" style={{ width: 22, height: 22 }} aria-label="Close">
              <X className="w-3 h-3" />
            </button>
          </div>
          <div style={{ overflowY: "auto" }}>
            {turns.map((t, i) => (
              <button
                key={t.id}
                type="button"
                onClick={() => scrollToTurn(i)}
                className="w-full text-left transition-colors"
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "7px 10px",
                  fontSize: 12.5,
                  background: i === activeIndex ? "var(--vz-mute)" : "transparent",
                  color: i === activeIndex ? "var(--vz-ink)" : "var(--vz-ink-3)",
                  border: 0,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { if (i !== activeIndex) (e.currentTarget as HTMLElement).style.background = "var(--vz-mute)"; }}
                onMouseLeave={(e) => { if (i !== activeIndex) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={{ flexShrink: 0, width: 18, textAlign: "right", fontFamily: "var(--vz-font-mono)", fontSize: 10.5, color: "var(--vz-muted-2)" }}>
                  {i + 1}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.label || "(no text)"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className="flex flex-col rounded-full"
        style={{
          background: "var(--vz-card)",
          border: "1px solid var(--vz-border)",
          boxShadow: "var(--vz-shadow-md)",
          padding: 3,
          gap: 1,
        }}
      >
        <NavBtn label="Outline of questions" onClick={() => setOutlineOpen((o) => !o)} active={outlineOpen}>
          <List className="w-4 h-4" />
        </NavBtn>
        <NavBtn label="Go to top" onClick={scrollToTop}>
          <ChevronsUp className="w-4 h-4" />
        </NavBtn>
        <NavBtn label="Previous question" onClick={() => scrollToTurn(activeIndex - 1)} disabled={atFirst}>
          <ChevronUp className="w-4 h-4" />
        </NavBtn>
        <NavBtn label="Next question" onClick={() => scrollToTurn(activeIndex + 1)} disabled={atLast}>
          <ChevronDown className="w-4 h-4" />
        </NavBtn>
        <NavBtn label="Go to bottom" onClick={onScrollToBottom}>
          <ChevronsDown className="w-4 h-4" />
        </NavBtn>
      </div>
    </div>
  );
}

function NavBtn({
  children,
  label,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex items-center justify-center rounded-full transition-colors"
      style={{
        width: 30,
        height: 30,
        border: 0,
        cursor: disabled ? "default" : "pointer",
        background: active ? "var(--vz-sodium-08)" : "transparent",
        color: disabled ? "var(--vz-muted-2)" : active ? "var(--vz-sodium)" : "var(--vz-muted)",
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled && !active) (e.currentTarget as HTMLElement).style.background = "var(--vz-mute)"; }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      {children}
    </button>
  );
}
