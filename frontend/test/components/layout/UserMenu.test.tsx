import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { UserMenu } from "@/components/layout/UserMenu";
import { useAuthStore } from "@/stores/auth-store";

function renderUserMenu(path = "/app") {
  const memory = memoryLocation({ path, record: true });
  const view = render(
    <Router hook={memory.hook}>
      <UserMenu />
    </Router>,
  );
  return { ...view, history: memory.history };
}

describe("UserMenu", () => {
  beforeEach(() => {
    useAuthStore.setState({
      username: null,
      role: null,
      isAuthenticated: false,
      isLoading: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 204 } as unknown as Response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders nothing when there is no active session", () => {
    renderUserMenu();
    // AUTH_ENABLED=false 等无会话场景不该出现可点的退出入口
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the menu on avatar click and shows account actions for admins", () => {
    useAuthStore.setState({
      username: "alice",
      role: "admin",
      isAuthenticated: true,
      isLoading: false,
    });
    renderUserMenu();

    fireEvent.click(screen.getByTitle("alice"));

    expect(screen.getByText("管理员")).toBeInTheDocument();
    expect(screen.getByText("管理员入口")).toBeInTheDocument();
    expect(screen.getByText("账户安全")).toBeInTheDocument();
    expect(screen.getByText("登出")).toBeInTheDocument();
  });

  it("hides the admin portal for members", () => {
    useAuthStore.setState({
      username: "bob",
      role: "member",
      isAuthenticated: true,
      isLoading: false,
    });
    renderUserMenu();

    fireEvent.click(screen.getByTitle("bob"));

    expect(screen.getByText("普通成员")).toBeInTheDocument();
    expect(screen.queryByText("管理员入口")).toBeNull();
    expect(screen.getByText("登出")).toBeInTheDocument();
  });

  it("opens the password modal from the menu and closes the popover", () => {
    useAuthStore.setState({
      username: "alice",
      role: "admin",
      isAuthenticated: true,
      isLoading: false,
    });
    renderUserMenu();

    fireEvent.click(screen.getByTitle("alice"));
    fireEvent.click(screen.getByText("账户安全"));

    // 菜单已收起、弹窗打开且渲染修改密码表单
    expect(screen.queryByText("管理员入口")).toBeNull();
    expect(screen.getByLabelText(/^当前密码/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^新密码/)).toBeInTheDocument();
  });

  it("confirms logout, clears the session and redirects to login with the return path", () => {
    useAuthStore.setState({
      username: "alice",
      role: "member",
      isAuthenticated: true,
      isLoading: false,
    });
    const { history } = renderUserMenu("/app/projects/demo");

    fireEvent.click(screen.getByTitle("alice"));
    fireEvent.click(screen.getByText("登出"));
    fireEvent.click(screen.getByRole("button", { name: "登出" }));

    expect(useAuthStore.getState().username).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(history.at(-1)).toMatch(/^\/login\?from=/);
  });
});
