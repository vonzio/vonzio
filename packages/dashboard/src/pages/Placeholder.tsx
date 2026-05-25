import type { ReactNode } from "react";
import { PageHeader, PageBody, Card, Pill } from "@/brand/components.js";

/**
 * Phase-1 placeholder for in-product pages while we redesign each one
 * onto the Sodium / Carbon shell. Renders inside the new AppShell so
 * the chrome (rail, topbar, statusbar) stays exercised even though
 * page-level functionality is offline on this branch.
 */
export function Placeholder({
  title,
  lede,
  redesignNote,
  features,
}: {
  title: ReactNode;
  lede?: ReactNode;
  /** One-liner about what this surface will become after redesign. */
  redesignNote?: ReactNode;
  /** Optional preview list of capabilities the redesigned page will offer. */
  features?: string[];
}) {
  return (
    <>
      <PageHeader
        eyebrow="redesign in progress"
        title={title}
        lede={lede}
        actions={<Pill tone="warn" dot>offline on this branch</Pill>}
      />
      <PageBody>
        <Card style={{ maxWidth: 720 }}>
          {redesignNote && (
            <p style={{ margin: 0, color: "var(--vz-ink-3)", lineHeight: 1.55 }}>
              {redesignNote}
            </p>
          )}
          {features && features.length > 0 && (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: redesignNote ? "20px 0 0" : 0,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {features.map((f, i) => (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    fontFamily: "var(--vz-font-mono)",
                    fontSize: 13,
                    color: "var(--vz-ink-2)",
                    letterSpacing: "0.01em",
                  }}
                >
                  <span style={{ color: "var(--vz-sodium)", flexShrink: 0 }}>▸</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}
          <div
            style={{
              marginTop: 24,
              paddingTop: 20,
              borderTop: "1px solid var(--vz-border)",
              fontFamily: "var(--vz-font-mono)",
              fontSize: 12,
              color: "var(--vz-muted-2)",
              letterSpacing: "0.04em",
            }}
          >
            $ branch redesign/app-shell · live functionality on{" "}
            <code style={{ color: "var(--vz-ink-3)" }}>version-2</code>
          </div>
        </Card>
      </PageBody>
    </>
  );
}
