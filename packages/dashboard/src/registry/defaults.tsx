import {
  Activity,
  Bot,
  Brain,
  CalendarClock,
  MessageSquare,
  Settings as SettingsIcon,
  Shield,
} from "lucide-react";
import { Workspace } from "../pages/Workspace.js";
import { MyAgents } from "../pages/MyAgents.js";
import { EditAgent } from "../pages/EditAgent.js";
import { Playbooks } from "../pages/Playbooks.js";
import Memories from "../pages/Memories.js";
import { Settings } from "../pages/Settings.js";
import { Admin } from "../pages/Admin.js";
import { Operations } from "../pages/Operations.js";
import { AccountSection } from "../pages/settings/sections/Account.js";
import { AnthropicKeySection } from "../pages/settings/sections/AnthropicKey.js";
import { SecretSection } from "../pages/settings/sections/Secret.js";
import { GitSection } from "../pages/settings/sections/Git.js";
import { IntegrationSection } from "../pages/settings/sections/Integration.js";
import { ApiTokenSection } from "../pages/settings/sections/ApiToken.js";
import {
  registerNavItem,
  registerRoute,
  registerSettingsSection,
} from "./registry.js";

let registered = false;

export function registerDefaults(): void {
  if (registered) return;
  registered = true;

  registerNavItem({
    id: "workspace",
    section: "primary",
    label: "Workspace",
    to: "/",
    icon: MessageSquare,
    match: (p) => p === "/" || p.startsWith("/w/"),
    order: 10,
  });
  registerNavItem({
    id: "agents",
    section: "primary",
    label: "Agents",
    to: "/agents",
    icon: Bot,
    match: (p) => p.startsWith("/agents"),
    order: 20,
  });
  registerNavItem({
    id: "playbooks",
    section: "primary",
    label: "Playbooks",
    to: "/playbooks",
    icon: CalendarClock,
    match: (p) => p.startsWith("/playbooks"),
    order: 30,
  });
  registerNavItem({
    id: "memories",
    section: "primary",
    label: "Memories",
    to: "/memories",
    icon: Brain,
    match: (p) => p.startsWith("/memories"),
    order: 40,
  });

  registerNavItem({
    id: "operations",
    section: "admin",
    label: "Operations",
    to: "/ops",
    icon: Activity,
    match: (p) => p.startsWith("/ops"),
    entitlement: "admin",
    order: 10,
  });
  registerNavItem({
    id: "admin",
    section: "admin",
    label: "Admin",
    to: "/admin",
    icon: Shield,
    match: (p) => p.startsWith("/admin"),
    entitlement: "admin_multitenant",
    order: 20,
  });

  registerNavItem({
    id: "settings",
    section: "footer",
    label: "Settings",
    to: "/settings",
    icon: SettingsIcon,
    match: (p) => p.startsWith("/settings"),
    order: 10,
  });

  registerRoute({ id: "workspace-root", path: "/", element: <Workspace />, layout: "shell", order: 10 });
  registerRoute({ id: "workspace-id", path: "/w/:id", element: <Workspace />, layout: "shell", order: 11 });
  registerRoute({ id: "agents-list", path: "/agents", element: <MyAgents />, layout: "shell", order: 20 });
  registerRoute({ id: "agents-new", path: "/agents/new", element: <EditAgent />, layout: "shell", order: 21 });
  registerRoute({ id: "agents-edit", path: "/agents/:id/edit", element: <EditAgent />, layout: "shell", order: 22 });
  registerRoute({ id: "playbooks", path: "/playbooks", element: <Playbooks />, layout: "shell", order: 30 });
  registerRoute({ id: "memories", path: "/memories", element: <Memories />, layout: "shell", order: 40 });
  registerRoute({ id: "settings", path: "/settings", element: <Settings />, layout: "shell", order: 50 });
  registerRoute({ id: "ops", path: "/ops", element: <Operations />, layout: "shell", entitlement: "admin", order: 60 });
  registerRoute({ id: "admin", path: "/admin", element: <Admin />, layout: "shell", entitlement: "admin_multitenant", order: 70 });

  registerSettingsSection({ id: "account", label: "Account", lede: "Profile, password, and connected social accounts.", component: AccountSection, order: 10 });
  registerSettingsSection({ id: "apikeys", label: "Keys", lede: "Anthropic API credentials used by your agent profiles. Bring your own.", component: AnthropicKeySection, order: 20 });
  registerSettingsSection({ id: "secrets", label: "Secrets", lede: "Encrypted environment variables injected into agent containers at runtime.", component: SecretSection, order: 30 });
  registerSettingsSection({ id: "git", label: "Git", lede: "Git credentials for cloning private repos. Wire one to a profile to give it write access.", component: GitSection, order: 40 });
  registerSettingsSection({ id: "integrations", label: "Integrations", lede: "Notifications, chat, and read-only data sources your agents can use.", component: IntegrationSection, order: 50 });
  registerSettingsSection({ id: "apitokens", label: "API tokens", lede: "API tokens for programmatic access — embed widgets, CLI, or external integrations.", component: ApiTokenSection, order: 60 });
}
