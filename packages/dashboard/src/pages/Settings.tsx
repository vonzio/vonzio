import { useState, useEffect, useCallback } from "react";
import { PageHeader, PageBody, Tabs } from "../brand/components.js";
import { getSettingsSections } from "../registry/index.js";

export function Settings() {
  const sections = getSettingsSections();
  const tabs = sections.map((s) => ({ value: s.id, label: s.label }));
  const validIds = sections.map((s) => s.id);
  const hashTab = window.location.hash.slice(1);
  const [activeTab, setActiveTabRaw] = useState(validIds.includes(hashTab) ? hashTab : (validIds[0] ?? ""));

  const setActiveTab = useCallback((id: string) => {
    setActiveTabRaw(id);
    window.location.hash = id;
  }, []);

  useEffect(() => {
    const handler = () => {
      const h = window.location.hash.slice(1);
      if (validIds.includes(h)) setActiveTabRaw(h);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validIds.join(",")]);

  const active = sections.find((s) => s.id === activeTab);
  const ActiveComponent = active?.component;

  return (
    <>
      <PageHeader eyebrow="Settings" title="Account & access" lede={active?.lede} />
      <PageBody>
        <Tabs tabs={tabs} value={activeTab} onChange={setActiveTab} />
        <div style={{ marginTop: 24 }}>
          {ActiveComponent && <ActiveComponent />}
        </div>
      </PageBody>
    </>
  );
}
