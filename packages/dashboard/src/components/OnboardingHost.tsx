import { useEffect, useState } from "react";
import { Modal } from "@/brand/components.js";
import { getOnboardingSteps, type OnboardingStepReg } from "@/registry/index.js";

/**
 * Mounts once near the root and renders whichever onboarding step's
 * predicate currently returns true (lowest `order` wins). When the
 * step signals completion (onNext) or skip (onSkip), the modal closes
 * and we don't re-evaluate this session — sessionStorage tracks the
 * dismissal so navigating around doesn't re-pop the same modal.
 *
 * Predicates are async-friendly because they often need a network
 * round-trip (e.g. "does this user have an API key yet?"). The host
 * runs them sequentially and stops at the first that resolves to
 * true. Steps with no predicate always match.
 */
const DISMISS_KEY_PREFIX = "vonzio_onboarding_dismissed_";

function isDismissed(stepId: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY_PREFIX + stepId) === "1";
  } catch { return false; }
}

function markDismissed(stepId: string): void {
  try {
    sessionStorage.setItem(DISMISS_KEY_PREFIX + stepId, "1");
  } catch { /* private mode etc — accept that the modal will re-pop */ }
}

export function OnboardingHost() {
  const [active, setActive] = useState<OnboardingStepReg | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const step of getOnboardingSteps()) {
        if (isDismissed(step.id)) continue;
        try {
          const matches = step.predicate ? await step.predicate() : true;
          if (cancelled) return;
          if (matches) {
            setActive(step);
            return;
          }
        } catch {
          // A predicate that throws shouldn't block the whole onboarding —
          // skip and try the next one.
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!active) return null;
  const close = () => {
    markDismissed(active.id);
    setActive(null);
  };
  const StepComp = active.component;
  return (
    <Modal open onClose={close} dismissable={true} size="md">
      <StepComp onNext={close} onSkip={close} />
    </Modal>
  );
}
