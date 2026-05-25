export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Memory {
  id: string;
  user_id: string;
  profile_id: string | null;
  type: MemoryType;
  name: string;
  description: string | null;
  body: string;
  importance: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

export interface CreateMemoryInput {
  name: string;
  type: MemoryType;
  body: string;
  description?: string;
  profile_id?: string;
}

export interface UpdateMemoryInput {
  name?: string;
  type?: MemoryType;
  body?: string;
  description?: string;
}

export interface SearchMemoryInput {
  query: string;
  type?: MemoryType;
  profile_id?: string;
  limit?: number;
}
