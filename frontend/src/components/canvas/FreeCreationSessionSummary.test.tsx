import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import type { FreeCreationRequestSummary } from "@/types";
import { FreeCreationSessionSummary } from "./FreeCreationSessionSummary";

const t = i18n.getFixedT("zh", "dashboard");

const request: FreeCreationRequestSummary = {
  request_id: "q_0123456789abcdef0123",
  prompt: "雨夜车站\n角色回头看向镜头",
  output_type: "video",
  media_type: "video",
  effective_mode: "reference_image",
  model: "ark/seedance",
  reference_claims: [
    { type: "upload", reference_id: "r_0123456789abcdef0123", role: "reference_image" },
  ],
  reference_count: 1,
  quantity: 2,
  creation_ids: ["c_0123456789abcdef0123", "c_0123456789abcdef0124"],
  result_count: 1,
  status: "partial",
  status_counts: { succeeded: 1, failed: 1 },
  created_at: "2026-08-19T10:00:00Z",
  updated_at: "2026-08-19T10:02:00Z",
};

describe("FreeCreationSessionSummary", () => {
  it("renders one direct-generation request instead of one chat item per result", () => {
    render(<FreeCreationSessionSummary requests={[request]} />);

    expect(screen.getByRole("heading", { name: t("free_creation_session_summary") })).toBeInTheDocument();
    expect(screen.getByText(t("free_creation_session_count", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText("雨夜车站 角色回头看向镜头")).toBeInTheDocument();
    expect(screen.getByText(t("free_creation_mode_reference_image"))).toBeInTheDocument();
    expect(screen.getByText("ark/seedance")).toBeInTheDocument();
    expect(screen.getByText(t("free_creation_bound_resources", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(t("free_creation_request_results", { completed: 1, total: 2 }))).toBeInTheDocument();
    expect(screen.getByText(t("free_creation_status_partial"))).toBeInTheDocument();
  });

  it("opens request history without changing the data source to an Agent transcript", () => {
    render(<FreeCreationSessionSummary requests={[request]} />);

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_request_history") }));

    expect(screen.getByRole("dialog", { name: t("free_creation_request_history") })).toBeInTheDocument();
    expect(screen.getAllByText("雨夜车站 角色回头看向镜头")).toHaveLength(2);
  });
});
