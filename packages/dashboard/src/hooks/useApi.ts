import { useState, useEffect, useCallback, useRef } from "react";

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /**
   * Triggers an immediate refetch. Returns a promise that resolves
   * (with `void`) once the fetched data has been applied — or rejects
   * with the fetch error. Lets callers do `await refetch()` and then
   * setCurrent(...) without racing the new data into state.
   */
  refetch: () => Promise<void>;
}

export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // The pending refetch's resolve/reject — fulfilled inside the effect
  // once the in-flight promise settles. New refetch() calls overwrite
  // the prior promise (callers awaiting the previous one still get
  // resolved or rejected by THAT effect run).
  const pendingResolveRef = useRef<(() => void) | null>(null);
  const pendingRejectRef = useRef<((err: unknown) => void) | null>(null);

  const refetch = useCallback((): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      pendingResolveRef.current = resolve;
      pendingRejectRef.current = reject;
      setTick((t) => t + 1);
    });
  }, []);

  // Stable dependency key from the deps array
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    let cancelled = false;
    // Only show loading spinner on initial fetch, not background refreshes
    if (data === null) setLoading(true);
    setError(null);

    fetcherRef.current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
          pendingResolveRef.current?.();
          pendingResolveRef.current = null;
          pendingRejectRef.current = null;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setLoading(false);
          pendingRejectRef.current?.(err);
          pendingResolveRef.current = null;
          pendingRejectRef.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, depsKey]);

  return { data, loading, error, refetch };
}
