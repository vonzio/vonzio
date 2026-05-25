import { useState, useRef, useEffect } from "react";
import { ThumbsUp, ThumbsDown, Check } from "lucide-react";
import { createMemory } from "@/api/client";

interface ResponseFeedbackProps {
  responseText: string;
  profileId?: string;
  className?: string;
}

type Sentiment = "positive" | "negative";

export function ResponseFeedback({ responseText, profileId, className }: ResponseFeedbackProps) {
  const [sentiment, setSentiment] = useState<Sentiment | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded && inputRef.current) inputRef.current.focus();
  }, [expanded]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) collapse();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") collapse();
    }
    if (expanded) {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    }
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [expanded]);

  function collapse() {
    setExpanded(false);
    setSentiment(null);
    setText("");
  }

  function handleThumbClick(s: Sentiment) {
    setSentiment(s);
    setExpanded(true);
  }

  async function handleSubmit() {
    if (!sentiment) return;
    setSaving(true);
    const snippet = responseText.slice(0, 200);
    const feedbackText = [
      `Sentiment: ${sentiment}`,
      text ? `Comment: ${text}` : null,
      `Response snippet: ${snippet}${responseText.length > 200 ? "..." : ""}`,
    ].filter(Boolean).join("\n");

    try {
      await createMemory({
        name: "Response feedback",
        type: "feedback",
        body: feedbackText,
        description: sentiment,
        ...(profileId ? { profile_id: profileId } : {}),
      });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        collapse();
      }, 1200);
    } catch {
      // silently fail — this is a micro-interaction
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div className={`flex items-center gap-1 text-xs text-green-500 ${className ?? ""}`}>
        <Check className="w-3.5 h-3.5" />
        <span>Saved</span>
      </div>
    );
  }

  return (
    <div ref={ref} className={`flex items-center gap-1 ${className ?? ""}`}>
      <button
        onClick={() => handleThumbClick("positive")}
        className={`p-1 rounded transition-colors cursor-pointer ${
          sentiment === "positive" ? "text-green-500" : "text-gray-400 hover:text-gray-600"
        }`}
        title="Good response"
      >
        <ThumbsUp className="w-4 h-4" />
      </button>
      <button
        onClick={() => handleThumbClick("negative")}
        className={`p-1 rounded transition-colors cursor-pointer ${
          sentiment === "negative" ? "text-red-500" : "text-gray-400 hover:text-gray-600"
        }`}
        title="Bad response"
      >
        <ThumbsDown className="w-4 h-4" />
      </button>
      {expanded && (
        <div className="flex items-center gap-1 ml-1 animate-[fadeIn_0.15s_ease-out]">
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 200))}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            placeholder="Optional comment..."
            maxLength={200}
            className="h-7 w-48 px-2 text-xs border border-gray-200 rounded-md outline-none focus:border-gray-400 bg-white"
          />
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="h-7 px-2.5 text-xs font-medium text-white bg-accent rounded-md hover:bg-accent/90 disabled:opacity-50 cursor-pointer"
          >
            {saving ? "..." : "Submit"}
          </button>
        </div>
      )}
    </div>
  );
}
