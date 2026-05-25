import { cn } from "../lib/utils.js";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
}

export function Textarea({ label, hint, className, id, ...props }: TextareaProps) {
  const textareaId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div>
      {label && (
        <label htmlFor={textareaId} className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        className={cn(
          "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-mono",
          "placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent",
          "disabled:bg-gray-50 disabled:text-gray-500 resize-y",
          className,
        )}
        rows={4}
        {...props}
      />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
