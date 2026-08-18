import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import i18n from "@/i18n";
import { HomeHeroComposer } from "@/components/pages/HomeHeroComposer";

const t = i18n.getFixedT("zh", "dashboard");

describe("HomeHeroComposer", () => {
  beforeEach(() => {
    vi.spyOn(API, "getModelCandidates").mockRejectedValue(new Error("offline"));
    vi.spyOn(API, "getSystemConfig").mockRejectedValue(new Error("offline"));
  });

  it("updates the image dimensions from the grouped ratio and resolution controls", () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: t("home_image") }));
    fireEvent.click(screen.getByRole("button", { name: t("home_image_settings") }));
    fireEvent.click(screen.getByRole("button", { name: t("aspect_ratio_1_1") }));
    fireEvent.click(screen.getByRole("button", { name: "2K" }));

    const widthInput = screen.getByRole("spinbutton", { name: t("home_width") });
    const heightInput = screen.getByRole("spinbutton", { name: t("home_height") });
    expect(widthInput).toHaveValue(2048);
    expect(heightInput).toHaveValue(2048);

    fireEvent.change(widthInput, { target: { value: "1600" } });
    fireEvent.change(heightInput, { target: { value: "1200" } });
    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: t("home_image_settings") }));
    expect(screen.getByRole("spinbutton", { name: t("home_width") })).toHaveValue(1600);
    expect(screen.getByRole("spinbutton", { name: t("home_height") })).toHaveValue(1200);
    expect(screen.queryByRole("button", { name: t("home_duration") })).not.toBeInTheDocument();
  });

  it("groups video ratio, resolution, and quantity in one compact control", () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: t("home_video_settings") }));

    expect(screen.getByRole("button", { name: t("aspect_ratio_1_1") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1080P" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: t("home_image_settings") })).not.toBeInTheDocument();
  });

  it("clamps the video duration slider to the supported 4 to 15 second range", () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: t("home_duration") }));
    const slider = screen.getByRole("slider", { name: t("home_duration") });

    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("aria-valuemin", "4");
    expect(slider.getAttribute("style")).toContain("0.34");
    expect(slider).toHaveValue("4");
    fireEvent.change(slider, { target: { value: "2" } });
    expect(slider).toHaveValue("4");
    fireEvent.change(slider, { target: { value: "15" } });
    expect(slider).toHaveValue("15");
  });
});
