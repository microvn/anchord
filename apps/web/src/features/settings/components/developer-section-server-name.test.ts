import { describe, it, expect } from "bun:test";
import { mcpServerName } from "@/features/settings/components/developer-section";

// mcp-roundtrip — the setup snippet names the MCP server per the token's workspace
// (`anchord-<workspace>`), sanitized so it's a safe CLI/config identifier and unique per
// workspace. No workspace yet → the bare `anchord`.
describe("mcpServerName", () => {
  it("falls back to bare 'anchord' when no workspace is known", () => {
    expect(mcpServerName(null)).toBe("anchord");
    expect(mcpServerName(undefined)).toBe("anchord");
    expect(mcpServerName("")).toBe("anchord");
    expect(mcpServerName("   ")).toBe("anchord");
  });

  it("slugifies a workspace name and suffixes it", () => {
    expect(mcpServerName("Acme")).toBe("anchord-acme");
    expect(mcpServerName("Hoang's Team")).toBe("anchord-hoang-s-team");
    expect(mcpServerName("  Design  System  ")).toBe("anchord-design-system");
    expect(mcpServerName("R&D / Q4")).toBe("anchord-r-d-q4");
  });

  it("folds Vietnamese diacritics and đ to ASCII", () => {
    expect(mcpServerName("Đội Marketing")).toBe("anchord-doi-marketing");
    expect(mcpServerName("Phòng Kỹ Thuật")).toBe("anchord-phong-ky-thuat");
  });

  it("caps the slug length and never ends on a dash", () => {
    const out = mcpServerName("x".repeat(80));
    expect(out.startsWith("anchord-")).toBe(true);
    expect(out.length).toBeLessThanOrEqual("anchord-".length + 32);
    expect(out.endsWith("-")).toBe(false);
  });
});
