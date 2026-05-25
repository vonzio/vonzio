import { useRef, useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/brand/components.js";

interface Props {
  logs: string[];
}

export function LogsTab({ logs }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  function copyAll() {
    navigator.clipboard.writeText(logs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col h-full">
      {logs.length > 0 && (
        <div
          className="flex justify-end px-3 py-1.5"
          style={{ borderBottom: "1px solid var(--vz-border)" }}
        >
          <Button
            variant="ghost"
            size="sm"
            mono
            icon={copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            onClick={copyAll}
          >
            {copied ? "Copied" : "Copy all"}
          </Button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
      >
        {logs.length === 0 ? (
          <div
            className="flex items-center justify-center h-full text-sm"
            style={{ color: "var(--vz-muted)" }}
          >
            No logs yet
          </div>
        ) : (
          <div className="divide-y divide-[var(--vz-border)]">
            {logs.map((line, i) => (
              <div
                key={i}
                className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all"
                style={{ color: "var(--vz-ink-2)" }}
              >
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
