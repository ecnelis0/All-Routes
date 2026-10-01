/**
 * Chromium flags for headless 3D rendering.
 *
 * Headless Chromium defaults to SwiftShader, Google's software rasteriser.
 * It is correct but entirely CPU-bound, and for a tilted map with terrain,
 * extruded buildings and aerial imagery it is roughly an order of
 * magnitude slower than the GPU sitting idle in the same machine. Every
 * earlier verification run in this project unknowingly used it.
 *
 * The right backend is platform-specific, so this picks one rather than
 * hoping a single flag set works everywhere:
 *   - macOS  -> ANGLE over Metal
 *   - Linux  -> ANGLE over Vulkan (what an NVIDIA vGPU host would use)
 *   - else   -> let Chromium choose
 *
 * `verifyRenderer` exists because asking for the GPU is not the same as
 * getting it: a misconfigured container, a missing driver or a blocklisted
 * device all silently fall back to SwiftShader while every flag looks
 * right. Renders then take ten times as long for no visible reason.
 */

export type GpuMode = "gpu" | "software";

export function chromiumGpuArgs(mode: GpuMode, platform: NodeJS.Platform = process.platform): string[] {
  if (mode === "software") {
    return ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  }

  const common = [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-zero-copy",
    // Headless Chromium disables GPU compositing by default; without this
    // the GPU process starts and then is not used for canvas work.
    "--enable-gpu-rasterization",
  ];

  if (platform === "darwin") return ["--use-gl=angle", "--use-angle=metal", ...common];
  if (platform === "linux") {
    return [
      "--use-gl=angle",
      "--use-angle=vulkan",
      ...common,
      // Containers routinely lack /dev/shm space; Chromium crashes with a
      // bare "Target closed" that looks like a bug in the page.
      "--disable-dev-shm-usage",
    ];
  }
  return common;
}

/** True when the WebGL renderer string indicates software rasterisation. */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|software|microsoft basic/i.test(renderer);
}

export interface RendererInfo {
  renderer: string;
  software: boolean;
}

/**
 * Reads the active WebGL renderer out of a page. Pass the result to
 * `isSoftwareRenderer` to decide whether the GPU request actually landed.
 */
export const RENDERER_PROBE = `(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return "NO_WEBGL";
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
})()`;
