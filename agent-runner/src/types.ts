export interface McpServerConfig {
  name: string;
  type: "sdk" | "stdio" | "http";
  tools?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ToolFilePayload {
  name: string;
  code: string;
}

export interface Attachment {
  type: "image" | "document";
  media_type: string; // e.g. "image/png", "application/pdf"
  data: string;       // base64-encoded
  name?: string;      // optional filename
}

export interface TaskPayload {
  prompt: string;
  allowed_tools?: string[];
  max_turns?: number;
  max_budget_usd?: number;
  session_id?: string;
  resume?: boolean;
  output_schema?: Record<string, unknown>;
  mcp_servers?: McpServerConfig[];
  tool_files?: ToolFilePayload[];
  system_prompt?: string;
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
  has_skills?: boolean;
  model?: string;
  effort?: string;
  attachments?: Attachment[];
}

export interface RunnerMessage {
  type: "init" | "token" | "tool_use" | "tool_result" | "result" | "error" | "exit" | "ask_user";
  session_id?: string;
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  result?: {
    text: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    turns: number;
  };
  error?: string;
  code?: number;
}
