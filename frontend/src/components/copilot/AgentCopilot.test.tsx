import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Bot } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentParameterControl, HomeSelect } from "@/components/pages/HomeHeroComposer";
import { useAssistantSession } from "@/hooks/useAssistantSession";
import { useAppStore } from "@/stores/app-store";
import { useAssistantStore } from "@/stores/assistant-store";
import { useProjectsStore } from "@/stores/projects-store";
import { UI_LAYERS } from "@/utils/ui-layers";
import { AgentCopilot } from "./AgentCopilot";

vi.mock("@/hooks/useAssistantSession", () => ({
  useAssistantSession: vi.fn(),
}));

vi.mock("./ContextBanner", () => ({
  ContextBanner: () => <div data-testid="context-banner" />,
}));

vi.mock("./SlashCommandMenu", () => ({
  SlashCommandMenu: vi.fn(() => null),
}));

vi.mock("./chat/ChatMessage", () => ({
  ChatMessage: ({ message }: { message: { type: string } }) => (
    <div data-testid="chat-message">{message.type}</div>
  ),
}));

const mockedUseAssistantSession = vi.mocked(useAssistantSession);

function makePendingQuestion() {
  return {
    question_id: "q-1",
    questions: [
      {
        header: "输出",
        question: "输出格式是什么？",
        multiSelect: false,
        options: [
          { label: "摘要", description: "简洁输出" },
          { label: "详细", description: "完整说明" },
        ],
      },
    ],
  };
}

describe("AgentCopilot", () => {
  // Mocks whose callers wrap them with voidPromise must return a Promise
  // so the .catch(...) chain in voidPromise resolves instead of crashing.
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const rewriteMessage = vi.fn().mockResolvedValue(true);
  const answerQuestion = vi.fn().mockResolvedValue(undefined);
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const createNewSession = vi.fn();
  const switchSession = vi.fn().mockResolvedValue(undefined);
  const deleteSession = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    useAssistantStore.setState(useAssistantStore.getInitialState(), true);
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.clearAllMocks();

    useProjectsStore.getState().setCurrentProject("demo", null);
    mockedUseAssistantSession.mockReturnValue({
      sendMessage,
      rewriteMessage,
      answerQuestion,
      interrupt,
      createNewSession,
      switchSession,
      deleteSession,
    });
  });

  it("renders the pending-question wizard and disables normal sending", () => {
    useAssistantStore.setState({
      pendingQuestion: makePendingQuestion(),
      skills: [{ name: "plan", description: "Plan", scope: "project", path: "/tmp/plan" }],
    });

    render(<AgentCopilot />);

    expect(screen.getByText("需要你的选择")).toBeInTheDocument();
    expect(screen.getByLabelText("助手输入")).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toBeDisabled();
    expect(screen.getByPlaceholderText("请先回答上方问题")).toBeInTheDocument();
  });

  it("submits wizard answers through answerQuestion", () => {
    useAssistantStore.setState({
      pendingQuestion: makePendingQuestion(),
    });

    render(<AgentCopilot />);

    fireEvent.click(screen.getByLabelText("摘要"));
    fireEvent.click(screen.getByRole("button", { name: /完成并提交/ }));

    expect(answerQuestion).toHaveBeenCalledWith("q-1", {
      "输出格式是什么？": "摘要",
    });
  });

  it("keeps assistant root isolated and uses local popover layer for session history", () => {
    useAssistantStore.setState({
      sessions: [
        {
          id: "session-1",
          project_name: "demo",
          title: "当前会话",
          status: "idle",
          created_at: "2026-02-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
        },
      ],
      currentSessionId: "session-1",
    });

    const { container } = render(<AgentCopilot />);

    expect(container.firstElementChild).toHaveClass("isolate");

    fireEvent.click(screen.getByTitle("切换会话"));
    expect(document.querySelector(`.${UI_LAYERS.assistantLocalPopover}`)).toBeTruthy();
  });

  it("does not send when Enter is used to confirm an IME composition", () => {
    render(<AgentCopilot />);

    const textarea = screen.getByLabelText("助手输入");
    fireEvent.change(textarea, { target: { value: "你好" } });

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      which: 229,
      isComposing: true,
    });

    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    });

    expect(sendMessage).toHaveBeenCalledWith("你好", undefined);
  });

  it("consumes a one-shot prefill dispatched via the assistant store's input field", async () => {
    render(<AgentCopilot />);

    act(() => {
      useAssistantStore.getState().setInput("为第 1 集生成剧本");
    });

    expect(screen.getByLabelText("助手输入")).toHaveValue("为第 1 集生成剧本");

    await waitFor(() => {
      expect(useAssistantStore.getState().input).toBe("");
    });
  });

  it("consumes a prefill queued before the embedded composer mounts", async () => {
    useAssistantStore.getState().setInput("Plan a short launch video");

    render(<AgentCopilot embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("助手输入")).toHaveValue("Plan a short launch video");
    });
    await waitFor(() => expect(useAssistantStore.getState().input).toBe(""));
  });

  it("detaches only the composer while leaving the conversation in its panel", () => {
    const { container } = render(<AgentCopilot embedded detachedComposer />);

    expect(container.querySelector(".agent-copilot-composer--detached")).toBeInTheDocument();
    expect(container.querySelector(".agent-copilot-composer--detached")?.parentElement).toBe(container.firstElementChild);
  });

  it("uses the compact parameter strip for detached Agent controls", () => {
    render(
      <AgentCopilot
        embedded
        detachedComposer
        footerStart={(
          <>
            <HomeSelect
              label="创作模式"
              value="agent"
              options={[{ value: "agent", label: "Agent 模式" }]}
              icon={Bot}
              onChange={vi.fn()}
              className="free-creation-mode-control"
              hideLabel
              placement="top"
            />
            <AgentParameterControl
              label="Agent 参数"
              preferenceLabel="生成偏好"
              imageLabel="图片"
              videoLabel="视频"
              ratioLabel="比例"
              preference="video"
              ratio="16:9"
              ratioOptions={[{ value: "16:9", label: "16:9" }]}
              onPreferenceChange={vi.fn()}
              onRatioChange={vi.fn()}
              hideLabel
              placement="top"
            />
          </>
        )}
      />,
    );

    const modeTrigger = screen.getByRole("button", { name: "创作模式" });
    const parameterStrip = modeTrigger.parentElement?.parentElement;
    expect(parameterStrip).toHaveClass("composer-param-strip");

    fireEvent.click(screen.getByRole("button", { name: "Agent 参数" }));
    expect(screen.getByRole("dialog", { name: "Agent 参数" })).toBeInTheDocument();
    expect(parameterStrip).toContainElement(screen.getByRole("button", { name: "Agent 参数" }));
  });

});
