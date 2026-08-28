import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import { LegalPage } from "@/components/pages/LegalPage";

function renderPage() {
  const location = memoryLocation({ path: "/app/about", record: true });
  return render(
    <Router hook={location.hook}>
      <LegalPage />
    </Router>,
  );
}

describe("LegalPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose a source link when downloads are disabled", async () => {
    vi.spyOn(API, "getLegalDisclosure").mockResolvedValue({
      attribution: "Powered by ArcReel — https://github.com/ArcReel/ArcReel",
      repository_url: "https://github.com/ArcReel/ArcReel",
      license_name: "GNU Affero General Public License v3.0",
      license_download_url: "/api/v1/system/license/download",
      modified_product: "MatrixSpooll",
      modified_by: "MockMine",
      modification_date: "2026-08-28",
      source_release: {
        enabled: false,
        available: false,
      },
    });

    renderPage();

    expect(await screen.findByText("源码下载暂未开放。")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下载当前版本源码" })).not.toBeInTheDocument();
  });
});
