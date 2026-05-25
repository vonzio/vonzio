import { cn } from "../lib/utils.js";

interface CardProps {
  children: React.ReactNode;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  padding?: boolean;
}

export function Card({
  children,
  title,
  description,
  actions,
  className,
  padding = true,
}: CardProps) {
  return (
    <div className={cn("bg-white border border-gray-200 rounded-lg", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            {title && <h3 className="text-sm font-semibold text-gray-900">{title}</h3>}
            {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
          </div>
          {actions && <div>{actions}</div>}
        </div>
      )}
      <div className={cn(padding && "p-5")}>{children}</div>
    </div>
  );
}
