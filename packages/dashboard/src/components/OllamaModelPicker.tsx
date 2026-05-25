/**
 * Ollama model picker with dynamic model loading.
 * Delete this file to remove Ollama support from the dashboard.
 */
import { useState, useEffect } from "react";
import { fetchOllamaModels } from "../api/client.js";
import { Select } from "../brand/components.js";

interface Props {
  apiKeyId: string;
  value: string;
  onChange: (value: string) => void;
}

export function OllamaModelPicker({ apiKeyId, value, onChange }: Props) {
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!apiKeyId) return;
    let cancelled = false;
    setLoading(true);
    fetchOllamaModels(apiKeyId)
      .then((res) => { if (!cancelled) setModels(res.models); })
      .catch(() => { if (!cancelled) setModels([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiKeyId]);

  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));
  // Keep an "orphan" entry visible if the saved value isn't in the loaded list,
  // so the user doesn't lose their selection when models change.
  const orphan = value && !models.some((m) => m.id === value)
    ? [{ value, label: value }]
    : [];
  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder={loading ? "Loading models…" : "Select model"}
      options={[
        ...orphan,
        ...sortedModels.map((m) => ({ value: m.id, label: m.name })),
      ]}
    />
  );
}
