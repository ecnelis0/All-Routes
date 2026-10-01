import { describe, expect, it } from "vitest";
import { chromiumGpuArgs, isSoftwareRenderer } from "./gpu";

describe("chromiumGpuArgs", () => {
  it("asks for Metal on macOS and Vulkan on Linux", () => {
    // Platform-specific because one flag set does not work everywhere;
    // Vulkan is also what an NVIDIA vGPU host would use.
    expect(chromiumGpuArgs("gpu", "darwin").join(" ")).toContain("--use-angle=metal");
    expect(chromiumGpuArgs("gpu", "linux").join(" ")).toContain("--use-angle=vulkan");
  });

  it("never requests SwiftShader in gpu mode", () => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      expect(chromiumGpuArgs("gpu", platform).join(" ")).not.toContain("swiftshader");
    }
  });

  it("requests SwiftShader, and only SwiftShader, in software mode", () => {
    const args = chromiumGpuArgs("software", "darwin").join(" ");
    expect(args).toContain("swiftshader");
    expect(args).not.toContain("metal");
  });

  it("enables the GPU explicitly, since headless disables it by default", () => {
    // Headless Chromium starts the GPU process but will not use it for
    // canvas work unless told to, which looks exactly like a working GPU
    // that is mysteriously slow.
    expect(chromiumGpuArgs("gpu", "linux")).toContain("--enable-gpu");
    expect(chromiumGpuArgs("gpu", "darwin")).toContain("--enable-gpu");
  });

  it("works around small /dev/shm on Linux containers", () => {
    // Without this Chromium crashes with a bare "Target closed" that reads
    // like a bug in the page rather than a container limit.
    expect(chromiumGpuArgs("gpu", "linux")).toContain("--disable-dev-shm-usage");
  });
});

describe("isSoftwareRenderer", () => {
  it("recognises the software rasterisers that silently stand in for a GPU", () => {
    // Real strings observed from headless Chromium.
    expect(
      isSoftwareRenderer(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)"
      )
    ).toBe(true);
    expect(isSoftwareRenderer("Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(isSoftwareRenderer("Microsoft Basic Render Driver")).toBe(true);
  });

  it("does not flag real hardware", () => {
    expect(
      isSoftwareRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)")
    ).toBe(false);
    expect(
      isSoftwareRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)")
    ).toBe(false);
    expect(isSoftwareRenderer("NVIDIA A10-4Q/PCIe/SSE2")).toBe(false);
  });
});
