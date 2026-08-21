import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AboutSection } from "@/components/pages/settings/AboutSection";

describe("AboutSection", () => {
  it("only renders the required ArcReel attribution", () => {
    const { container } = render(<AboutSection />);

    const link = screen.getByRole("link", { name: "https://github.com/ArcReel/ArcReel" });
    expect(link).toHaveAttribute("href", "https://github.com/ArcReel/ArcReel");
    expect(link).toHaveAttribute("target", "_blank");
    expect(container).toHaveTextContent(
      "Powered by ArcReel — https://github.com/ArcReel/ArcReel",
    );
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
