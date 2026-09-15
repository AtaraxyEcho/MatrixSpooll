import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import "@/i18n";
import { CapabilityTogglesRow } from "@/components/pages/settings/CustomProviderForm";

const OPTIONS = ["720p", "1080p", "4K"];

// 受控包装：onChange 回写 state，与真实父组件一致，断言才能看到添加后的 chip 状态
function setup(initial?: string[]) {
  const onChange = vi.fn();
  function Wrapper() {
    const [userValues, setUserValues] = useState<string[] | undefined>(initial);
    return (
      <CapabilityTogglesRow
        label="分辨率档位"
        help="help"
        options={OPTIONS}
        userValues={userValues}
        systemValues={null}
        onChange={(next) => {
          onChange(next);
          setUserValues(next);
        }}
      />
    );
  }
  render(<Wrapper />);
  return { onChange };
}

const customInput = () => screen.getByPlaceholderText("自定义值");

describe("CapabilityTogglesRow 自定义值添加", () => {
  it("回车添加自定义值只追加该值，不把标准档位全部勾选", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.type(customInput(), "2K{Enter}");
    expect(onChange).toHaveBeenCalledWith(["2K"]);
    // 标准档位保持未选中
    expect(screen.getByRole("button", { name: "720p" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "1080p" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "2K" })).toHaveAttribute("aria-pressed", "true");
  });

  it("已有选中档位时，添加自定义值保留既有选中", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(["1080p"]);
    await user.type(customInput(), "2K{Enter}");
    expect(onChange).toHaveBeenCalledWith(["1080p", "2K"]);
    expect(screen.getByRole("button", { name: "1080p" })).toHaveAttribute("aria-pressed", "true");
  });

  it("点 + 按钮与回车等效", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.type(customInput(), "2K");
    await user.click(screen.getByRole("button", { name: "添加自定义值" }));
    expect(onChange).toHaveBeenCalledWith(["2K"]);
  });

  it("与既有 chip 重复时直接收起输入，不产生写入", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(["1080p"]);
    await user.type(customInput(), "1080p{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(customInput()).toHaveValue("");
  });

  it("自定义比例非法时拒绝添加并显示错误文案", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CapabilityTogglesRow
        label="宽高比"
        help="help"
        options={OPTIONS}
        userValues={undefined}
        systemValues={null}
        validateCustom={() => "比例格式应为 宽:高（如 16:9）"}
        onChange={onChange}
      />,
    );
    await user.type(customInput(), "abc{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("比例格式应为 宽:高（如 16:9）")).toBeInTheDocument();
  });
});

describe("CapabilityTogglesRow 档位勾选", () => {
  it("取消勾选一个档位不影响其它已选值", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(["720p", "4K"]);
    await user.click(screen.getByRole("button", { name: "720p" }));
    expect(onChange).toHaveBeenCalledWith(["4K"]);
  });

  it("全部取消勾选后回写空数组，由 withCapabilityOverride 收敛为键移除", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(["1080p"]);
    await user.click(screen.getByRole("button", { name: "1080p" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
