import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { AboutSection } from "@/components/pages/settings/AboutSection";

describe("AboutSection", () => {
  it("renders the attribution returned from the NOTICE-backed API", async () => {
    vi.spyOn(API, "getLegalAttribution").mockResolvedValue({
      attribution: "Powered by Upstream — https://example.test/upstream",
      repository_url: "https://example.test/upstream",
    });
    const { container } = render(<AboutSection />);

    const link = await screen.findByRole("link", { name: "https://example.test/upstream" });
    expect(link).toHaveAttribute("href", "https://example.test/upstream");
    expect(link).toHaveAttribute("target", "_blank");
    expect(container).toHaveTextContent("Powered by Upstream — https://example.test/upstream");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
