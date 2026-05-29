import { PageHeader, PageBody, Tabs } from "../brand/components.js";
import { getSettingsSections, useEntitlements } from "../registry/index.js";
import { useHashTab } from "../hooks/useHashTab.js";

export function Settings() {
  const entitlements = useEntitlements();
  const sections = getSettingsSections().filter(
    (s) => !s.entitlement || entitlements.includes(s.entitlement),
  );
  const tabs = sections.map((s) => ({ value: s.id, label: s.label }));
  const validIds = sections.map((s) => s.id);
  const [activeTab, setActiveTab] = useHashTab(validIds, validIds[0] ?? "");

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
