import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 这台电脑既是“视频硬盘”，也是局域网服务器。这个文件负责全部本地 API。
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SERVER_DIR, "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const SUBTITLE_CACHE_DIR = path.join(CACHE_DIR, "subtitles");
const FONT_CACHE_DIR = path.join(CACHE_DIR, "fonts");
const THUMBNAIL_CACHE_DIR = path.join(CACHE_DIR, "thumbnails");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const WEB_DIR = path.join(PROJECT_DIR, "dist");
const PORT = Number(process.env.LVD_PORT || process.env.LANTERN_PORT || 8096);
const AUTO_SCAN_MIN_INTERVAL_SECONDS = 15;
const AUTO_SCAN_MAX_INTERVAL_SECONDS = 3600;
const AUTO_SCAN_SCHEDULER_TICK_MS = 5000;
const STARTUP_DIRECTORY = process.env.LVD_STARTUP_DIR || path.join(process.env.APPDATA || PROJECT_DIR, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const AUTOSTART_FILE = path.join(STARTUP_DIRECTORY, "LVD-开机自启.vbs");
const TRAY_LAUNCHER = path.join(PROJECT_DIR, "启动LVD.vbs");
const trackedChildProcesses = new Set();

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".mov", ".m4v", ".webm", ".avi", ".ts", ".m2ts", ".mts", ".mpg", ".mpeg", ".flv",
]);
const SUBTITLE_EXTENSIONS = new Set([".ass", ".ssa", ".srt"]);
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);
const EMBEDDED_SUBTITLE_CODECS = new Map([
  ["ass", { extension: ".ass", format: "ASS" }],
  ["ssa", { extension: ".ssa", format: "SSA" }],
  ["subrip", { extension: ".srt", format: "SRT" }],
]);
const MP4_FAMILY_EXTENSIONS = new Set(["MP4", "M4V", "MOV"]);
const WEBM_VIDEO_CODECS = new Set(["vp8", "vp9", "av1"]);
const WEBM_AUDIO_CODECS = new Set(["opus", "vorbis"]);
const MP4_COPYABLE_VIDEO_CODECS = new Set(["h264", "hevc", "av1", "mpeg4"]);
const MP4_BROWSER_AUDIO_CODECS = new Set(["aac", "mp3"]);
const COMPATIBLE_COPY_VERSION = 2;

await mkdir(DATA_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });
await mkdir(SUBTITLE_CACHE_DIR, { recursive: true });
await mkdir(FONT_CACHE_DIR, { recursive: true });
await mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });

function defaultState() {
  return {
    version: 4,
    libraries: [],
    media: [],
    jobs: [],
    displayGroups: [],
    settings: {
      cacheDirectory: CACHE_DIR,
      maxStreams: 10,
      autoPrepareCompatibleCopies: true,
      autoScanEnabled: true,
      autoScanIntervalSeconds: 30,
    },
  };
}

async function loadState() {
  try {
    const defaults = defaultState();
    const stored = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return {
      version: 4,
      libraries: Array.isArray(stored.libraries) ? stored.libraries : defaults.libraries,
      media: Array.isArray(stored.media) ? stored.media : defaults.media,
      jobs: Array.isArray(stored.jobs) ? stored.jobs : defaults.jobs,
      displayGroups: Array.isArray(stored.displayGroups) ? stored.displayGroups : defaults.displayGroups,
      settings: { ...defaults.settings, ...(stored.settings || {}), cacheDirectory: CACHE_DIR, maxStreams: 10 },
    };
  } catch {
    return defaultState();
  }
}

let appState = await loadState();
let pendingStateSave = Promise.resolve();

// A queued/running FFmpeg process cannot survive a server restart. Mark old
// records clearly instead of leaving the management page stuck at “processing”.
for (const job of appState.jobs) {
  if (job.status === "queued" || job.status === "running") {
    job.status = "failed";
    job.message = "服务曾重启，请重新加入处理队列";
  }
}

function saveState() {
  const temporaryFile = `${STATE_FILE}.tmp`;
  const snapshot = JSON.stringify(appState, null, 2);
  pendingStateSave = pendingStateSave.catch(() => {}).then(async () => {
    await writeFile(temporaryFile, snapshot, "utf8");
    await rename(temporaryFile, STATE_FILE);
  });
  return pendingStateSave;
}

// 版本 4 继续保持无账号模式，并增加只影响网页显示的作品分组配置。
await saveState();

function stableId(value) {
  return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 20);
}

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requireLocalManagement(request, response) {
  if (isLoopbackRequest(request)) return true;
  sendJson(response, 403, { error: "管理端只能在服务器电脑本机操作。", code: "LOCAL_ADMIN_ONLY" });
  return false;
}

function sameOriginMutation(request) {
  if (!["POST", "PATCH", "DELETE"].includes(request.method || "")) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function getLanAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254.")) addresses.push(`http://${item.address}:${PORT}`);
    }
  }
  return [...new Set(addresses)];
}

async function getAutostartStatus() {
  return { enabled: await access(AUTOSTART_FILE).then(() => true).catch(() => false), path: AUTOSTART_FILE };
}

function quoteForVbs(value) {
  return String(value).replaceAll('"', '""');
}

function spawnTracked(executable, args, options = {}) {
  const child = spawn(executable, args, options);
  trackedChildProcesses.add(child);
  const forgetChild = () => trackedChildProcesses.delete(child);
  child.once("close", forgetChild);
  child.once("error", forgetChild);
  return child;
}

async function setAutostart(enabled) {
  if (!enabled) {
    await unlink(AUTOSTART_FILE).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return getAutostartStatus();
  }
  await mkdir(STARTUP_DIRECTORY, { recursive: true });
  const launchCommand = `wscript.exe "${TRAY_LAUNCHER}" /autostart`;
  const script = [
    "Set lvdShell = CreateObject(\"WScript.Shell\")",
    `lvdShell.Run "${quoteForVbs(launchCommand)}", 0, False`,
    "Set lvdShell = Nothing",
    "",
  ].join("\r\n");
  await writeFile(AUTOSTART_FILE, script, "utf8");
  return getAutostartStatus();
}

let activeFolderPicker = null;

function selectFolderWithWindowsDialog() {
  if (process.platform !== "win32") return Promise.reject(new Error("文件夹选择器只支持 Windows。"));
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '选择包含视频的文件夹'",
    "$dialog.ShowNewFolderButton = $false",
    "$dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) }",
    "$dialog.Dispose()",
  ].join("\r\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const picker = spawnTracked("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", encodedScript], { windowsHide: true });
    let output = "";
    let errors = "";
    picker.stdout.setEncoding("utf8");
    picker.stderr.setEncoding("utf8");
    picker.stdout.on("data", (chunk) => { output += chunk; });
    picker.stderr.on("data", (chunk) => { errors += chunk; });
    picker.on("error", reject);
    picker.on("close", (code) => {
      if (code !== 0) return reject(new Error(errors.trim() || "无法打开 Windows 文件夹选择器。"));
      resolve(output.replace(/^\uFEFF/, "").trim() || null);
    });
  });
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function runCommand(executable, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(executable, args, { windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(executable)} 运行超时`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${path.basename(executable)} 退出码 ${code}`));
    });
  });
}

async function findMediaTools() {
  const localBin = path.join(PROJECT_DIR, "tools", "ffmpeg", "bin");
  const candidates = process.platform === "win32"
    ? [
        { ffmpeg: path.join(localBin, "ffmpeg.exe"), ffprobe: path.join(localBin, "ffprobe.exe") },
        { ffmpeg: "ffmpeg.exe", ffprobe: "ffprobe.exe" },
      ]
    : [
        { ffmpeg: path.join(localBin, "ffmpeg"), ffprobe: path.join(localBin, "ffprobe") },
        { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      ];

  for (const candidate of candidates) {
    try {
      const result = await runCommand(candidate.ffmpeg, ["-version"], 5000);
      return {
        available: true,
        ffmpeg: candidate.ffmpeg,
        ffprobe: candidate.ffprobe,
        version: result.stdout.split(/\r?\n/)[0],
      };
    } catch {
      // 继续检查下一个位置。
    }
  }
  return {
    available: false,
    ffmpeg: null,
    ffprobe: null,
    version: null,
    hint: "把 ffmpeg.exe 与 ffprobe.exe 放入 tools/ffmpeg/bin 后即可启用无损重封装和 AAC 转换。",
  };
}

let mediaTools = await findMediaTools();

async function walkDirectory(rootDirectory, depth = 0, output = []) {
  if (depth > 10 || output.length >= 10000) return output;
  let entries;
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) await walkDirectory(fullPath, depth + 1, output);
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(fullPath);
    if (output.length >= 10000) break;
  }
  return output;
}

async function findSidecarFiles(videoPath) {
  const directory = path.dirname(videoPath);
  const videoStem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { subtitles: [], fonts: [] };
  }

  const subtitles = [];
  const fonts = [];
  const siblingVideos = entries.filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  const videoEpisode = detectedEpisodeNumber(videoPath);
  const videosWithSameEpisode = videoEpisode === null
    ? 0
    : siblingVideos.filter((entry) => detectedEpisodeNumber(entry.name) === videoEpisode).length;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const fullPath = path.join(directory, entry.name);
    const stem = path.basename(entry.name, extension).toLowerCase();
    const subtitleMatchesStem = stem === videoStem || stem.startsWith(`${videoStem}.`);
    const subtitleEpisode = SUBTITLE_EXTENSIONS.has(extension) ? detectedEpisodeNumber(entry.name) : null;
    const subtitleMatchesEpisode = siblingVideos.length === 1
      || (videoEpisode !== null && videosWithSameEpisode === 1 && subtitleEpisode === videoEpisode);
    if (SUBTITLE_EXTENSIONS.has(extension) && (subtitleMatchesStem || subtitleMatchesEpisode)) {
      const fileStat = await stat(fullPath).catch(() => null);
      if (!fileStat?.isFile()) continue;
      subtitles.push({
        id: stableId(fullPath),
        name: entry.name,
        format: extension.slice(1).toUpperCase(),
        path: fullPath,
        language: inferSubtitleLanguage(entry.name),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      });
    }
    if (FONT_EXTENSIONS.has(extension)) {
      const fileStat = await stat(fullPath).catch(() => null);
      if (fileStat?.isFile()) fonts.push({ id: stableId(fullPath), name: entry.name, path: fullPath, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString() });
    }
  }
  subtitles.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  fonts.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  return { subtitles, fonts };
}

function inferSubtitleLanguage(fileName) {
  const name = fileName.toLowerCase();
  if (/zh[-_.]?(cn|hans)|chs|简|(^|[._-])(chi|zho)([._-]|$)/.test(name)) return "简体中文";
  if (/zh[-_.]?(tw|hant)|cht|繁/.test(name)) return "繁体中文";
  if (/(^|[._-])en(g)?([._-]|$)/.test(name)) return "English";
  if (/(^|[._-])(ja|jpn)([._-]|$)/.test(name)) return "日本語";
  return "未标记";
}

function parseBitDepth(pixelFormat = "") {
  const match = pixelFormat.match(/p(\d{2})(?:le|be)?$/i);
  return match ? Number(match[1]) : 8;
}

async function probeVideo(filePath) {
  if (!mediaTools.available) return {};
  try {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration,format_name:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,color_space,color_transfer,color_primaries:stream_tags=language,title,filename,mimetype",
      "-of", "json",
      filePath,
    ];
    const result = await runCommand(mediaTools.ffprobe, args, 20000);
    const data = JSON.parse(result.stdout);
    const video = data.streams?.find((stream) => stream.codec_type === "video");
    const audio = data.streams?.find((stream) => stream.codec_type === "audio");
    const embeddedSubtitleStreams = (data.streams || []).filter((stream) => stream.codec_type === "subtitle" && EMBEDDED_SUBTITLE_CODECS.has(stream.codec_name)).map((stream) => ({
      index: stream.index,
      codec: stream.codec_name,
      format: EMBEDDED_SUBTITLE_CODECS.get(stream.codec_name).format,
      extension: EMBEDDED_SUBTITLE_CODECS.get(stream.codec_name).extension,
      language: stream.tags?.language || "",
      title: stream.tags?.title || "",
    }));
    const embeddedFontStreams = (data.streams || []).filter((stream) => stream.codec_type === "attachment").map((stream) => ({
      index: stream.index,
      fileName: stream.tags?.filename || `font-${stream.index}`,
      mimeType: stream.tags?.mimetype || "",
    })).filter((stream) => FONT_EXTENSIONS.has(path.extname(stream.fileName).toLowerCase()));
    const transfer = video?.color_transfer || "";
    return {
      durationSeconds: Math.round(Number(data.format?.duration || 0)),
      container: data.format?.format_name?.split(",")[0] || path.extname(filePath).slice(1),
      width: video?.width || null,
      height: video?.height || null,
      videoCodec: video?.codec_name || null,
      videoProfile: video?.profile || null,
      audioCodec: audio?.codec_name || null,
      pixelFormat: video?.pix_fmt || null,
      bitDepth: parseBitDepth(video?.pix_fmt),
      hdr: transfer === "smpte2084" ? "HDR10" : transfer === "arib-std-b67" ? "HLG" : null,
      colorPrimaries: video?.color_primaries || null,
      embeddedSubtitleStreams,
      embeddedFontStreams,
    };
  } catch (error) {
    return { probeError: error.message };
  }
}

async function extractEmbeddedAssets(filePath, mediaId, probe, sidecars) {
  if (!mediaTools.available) return sidecars;
  const subtitles = [...sidecars.subtitles];
  const fonts = [...sidecars.fonts];

  for (const stream of probe.embeddedSubtitleStreams || []) {
    const outputPath = path.join(SUBTITLE_CACHE_DIR, `${mediaId}-${stream.index}${stream.extension}`);
    try {
      await runCommand(mediaTools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", filePath, "-map", `0:${stream.index}`, "-c:s", "copy", outputPath], 30000);
      subtitles.push({
        id: `embedded-subtitle-${mediaId}-${stream.index}`,
        name: stream.title || `内嵌字幕 ${stream.index}`,
        format: stream.format,
        path: outputPath,
        language: inferSubtitleLanguage(`${stream.language}.${stream.title}`),
        source: "embedded",
        streamIndex: stream.index,
      });
    } catch (error) {
      console.error(`无法提取内嵌字幕 ${filePath}#${stream.index}: ${error.message}`);
    }
  }

  for (const stream of probe.embeddedFontStreams || []) {
    const safeName = path.basename(stream.fileName).replace(/[^\p{L}\p{N}._ -]/gu, "_");
    const outputPath = path.join(FONT_CACHE_DIR, `${mediaId}-${stream.index}-${safeName}`);
    try {
      await runCommand(mediaTools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", `-dump_attachment:${stream.index}`, outputPath, "-i", filePath, "-f", "null", "-"], 30000);
      fonts.push({ id: `embedded-font-${mediaId}-${stream.index}`, name: safeName, path: outputPath, source: "embedded", streamIndex: stream.index });
    } catch (error) {
      console.error(`无法提取内嵌字体 ${filePath}#${stream.index}: ${error.message}`);
    }
  }
  return { subtitles, fonts };
}

// Generate one real preview frame per video. The JPG lives in data/cache, so
// original videos are never modified and later scans can reuse the same image.
async function ensureVideoThumbnail(filePath, mediaId, durationSeconds = 0, existingPath = null) {
  const outputPath = existingPath || path.join(THUMBNAIL_CACHE_DIR, `${mediaId}.jpg`);
  const existingFile = await stat(outputPath).catch(() => null);
  if (existingFile?.isFile() && existingFile.size > 0) return outputPath;
  if (!mediaTools.available) return null;

  const seekSeconds = durationSeconds > 60
    ? Math.min(durationSeconds * 0.12, 300)
    : Math.min(Math.max(durationSeconds * 0.2, 0), 10);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", seekSeconds.toFixed(3), "-i", filePath,
    "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
    "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
    "-q:v", "3", outputPath,
  ];
  try {
    await runCommand(mediaTools.ffmpeg, args, 60000);
    const thumbnailStat = await stat(outputPath).catch(() => null);
    return thumbnailStat?.size ? outputPath : null;
  } catch (error) {
    console.error(`无法生成视频缩略图 ${filePath}: ${error.message}`);
    return null;
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

let activeScan = null;
let lastScanStartedAt = null;
let lastScanCompletedAt = null;
let lastScanError = null;

function normalizedAutoScanIntervalSeconds(value = appState.settings.autoScanIntervalSeconds) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 30;
  return Math.min(AUTO_SCAN_MAX_INTERVAL_SECONDS, Math.max(AUTO_SCAN_MIN_INTERVAL_SECONDS, Math.round(seconds)));
}

function catalogScanStatus() {
  return {
    enabled: Boolean(appState.settings.autoScanEnabled),
    scanning: Boolean(activeScan),
    intervalSeconds: normalizedAutoScanIntervalSeconds(),
    lastStartedAt: lastScanStartedAt,
    lastCompletedAt: lastScanCompletedAt,
    lastError: lastScanError,
  };
}

async function scanLibraries() {
  if (activeScan) return activeScan;
  lastScanStartedAt = new Date().toISOString();
  lastScanError = null;
  activeScan = (async () => {
    const files = [];
    for (const library of appState.libraries) {
      const found = await walkDirectory(library.path);
      for (const filePath of found) files.push({ filePath, libraryId: library.id });
    }

    const oldMedia = new Map(appState.media.map((item) => [item.id, item]));
    const scanned = await mapWithConcurrency(files, 3, async ({ filePath, libraryId }) => {
      const fileStat = await stat(filePath);
      const id = stableId(filePath);
      const existing = oldMedia.get(id);
      const unchanged = existing && existing.size === fileStat.size && existing.modifiedAt === fileStat.mtime.toISOString();
      if (unchanged) {
        const sidecars = await findSidecarFiles(filePath);
        const embeddedSubtitles = (existing.subtitles || []).filter((item) => item.source === "embedded");
        const embeddedFonts = (existing.fonts || []).filter((item) => item.source === "embedded");
        const thumbnailPath = await ensureVideoThumbnail(filePath, id, existing.durationSeconds, existing.thumbnailPath);
        return {
          ...existing,
          thumbnailPath,
          subtitles: [...sidecars.subtitles, ...embeddedSubtitles],
          fonts: [...sidecars.fonts, ...embeddedFonts],
        };
      }
      const probe = await probeVideo(filePath);
      const sidecars = await extractEmbeddedAssets(filePath, id, probe, await findSidecarFiles(filePath));
      const thumbnailPath = await ensureVideoThumbnail(filePath, id, probe.durationSeconds);
      return {
        id,
        libraryId,
        title: path.basename(filePath, path.extname(filePath)),
        fileName: path.basename(filePath),
        path: filePath,
        extension: path.extname(filePath).slice(1).toUpperCase(),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        tags: existing?.tags || [],
        posterHue: Number.parseInt(id.slice(0, 4), 16) % 360,
        remuxPath: existing?.remuxPath || null,
        thumbnailPath,
        subtitles: sidecars.subtitles,
        fonts: sidecars.fonts,
        ...probe,
      };
    });

    appState.media = scanned;
    await saveState();
    await queueAutomaticCompatibleCopies();
    lastScanCompletedAt = new Date().toISOString();
    return scanned;
  })();

  try {
    return await activeScan;
  } catch (error) {
    lastScanError = error.message || "扫描失败";
    throw error;
  } finally {
    activeScan = null;
  }
}

async function updateCatalogScanSettings(body) {
  if (typeof body.enabled !== "boolean") throw new Error("自动扫描开关参数无效。");
  appState.settings.autoScanEnabled = body.enabled;
  appState.settings.autoScanIntervalSeconds = normalizedAutoScanIntervalSeconds(body.intervalSeconds);
  await saveState();
  if (body.enabled && appState.libraries.length && !activeScan) {
    queueMicrotask(() => scanLibraries().catch((error) => console.error(`观看端自动扫描失败：${error.message}`)));
  }
  return catalogScanStatus();
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ass": "text/x-ssa; charset=utf-8",
    ".ssa": "text/x-ssa; charset=utf-8",
    ".srt": "application/x-subrip; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".ttc": "font/collection",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }[extension] || "application/octet-stream";
}

const activeVideoTransfers = new Set();

async function streamFile(request, response, filePath, trackPlayback = false) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return sendJson(response, 404, { error: "文件不存在，可能已被移动。" });
  }

  if (trackPlayback && request.method !== "HEAD") {
    if (activeVideoTransfers.size >= appState.settings.maxStreams) return sendJson(response, 503, { error: "当前已有 10 路视频正在传输，请稍后重试。", code: "STREAM_LIMIT" });
    const transferId = randomUUID();
    activeVideoTransfers.add(transferId);
    const release = () => activeVideoTransfers.delete(transferId);
    response.once("finish", release);
    response.once("close", release);
  }

  const commonHeaders = {
    "Content-Type": contentTypeFor(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Last-Modified": fileStat.mtime.toUTCString(),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
  };
  const rangeHeader = request.headers.range;
  if (!rangeHeader) {
    response.writeHead(200, { ...commonHeaders, "Content-Length": fileStat.size });
    if (request.method === "HEAD") return response.end();
    return createReadStream(filePath).pipe(response);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
    return response.end();
  }
  let start;
  let end;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    start = Math.max(fileStat.size - suffixLength, 0);
    end = fileStat.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? fileStat.size - 1 : Math.min(Number(match[2]), fileStat.size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= fileStat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
    return response.end();
  }
  response.writeHead(206, {
    ...commonHeaders,
    "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
    "Content-Length": end - start + 1,
  });
  if (request.method === "HEAD") return response.end();
  createReadStream(filePath, { start, end }).pipe(response);
}

function normalizeTextSubtitle(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString("utf8");
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const replacementRatio = (utf8.match(/�/g)?.length || 0) / Math.max(utf8.length, 1);
  if (replacementRatio < 0.002) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
  }
}

// Browsers only accept WebVTT in a native <track>. SRT and WebVTT contain the
// same basic cue information, so we change only the timestamp punctuation and
// add the WebVTT header. SRT has no ASS-style font or animation data to lose.
function srtToWebVtt(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  return `WEBVTT\n\n${normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

function mediaCompatibility(media) {
  const extension = String(media.extension || "").toUpperCase();
  const videoCodec = String(media.videoCodec || "").toLowerCase();
  const audioCodec = String(media.audioCodec || "").toLowerCase();
  const audioIsAbsent = !audioCodec;
  const mp4Family = MP4_FAMILY_EXTENSIONS.has(extension);
  const webmDirect = extension === "WEBM"
    && WEBM_VIDEO_CODECS.has(videoCodec)
    && (audioIsAbsent || WEBM_AUDIO_CODECS.has(audioCodec));
  const safeMp4Direct = mp4Family
    && videoCodec === "h264"
    && (audioIsAbsent || MP4_BROWSER_AUDIO_CODECS.has(audioCodec));
  const needsContainerChange = !mp4Family && !webmDirect;
  const needsAudioChange = !webmDirect && !audioIsAbsent && !MP4_BROWSER_AUDIO_CODECS.has(audioCodec);
  const canRemuxToMp4 = MP4_COPYABLE_VIDEO_CODECS.has(videoCodec);
  const needsCompatibleCopy = canRemuxToMp4 && (needsContainerChange || needsAudioChange);
  const issues = [];
  if (needsContainerChange) issues.push(`${extension || "未知"} 容器`);
  if (needsAudioChange) issues.push(`${audioCodec.toUpperCase()} 音频`);
  if (!["h264", "vp8", "vp9"].includes(videoCodec)) issues.push(`${videoCodec.toUpperCase() || "未知"} 视频解码`);
  return {
    directPlayLikely: safeMp4Direct || webmDirect,
    needsCompatibleCopy,
    canRemuxToMp4,
    issues,
    deviceCodecDependent: ["hevc", "av1"].includes(videoCodec),
  };
}

const remuxQueue = [];
let activeRemuxJobs = 0;
const MAX_ACTIVE_REMUX_JOBS = 1;

async function runRemuxJob({ job, media, convertAudioToAac }) {
  if (!mediaTools.available) {
    job.status = "failed";
    job.message = mediaTools.hint;
    await saveState();
    return;
  }

  const outputPath = path.join(CACHE_DIR, `${media.id}.mp4`);
  const temporaryOutputPath = path.join(CACHE_DIR, `${media.id}.partial.mp4`);
  await unlink(temporaryOutputPath).catch((error) => { if (error.code !== "ENOENT") throw error; });

  // A browser-compatible copy must expose one deterministic audio track. Mapping
  // every source track can leave multiple tracks marked as default; some browser
  // and TV decoders then mix or switch between different masters, which sounds
  // like a large echo and can appear out of sync with the picture.
  const args = [
    "-hide_banner", "-y", "-i", media.path,
    "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0", "-map_chapters", "0",
    "-sn", "-dn", "-c:v", "copy",
  ];
  if (String(media.videoCodec || "").toLowerCase() === "hevc") args.push("-tag:v", "hvc1");
  if (media.audioCodec) {
    if (convertAudioToAac) {
      args.push(
        "-c:a", "aac", "-b:a", "256k", "-ac:a", "2",
        "-af:a", "aresample=async=1:first_pts=0",
      );
    } else {
      args.push("-c:a", "copy");
    }
    args.push("-disposition:a:0", "default");
  }
  args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", temporaryOutputPath);

  job.status = "running";
  job.message = "正在复制视频码流";
  await saveState();

  await new Promise((resolve) => {
    const child = spawnTracked(mediaTools.ffmpeg, args, { windowsHide: true });
    let progressBuffer = "";
    let errorBuffer = "";
    let spawnError = null;
    child.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const [key, value] = line.split("=");
        if ((key === "out_time_ms" || key === "out_time_us") && media.durationSeconds) {
          job.progress = Math.max(0, Math.min(99, Math.round(Number(value) / 1_000_000 / media.durationSeconds * 100)));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      errorBuffer = `${errorBuffer}${chunk.toString("utf8")}`.slice(-12000);
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", async (code) => {
      try {
        if (code !== 0) throw new Error(spawnError?.message || errorBuffer.split(/\r?\n/).filter(Boolean).slice(-2).join(" · ") || `FFmpeg 退出码 ${code}`);
        const outputStat = await stat(temporaryOutputPath);
        if (!outputStat.isFile() || outputStat.size === 0) throw new Error("FFmpeg 没有生成有效的兼容副本");
        await rename(temporaryOutputPath, outputPath);
        job.status = "completed";
        job.progress = 100;
        job.message = "兼容副本已就绪（单音轨立体声 AAC，音画同步已校正）";
        job.completedAt = new Date().toISOString();
        media.remuxPath = outputPath;
        media.remuxVersion = COMPATIBLE_COPY_VERSION;
      } catch (error) {
        job.status = "failed";
        job.message = error.message || "兼容副本生成失败";
        await unlink(temporaryOutputPath).catch(() => {});
      }
      await saveState();
      resolve();
    });
  });
}

function drainRemuxQueue() {
  if (activeRemuxJobs >= MAX_ACTIVE_REMUX_JOBS) return;
  const task = remuxQueue.shift();
  if (!task) return;
  activeRemuxJobs += 1;
  runRemuxJob(task).catch(async (error) => {
    task.job.status = "failed";
    task.job.message = error.message || "处理失败";
    await saveState().catch(() => {});
  }).finally(() => {
    activeRemuxJobs -= 1;
    queueMicrotask(drainRemuxQueue);
  });
}

function startRemuxJob(media, convertAudioToAac = true) {
  const existingJob = appState.jobs.find((job) => job.mediaId === media.id && (job.status === "queued" || job.status === "running"));
  if (existingJob) return existingJob;
  const job = {
    id: randomUUID(),
    mediaId: media.id,
    title: media.title,
    type: convertAudioToAac ? "无损重封装 + AAC" : "无损重封装",
    status: "queued",
    progress: 0,
    message: "等待开始",
    createdAt: new Date().toISOString(),
  };
  appState.jobs.unshift(job);
  appState.jobs = appState.jobs.slice(0, 50);
  saveState().catch(() => {});
  remuxQueue.push({ job, media, convertAudioToAac });
  queueMicrotask(drainRemuxQueue);
  return job;
}

async function queueAutomaticCompatibleCopies() {
  if (!appState.settings.autoPrepareCompatibleCopies || !mediaTools.available) return { queued: 0 };
  let queued = 0;
  let stateChanged = false;
  for (const media of appState.media) {
    if (!mediaCompatibility(media).needsCompatibleCopy) continue;
    if (media.remuxPath) {
      const remuxFile = await stat(media.remuxPath).catch(() => null);
      const remuxIsCurrent = remuxFile?.isFile() && remuxFile.size > 0 && media.remuxVersion === COMPATIBLE_COPY_VERSION;
      if (remuxIsCurrent) continue;
      if (!remuxFile?.isFile() || remuxFile.size === 0) {
        media.remuxPath = null;
        media.remuxVersion = null;
        stateChanged = true;
      }
    }
    const alreadyActive = appState.jobs.some((job) => job.mediaId === media.id && (job.status === "queued" || job.status === "running"));
    startRemuxJob(media, true);
    if (!alreadyActive) queued += 1;
  }
  if (stateChanged) await saveState();
  return { queued };
}

function folderPathForMedia(media) {
  return path.dirname(media.path);
}

function displayGroupForFolder(folderPath) {
  const normalized = path.resolve(folderPath).toLowerCase();
  return appState.displayGroups.find((group) => path.resolve(group.path).toLowerCase() === normalized) || null;
}

function inferSeasonNumber(folderPath, mediaItems) {
  for (const item of mediaItems) {
    const match = path.basename(item.fileName, path.extname(item.fileName)).match(/(?:^|[^a-z0-9])s(\d{1,2})e\d{1,4}(?:[^a-z0-9]|$)/i);
    if (match) return Number(match[1]);
  }
  const folderName = path.basename(folderPath);
  const latin = folderName.match(/(?:^|[^a-z0-9])(?:s|season)[ ._-]?(\d{1,2})(?:[^a-z0-9]|$)/i);
  if (latin) return Number(latin[1]);
  const chinese = folderName.match(/第\s*(\d{1,2})\s*季/);
  return chinese ? Number(chinese[1]) : 1;
}

function detectedEpisodeNumber(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const seasonEpisode = baseName.match(/(?:^|[^a-z0-9])s\d{1,2}e(\d{1,4})(?:[^a-z0-9]|$)/i);
  if (seasonEpisode) return Number(seasonEpisode[1]);
  const episodeLabel = baseName.match(/(?:^|[\s._\-[\(])(?:ep?|episode)[\s._-]?(\d{1,4})(?=$|[\s._\-\]\)])/i);
  if (episodeLabel) return Number(episodeLabel[1]);
  const chinese = baseName.match(/第\s*(\d{1,4})\s*[话話集]/);
  if (chinese) return Number(chinese[1]);
  const bracketed = [...baseName.matchAll(/[\[(](\d{1,3})(?:v\d+)?[\])]/gi)].map((match) => Number(match[1])).find((value) => value < 200);
  if (bracketed) return bracketed;
  const separated = baseName.match(/(?:^|[\s._-])(\d{1,3})(?:v\d+)?(?=$|[\s._-])/i);
  return separated ? Number(separated[1]) : null;
}

function sortedFolderMedia(folderPath) {
  const normalized = path.resolve(folderPath).toLowerCase();
  return appState.media
    .filter((item) => path.resolve(folderPathForMedia(item)).toLowerCase() === normalized)
    .sort((left, right) => left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" }));
}

function mediaDisplayInfo(media) {
  const folderPath = folderPathForMedia(media);
  const group = displayGroupForFolder(folderPath);
  const folderItems = sortedFolderMedia(folderPath);
  const season = Number(group?.season) || inferSeasonNumber(folderPath, folderItems);
  const detectedEpisode = detectedEpisodeNumber(media.fileName);
  const episode = detectedEpisode || folderItems.findIndex((item) => item.id === media.id) + 1;
  const seriesTitle = group?.title?.trim() || path.basename(folderPath);
  return {
    groupId: stableId(folderPath),
    seriesTitle,
    season,
    episode,
    alias: `${seriesTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    configured: Boolean(group?.title?.trim()),
  };
}

function displayFolderSummaries() {
  const folders = new Map();
  for (const media of appState.media) {
    const folderPath = folderPathForMedia(media);
    const key = path.resolve(folderPath).toLowerCase();
    if (!folders.has(key)) folders.set(key, folderPath);
  }
  return [...folders.values()].map((folderPath) => {
    const items = sortedFolderMedia(folderPath);
    const group = displayGroupForFolder(folderPath);
    const folderName = path.basename(folderPath);
    const season = Number(group?.season) || inferSeasonNumber(folderPath, items);
    const title = group?.title?.trim() || folderName;
    const firstDisplay = items[0] ? mediaDisplayInfo(items[0]) : null;
    return {
      id: stableId(folderPath),
      path: folderPath,
      folderName,
      title,
      customTitle: group?.title?.trim() || "",
      season,
      configured: Boolean(group?.title?.trim()),
      mediaCount: items.length,
      sampleAlias: firstDisplay?.alias || "",
    };
  }).sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
}

function publicMedia(item, includeLocalPath = false) {
  const compatibility = mediaCompatibility(item);
  const latestJob = appState.jobs.find((job) => job.mediaId === item.id);
  const activeJob = latestJob && (latestJob.status === "queued" || latestJob.status === "running") ? latestJob : null;
  const compatibleCopyStatus = activeJob?.status || (item.remuxPath
    ? "ready"
    : latestJob?.status || (compatibility.needsCompatibleCopy ? "waiting" : "not-needed"));
  return {
    ...item,
    path: includeLocalPath ? item.path : undefined,
    remuxPath: includeLocalPath ? item.remuxPath : undefined,
    thumbnailPath: includeLocalPath ? item.thumbnailPath : undefined,
    embeddedSubtitleStreams: undefined,
    embeddedFontStreams: undefined,
    streamUrl: `/api/media/${item.id}/stream`,
    remuxUrl: item.remuxPath ? `/api/media/${item.id}/stream?variant=remux` : null,
    thumbnailUrl: item.thumbnailPath ? `/api/media/${item.id}/thumbnail` : null,
    display: mediaDisplayInfo(item),
    compatibility,
    compatibleCopyStatus,
    compatibleCopyProgress: activeJob?.progress ?? (item.remuxPath ? 100 : latestJob?.progress || 0),
    subtitles: item.subtitles.map((subtitle) => ({ ...subtitle, path: undefined, url: `/api/media/${item.id}/subtitles/${subtitle.id}` })),
    fonts: item.fonts.map((font) => ({ ...font, path: undefined, url: `/api/media/${item.id}/fonts/${font.id}` })),
  };
}

async function serveStatic(response, pathname) {
  let requestedPath = pathname === "/" ? "/index.html" : pathname;
  let filePath = path.resolve(WEB_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(WEB_DIR)) return false;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;
  } catch {
    filePath = path.join(WEB_DIR, "index.html");
    try { await access(filePath); } catch { return false; }
  }
  const fileStat = await stat(filePath);
  response.writeHead(200, { "Content-Type": contentTypeFor(filePath), "Content-Length": fileStat.size });
  createReadStream(filePath).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return response.end();
  }

  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "已拒绝跨站操作。", code: "ORIGIN_REJECTED" });
    if (request.method === "POST" && pathname === "/api/service/stop") {
      if (!requireLocalManagement(request, response)) return;
      sendJson(response, 202, { ok: true, message: "共享服务正在关闭，系统托盘会继续运行。" });
      setTimeout(() => stopSharingService().catch((error) => console.error(`关闭共享服务失败：${error.message}`)), 30);
      return;
    }
    if (request.method === "GET" && pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, name: "LVD", sharingService: "running", port: PORT, lanAddresses: getLanAddresses(), tools: mediaTools });
    }
    if ((pathname === "/admin" || pathname.startsWith("/admin/")) && !requireLocalManagement(request, response)) return;
    if (request.method === "GET" && pathname === "/api/catalog") {
      return sendJson(response, 200, {
        media: appState.media.map((item) => publicMedia(item)),
        groups: displayFolderSummaries().map(({ path: _path, customTitle: _customTitle, sampleAlias: _sampleAlias, ...group }) => group),
        scan: catalogScanStatus(),
      });
    }
    if (request.method === "POST" && pathname === "/api/catalog/scan") {
      const media = await scanLibraries();
      return sendJson(response, 200, { count: media.length, scan: catalogScanStatus() });
    }
    if (request.method === "GET" && pathname === "/api/overview") {
      if (!requireLocalManagement(request, response)) return;
      return sendJson(response, 200, {
        libraries: appState.libraries,
        media: appState.media.map((item) => publicMedia(item, true)),
        displayFolders: displayFolderSummaries(),
        jobs: appState.jobs,
        settings: appState.settings,
        tools: mediaTools,
        scanning: Boolean(activeScan),
        activeVideoTransfers: activeVideoTransfers.size,
        lanAddresses: getLanAddresses(),
        autostart: await getAutostartStatus(),
      });
    }
    if (request.method === "POST" && pathname === "/api/tools/refresh") {
      if (!requireLocalManagement(request, response)) return;
      mediaTools = await findMediaTools();
      return sendJson(response, 200, mediaTools);
    }
    if (request.method === "POST" && pathname === "/api/folders/select") {
      if (!requireLocalManagement(request, response)) return;
      if (activeFolderPicker) return sendJson(response, 409, { error: "文件夹选择窗口已经打开，请先完成当前选择。" });
      activeFolderPicker = selectFolderWithWindowsDialog();
      let selectedPath;
      try { selectedPath = await activeFolderPicker; }
      finally { activeFolderPicker = null; }
      if (!selectedPath) return sendJson(response, 200, { cancelled: true, path: null });
      const folderStat = await stat(selectedPath).catch(() => null);
      if (!folderStat?.isDirectory()) return sendJson(response, 400, { error: "选择的文件夹已经不存在，或当前程序没有读取权限。" });
      return sendJson(response, 200, { cancelled: false, path: path.resolve(selectedPath) });
    }
    if (request.method === "POST" && pathname === "/api/autostart") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      return sendJson(response, 200, await setAutostart(Boolean(body.enabled)));
    }
    if (request.method === "POST" && pathname === "/api/libraries") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      if (!body.folderPath || !path.isAbsolute(body.folderPath)) return sendJson(response, 400, { error: "请输入完整的 Windows 文件夹路径。" });
      const folderPath = path.resolve(body.folderPath);
      const folderStat = await stat(folderPath).catch(() => null);
      if (!folderStat?.isDirectory()) return sendJson(response, 400, { error: "找不到这个文件夹，或当前程序没有读取权限。" });
      if (!appState.libraries.some((library) => library.path.toLowerCase() === folderPath.toLowerCase())) {
        appState.libraries.push({ id: stableId(folderPath), path: folderPath, name: body.name || path.basename(folderPath) || folderPath });
        await saveState();
      }
      return sendJson(response, 201, { libraries: appState.libraries });
    }
    if (request.method === "DELETE" && pathname.startsWith("/api/libraries/")) {
      if (!requireLocalManagement(request, response)) return;
      const id = pathname.split("/").pop();
      appState.libraries = appState.libraries.filter((library) => library.id !== id);
      appState.media = appState.media.filter((media) => media.libraryId !== id);
      await saveState();
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "PATCH" && /^\/api\/display-groups\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const groupId = pathname.split("/").pop();
      const folder = displayFolderSummaries().find((item) => item.id === groupId);
      if (!folder) return sendJson(response, 404, { error: "找不到这个视频文件夹，请先重新扫描。" });
      const body = await readJson(request);
      const title = String(body.title || "").trim();
      const season = Number(body.season);
      if (!title) return sendJson(response, 400, { error: "请填写网页上显示的作品名。" });
      if (title.length > 120) return sendJson(response, 400, { error: "作品名不能超过 120 个字符。" });
      if (!Number.isInteger(season) || season < 1 || season > 99) return sendJson(response, 400, { error: "季度必须是 1 到 99 之间的整数。" });
      appState.displayGroups = appState.displayGroups.filter((group) => group.id !== groupId && path.resolve(group.path).toLowerCase() !== path.resolve(folder.path).toLowerCase());
      appState.displayGroups.push({ id: groupId, path: folder.path, title, season, updatedAt: new Date().toISOString() });
      await saveState();
      return sendJson(response, 200, displayFolderSummaries().find((item) => item.id === groupId));
    }
    if (request.method === "POST" && pathname === "/api/scan") {
      if (!requireLocalManagement(request, response)) return;
      const media = await scanLibraries();
      return sendJson(response, 200, { count: media.length, media: media.map((item) => publicMedia(item, true)) });
    }
    if (request.method === "PATCH" && pathname === "/api/settings/auto-scan") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "请提供有效的自动扫描开关状态。" });
      return sendJson(response, 200, { scan: await updateCatalogScanSettings(body) });
    }
    if (request.method === "POST" && pathname === "/api/media/prepare-compatible") {
      if (!requireLocalManagement(request, response)) return;
      if (!mediaTools.available) return sendJson(response, 503, { error: mediaTools.hint });
      const candidates = appState.media.filter((item) => mediaCompatibility(item).needsCompatibleCopy && !item.remuxPath);
      const jobs = candidates.map((item) => startRemuxJob(item, true));
      return sendJson(response, 202, { count: jobs.length, jobs });
    }
    if (request.method === "POST" && /^\/api\/media\/[^/]+\/remux$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const mediaId = pathname.split("/")[3];
      const media = appState.media.find((item) => item.id === mediaId);
      if (!media) return sendJson(response, 404, { error: "找不到视频。" });
      const body = await readJson(request);
      const job = startRemuxJob(media, body.convertAudioToAac !== false);
      return sendJson(response, 202, job);
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/media\/[^/]+\/thumbnail$/.test(pathname)) {
      const mediaId = pathname.split("/")[3];
      const media = appState.media.find((item) => item.id === mediaId);
      if (!media?.thumbnailPath) return sendJson(response, 404, { error: "这个视频还没有生成缩略图，请在管理端重新扫描。" });
      return streamFile(request, response, media.thumbnailPath);
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/media\/[^/]+\/stream$/.test(pathname)) {
      const mediaId = pathname.split("/")[3];
      const media = appState.media.find((item) => item.id === mediaId);
      if (!media) return sendJson(response, 404, { error: "找不到视频。" });
      const filePath = url.searchParams.get("variant") === "remux" && media.remuxPath ? media.remuxPath : media.path;
      return streamFile(request, response, filePath, true);
    }
    if (request.method === "GET" && /^\/api\/media\/[^/]+\/subtitles\/[^/]+$/.test(pathname)) {
      const [, , , mediaId, , subtitleId] = pathname.split("/");
      const media = appState.media.find((item) => item.id === mediaId);
      const subtitle = media?.subtitles.find((item) => item.id === subtitleId);
      if (!subtitle) return sendJson(response, 404, { error: "找不到字幕。" });
      const originalContent = normalizeTextSubtitle(await readFile(subtitle.path));
      const needsWebVtt = subtitle.format === "SRT" && url.searchParams.get("format") === "vtt";
      const content = needsWebVtt ? srtToWebVtt(originalContent) : originalContent;
      response.writeHead(200, {
        "Content-Type": needsWebVtt ? "text/vtt; charset=utf-8" : contentTypeFor(subtitle.path),
        "Content-Length": Buffer.byteLength(content),
        "Cache-Control": "no-store",
      });
      return response.end(content);
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/media\/[^/]+\/fonts\/[^/]+$/.test(pathname)) {
      const [, , , mediaId, , fontId] = pathname.split("/");
      const media = appState.media.find((item) => item.id === mediaId);
      const font = media?.fonts.find((item) => item.id === fontId);
      if (!font) return sendJson(response, 404, { error: "找不到字体。" });
      return streamFile(request, response, font.path);
    }
    if (!pathname.startsWith("/api/") && await serveStatic(response, pathname)) return;
    return sendJson(response, 404, { error: "没有找到这个地址。" });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: error.message || "服务器内部错误" });
  }
});

let sharingServiceIsStopping = false;
let autoScanTimer = null;

function runScheduledAutoScan() {
  if (!appState.settings.autoScanEnabled || !appState.libraries.length || activeScan || sharingServiceIsStopping) return;
  const lastStartedMilliseconds = Date.parse(lastScanStartedAt || "") || 0;
  if (Date.now() - lastStartedMilliseconds < normalizedAutoScanIntervalSeconds() * 1000) return;
  scanLibraries().catch((error) => console.error(`自动扫描媒体目录失败：${error.message}`));
}

function startAutoScanScheduler() {
  if (autoScanTimer) return;
  autoScanTimer = setInterval(runScheduledAutoScan, AUTO_SCAN_SCHEDULER_TICK_MS);
  autoScanTimer.unref();
  runScheduledAutoScan();
}

async function stopSharingService() {
  if (sharingServiceIsStopping) return;
  sharingServiceIsStopping = true;
  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }

  remuxQueue.length = 0;
  for (const job of appState.jobs) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "failed";
      job.message = "共享服务已从系统托盘停止，请重新加入处理队列";
    }
  }
  await saveState().catch((error) => console.error(`停止前保存状态失败：${error.message}`));

  for (const child of [...trackedChildProcesses]) {
    try { child.kill(); }
    catch { /* 子进程可能已经自行退出。 */ }
  }

  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  const forceStopTimer = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 1800);
  forceStopTimer.unref();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LVD 本地服务已启动：http://127.0.0.1:${PORT}`);
  startAutoScanScheduler();
  queueAutomaticCompatibleCopies().then(({ queued }) => {
    if (queued) console.log(`已自动加入 ${queued} 个浏览器兼容副本任务。`);
  }).catch((error) => console.error(`自动兼容处理检查失败：${error.message}`));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`端口 ${PORT} 已被占用，LVD 可能已经启动。`);
  else console.error(error);
  process.exitCode = 1;
});
