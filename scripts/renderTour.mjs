/**
 * Renders a route's 3D tour to an MP4, server-side, on the GPU.
 *
 * Usage:
 *   node scripts/renderTour.mjs --olat 37.76 --olng -122.51 \
 *        --dlat 37.7955 --dlng -122.3937 [--profile safest] \
 *        [--frames 120] [--fps 30] [--width 1280] [--height 720] \
 *        [--software] [--out tour.mp4]
 *
 * Requires the dev/prod server to be running (default http://localhost:3000).
 *
 * WHY SEEK RATHER THAN RECORD. The obvious approach - play the tour and
 * capture video - makes output depend on how fast the machine renders:
 * frames drop under load, and two runs of the same route differ. This
 * drives `window.__tourSeek(t)` on the dedicated /render/tour page, which
 * resolves only once MapLibre reports idle, so every frame is fully
 * painted with all tiles loaded and the result is byte-for-byte
 * reproducible regardless of machine speed.
 *
 * GPU: headless Chromium defaults to SwiftShader (software). On this
 * hardware that is several times slower per frame than ANGLE/Metal. The
 * script asks for the GPU, then *verifies* it got one, because a
 * misconfigured host falls back silently - see lib/tour/gpu.ts.
 */
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const required = ["olat", "olng", "dlat", "dlng"];
  for (const r of required) {
    if (args[r] === undefined) {
      process.stderr.write(`Missing --${r}\n`);
      process.exit(1);
    }
  }

  const baseUrl = args.base ?? "http://localhost:3000";
  const profile = args.profile ?? "safest";
  const frames = Number(args.frames ?? 120);
  const fps = Number(args.fps ?? 30);
  const width = Number(args.width ?? 1280);
  const height = Number(args.height ?? 720);
  const software = Boolean(args.software);
  const outPath = path.resolve(args.out ?? `tour-${profile}.mp4`);

  const { chromiumGpuArgs, isSoftwareRenderer, RENDERER_PROBE } = await import(
    "../lib/tour/gpu.ts"
  ).catch(async () => {
    // gpu.ts is TypeScript; when run through plain node, fall back to the
    // same flags inline rather than requiring a build step for a script.
    return {
      chromiumGpuArgs: (mode) =>
        mode === "software"
          ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
          : process.platform === "darwin"
            ? ["--use-gl=angle", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
            : ["--use-gl=angle", "--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-dev-shm-usage"],
      isSoftwareRenderer: (r) => /swiftshader|llvmpipe|software/i.test(r),
      RENDERER_PROBE: `(() => { const c=document.createElement("canvas");
        const gl=c.getContext("webgl2")||c.getContext("webgl"); if(!gl) return "NO_WEBGL";
        const d=gl.getExtension("WEBGL_debug_renderer_info");
        return d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER); })()`,
    };
  });

  const launchArgs = chromiumGpuArgs(software ? "software" : "gpu");
  process.stdout.write(`Launching Chromium (${software ? "software" : "gpu"})\n`);
  const browser = await chromium.launch({ args: launchArgs });
  const page = await browser.newPage({ viewport: { width, height } });

  const renderer = await page.evaluate(RENDERER_PROBE);
  const usingSoftware = isSoftwareRenderer(String(renderer));
  process.stdout.write(`  renderer: ${renderer}\n`);
  if (!software && usingSoftware) {
    // Loud, because the usual symptom is "why is this ten times slower
    // than it was on my laptop" with nothing in the logs.
    process.stdout.write(
      `  WARNING: asked for the GPU but got a software rasteriser.\n` +
        `  Renders will be far slower. Check GPU drivers / container flags.\n`
    );
  }

  const url =
    `${baseUrl}/render/tour?olat=${args.olat}&olng=${args.olng}` +
    `&dlat=${args.dlat}&dlng=${args.dlng}&profile=${encodeURIComponent(profile)}`;
  page.on("console", (m) => {
    if (m.type() === "error") process.stdout.write(`  [page] ${m.text().slice(0, 160)}\n`);
  });
  page.on("pageerror", (e) => process.stdout.write(`  [pageerror] ${e.message.slice(0, 160)}\n`));
  process.stdout.write(`Opening ${url}\n`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // NB the third argument is options; passing {timeout} second makes it the
  // page-function *argument* and silently leaves the default 30s in force.
  // Routing plus first tile load legitimately exceeds that on a cold engine.
  await page.waitForFunction(
    () => window.__tourReady === true || Boolean(window.__tourError),
    null,
    { timeout: 180_000 }
  );
  const err = await page.evaluate(() => window.__tourError);
  const status = await page
    .locator('[data-testid="render-status"]')
    .textContent()
    .catch(() => "?");
  process.stdout.write(`  page status: ${status}\n`);
  const ready = await page.evaluate(() => window.__tourReady === true);
  if (!ready) {
    process.stderr.write(`Render page failed: ${err}\n`);
    await browser.close();
    process.exit(1);
  }

  const frameDir = mkdtempSync(path.join(tmpdir(), "tour-frames-"));
  process.stdout.write(`Capturing ${frames} frames at ${width}x${height}\n`);
  const started = Date.now();

  for (let i = 0; i < frames; i++) {
    const t = frames === 1 ? 0 : i / (frames - 1);
    await page.evaluate((tt) => window.__tourSeek(tt), t);
    await page.screenshot({
      path: path.join(frameDir, `f${String(i).padStart(5, "0")}.png`),
      animations: "disabled",
    });
    if ((i + 1) % 20 === 0 || i === frames - 1) {
      const el = (Date.now() - started) / 1000;
      process.stdout.write(
        `  ${i + 1}/${frames}  ${el.toFixed(1)}s  (${((i + 1) / el).toFixed(2)} fps)\n`
      );
    }
  }
  const captureSeconds = (Date.now() - started) / 1000;
  await browser.close();

  // Encode. Playwright's bundled ffmpeg avoids a system dependency.
  const ff = resolveFfmpeg();
  if (!ff) {
    process.stdout.write(
      `\nRendered ${frames} frames to ${frameDir}\n` +
        `  ${frames} frames in ${captureSeconds.toFixed(1)}s ` +
        `(${(frames / captureSeconds).toFixed(2)} fps capture)\n` +
        `  renderer: ${renderer}${usingSoftware ? " [SOFTWARE]" : " [GPU]"}\n\n` +
        `No H.264-capable ffmpeg found, so no video was encoded. The frames\n` +
        `above are complete and usable. To get an MP4, install ffmpeg\n` +
        `(brew install ffmpeg / apt install ffmpeg) and re-run, or encode\n` +
        `them directly:\n` +
        `  ffmpeg -framerate ${fps} -i ${path.join(frameDir, "f%05d.png")} \\\n` +
        `    -c:v libx264 -pix_fmt yuv420p ${outPath}\n`
    );
    return;
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  process.stdout.write(`Encoding with ${ff}\n`);
  await run(ff, [
    "-y",
    "-framerate", String(fps),
    "-i", path.join(frameDir, "f%05d.png"),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    // Even dimensions are required by yuv420p; odd viewports otherwise
    // fail with a cryptic "width not divisible by 2".
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-crf", "20",
    outPath,
  ]);
  rmSync(frameDir, { recursive: true, force: true });

  process.stdout.write(
    `\nWrote ${outPath}\n` +
      `  ${frames} frames in ${captureSeconds.toFixed(1)}s ` +
      `(${(frames / captureSeconds).toFixed(2)} fps capture)\n` +
      `  renderer: ${renderer}${usingSoftware ? " [SOFTWARE]" : " [GPU]"}\n`
  );
}

/**
 * Finds an ffmpeg that can actually do the job.
 *
 * Deliberately does NOT fall back to the copy Playwright bundles. That
 * build is configured `--disable-everything` with only VP8/WebM and a PNG
 * *encoder* - it has no H.264 and no PNG *decoder*, so feeding it our
 * frames fails with a wall of config output and "Error opening input
 * file", which reads like a missing-file bug rather than a missing codec.
 * Checking capability up front turns that into one clear sentence.
 */
function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    "/snap/bin/ffmpeg",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c) && hasH264(c)) return c;
  }
  return null;
}

function hasH264(bin) {
  try {
    const out = execFileSync(bin, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /libx264|h264/.test(out);
  } catch {
    return false;
  }
}

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-1200)}`))
    );
  });
}

main().catch((e) => {
  process.stderr.write(`\nFailed: ${e.message}\n`);
  process.exit(1);
});
