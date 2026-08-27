export interface AdminAuditEvent {
  id: number;
  actor_user_id: string | null;
  actor_username: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  project_id: string | null;
  project_name: string | null;
  details: Record<string, unknown>;
  created_at: string;
  operation?: string;
  summary?: string;
}

export interface AdminAuditEventsResponse {
  events: AdminAuditEvent[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminAuditEventFilters {
  page?: number;
  pageSize?: number;
  action?: string;
  projectId?: string;
  actorUserId?: string;
  actorUsername?: string;
  projectName?: string;
}

export type AdminLoginOutcome = "success" | "failure" | "rate_limited";

export interface AdminLoginEvent {
  id: string;
  user_id: string | null;
  username: string | null;
  outcome: AdminLoginOutcome;
  reason: string | null;
  session_id: string | null;
  device_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  endpoint: string;
  created_at: string;
}

export interface AdminLoginEventsResponse {
  events: AdminLoginEvent[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminLoginEventFilters {
  page?: number;
  pageSize?: number;
  username?: string;
  outcome?: AdminLoginOutcome | "";
}

export type AdminSessionStatus = "active" | "expired" | "revoked";

export interface AdminSession {
  id: string;
  user_id: string;
  username: string;
  device_id: string;
  ip_address: string | null;
  user_agent: string | null;
  status: AdminSessionStatus;
  last_seen_at: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AdminSessionsResponse {
  sessions: AdminSession[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminTaskResponse {
  task: import("./task").TaskItem;
}

export interface AdminTaskListResponse {
  items: import("./task").TaskItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminTaskStats {
  queued: number;
  running: number;
  cancelling: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  total: number;
}
