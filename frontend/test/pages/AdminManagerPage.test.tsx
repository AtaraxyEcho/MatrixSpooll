import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import i18n from "@/i18n";
import { AdminManagerPage } from "@/pages/AdminManagerPage";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

const t = i18n.getFixedT("zh", "admin");

function renderPage(section: "logs" | "sessions") {
  const location = memoryLocation({ path: `/app/admin/manager/${section}`, record: true });
  return render(
    <Router hook={location.hook}>
      <AdminManagerPage section={section} />
    </Router>,
  );
}

describe("AdminManagerPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAuthStore.setState({
      ...useAuthStore.getInitialState(),
      isAuthenticated: true,
      isLoading: false,
      role: "admin",
    }, true);
  });

  it("keeps login history separate from operation logs and shows event details", async () => {
    vi.spyOn(API, "listAdminAuditEvents").mockResolvedValue({
      events: [],
      total: 0,
      page: 1,
      page_size: 10,
    });
    const listLoginEvents = vi.spyOn(API, "listAdminLoginEvents").mockResolvedValue({
      events: [{
        id: "login-event-1",
        user_id: "user-1",
        username: "alice",
        outcome: "failure",
        reason: "invalid_credentials",
        session_id: null,
        device_id: "browser-device",
        ip_address: "192.0.2.10",
        user_agent: "Test Browser",
        endpoint: "/api/v1/auth/login",
        created_at: "2026-08-26T08:00:00Z",
      }],
      total: 1,
      page: 1,
      page_size: 10,
    });

    renderPage("logs");
    fireEvent.click(await screen.findByRole("tab", { name: t("login_logs_tab") }));

    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText(t("login_reason_invalid_credentials"))).toBeInTheDocument();
    expect(listLoginEvents).toHaveBeenCalledWith({
      page: 1,
      pageSize: 10,
      username: "",
      outcome: "",
    });

    fireEvent.click(screen.getByRole("button", { name: t("view_details") }));
    expect(await screen.findByText("/api/v1/auth/login")).toBeInTheDocument();
  });

  it("labels the session list as active sessions", async () => {
    vi.spyOn(API, "listAdminSessions").mockResolvedValue({
      sessions: [],
      total: 0,
      page: 1,
      page_size: 10,
    });

    renderPage("sessions");

    await waitFor(() => expect(API.listAdminSessions).toHaveBeenCalled());
    expect(screen.getByText(t("sessions_description"))).toBeInTheDocument();
    expect(screen.getByText(t("sessions_empty"))).toBeInTheDocument();
  });
});
