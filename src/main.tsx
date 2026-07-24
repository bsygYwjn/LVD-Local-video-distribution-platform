import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import JASSUB from "jassub";
// `worker&url` tells Vite to package this file as a real Web Worker.
// A plain `?url` only returns the source file address and JASSUB cannot finish
// its background subtitle renderer initialization in every browser.
import workerUrl from "jassub/dist/worker/worker.js?worker&url";
import wasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import modernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";
import {
  AlertTriangle,
  Captions,
  ChevronLeft,
  ChevronDown,
  Check,
  CheckCircle2,
  Film,
  FolderOpen,
  FolderSearch,
  Gauge,
  HardDrive,
  Library,
  LoaderCircle,
  Maximize,
  Moon,
  Play,
  Power,
  RefreshCw,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import "./styles.css";

type Subtitle = { id: string; name: string; format: string; language: string; url: string; size?: number; modifiedAt?: string };
type FontAsset = { id: string; name: string; url: string; size?: number; modifiedAt?: string };
type BrowserCompatibility = {
  directPlayLikely: boolean;
  needsCompatibleCopy: boolean;
  canRemuxToMp4: boolean;
  issues: string[];
  deviceCodecDependent: boolean;
};
type MediaDisplay = { groupId: string; seriesTitle: string; season: number; episode: number; alias: string; configured: boolean };
type Media = {
  id: string;
  title: string;
  fileName: string;
  path?: string;
  extension: string;
  size: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number;
  videoCodec?: string | null;
  audioCodec?: string | null;
  bitDepth?: number;
  hdr?: string | null;
  posterHue: number;
  streamUrl: string;
  remuxUrl?: string | null;
  thumbnailUrl?: string | null;
  subtitles: Subtitle[];
  fonts: FontAsset[];
  tags: string[];
  compatibility?: BrowserCompatibility;
  compatibleCopyStatus?: "waiting" | "queued" | "running" | "completed" | "failed" | "ready" | "not-needed";
  compatibleCopyProgress?: number;
  display?: MediaDisplay;
  demo?: boolean;
};
type LibraryFolder = { id: string; name: string; path: string };
type DisplayGroup = { id: string; folderName?: string; title: string; season: number; configured: boolean; mediaCount: number };
type DisplayFolder = DisplayGroup & { path: string; customTitle: string; sampleAlias: string };
type Job = { id: string; mediaId: string; title: string; type: string; status: "queued" | "running" | "completed" | "failed"; progress: number; message: string };
type ToolStatus = { available: boolean; version?: string | null; hint?: string };
type Overview = {
  libraries: LibraryFolder[];
  media: Media[];
  jobs: Job[];
  tools: ToolStatus;
  settings: { maxStreams: number; cacheDirectory: string; autoScanEnabled: boolean; autoScanIntervalSeconds: number };
  scanning: boolean;
  activeVideoTransfers: number;
  lanAddresses: string[];
  autostart: { enabled: boolean; path: string };
  displayFolders: DisplayFolder[];
};
type CatalogScanStatus = {
  enabled: boolean;
  scanning: boolean;
  intervalSeconds: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
};
type Catalog = { media: Media[]; groups: DisplayGroup[]; scan: CatalogScanStatus };
type ThemeMode = "dark" | "light";

const THEME_STORAGE_KEY = "lvd-theme";

function initialTheme(): ThemeMode {
  const documentTheme = document.documentElement.dataset.theme;
  if (documentTheme === "dark" || documentTheme === "light") return documentTheme;
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
  } catch {
    // Some private browsing modes can disable storage; the OS preference still works.
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

class ApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) { super(message); this.name = "ApiError"; this.status = status; this.code = code; }
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json", ...options.headers } : options?.headers,
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.error || "操作失败", response.status, result.code);
  return result as T;
}

function formatBytes(value: number) {
  if (!value) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds = 0) {
  if (!seconds) return "未知时长";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}小时${minutes}分` : `${minutes}分钟`;
}

function codecName(value?: string | null) {
  const known: Record<string, string> = { hevc: "HEVC", h264: "H.264", av1: "AV1", vp9: "VP9", aac: "AAC", dts: "DTS", opus: "Opus" };
  return value ? known[value.toLowerCase()] || value.toUpperCase() : "待识别";
}

const SUBTITLE_OFFSET_OPTIONS = [-10, -5, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5, 10];

function subtitleOffsetLabel(offsetSeconds: number) {
  if (offsetSeconds < 0) return `提前 ${Math.abs(offsetSeconds).toFixed(1)} 秒`;
  if (offsetSeconds > 0) return `延后 ${offsetSeconds.toFixed(1)} 秒`;
  return "不偏移";
}

function parseSubtitleTimestamp(value: string) {
  const parts = value.split(":");
  const seconds = Number(parts.pop() || 0);
  const minutes = Number(parts.pop() || 0);
  const hours = Number(parts.pop() || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatAssTimestamp(seconds: number) {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const wholeSeconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function shiftAssSubtitles(content: string, offsetSeconds: number) {
  if (!offsetSeconds) return content;
  return content.replace(
    /^(\s*Dialogue\s*:[^,\r\n]*,)(\d+:\d{2}:\d{2}(?:\.\d+)?),(\d+:\d{2}:\d{2}(?:\.\d+)?)(,[^\r\n]*)$/gim,
    (_line, prefix: string, start: string, end: string, suffix: string) => `${prefix}${formatAssTimestamp(parseSubtitleTimestamp(start) + offsetSeconds)},${formatAssTimestamp(parseSubtitleTimestamp(end) + offsetSeconds)}${suffix}`,
  );
}

function formatWebVttTimestamp(seconds: number) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function shiftWebVttSubtitles(content: string, offsetSeconds: number) {
  if (!offsetSeconds) return content;
  return content.replace(
    /^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(\s+-->\s+)((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})([^\r\n]*)$/gm,
    (_line, start: string, separator: string, end: string, settings: string) => `${formatWebVttTimestamp(parseSubtitleTimestamp(start) + offsetSeconds)}${separator}${formatWebVttTimestamp(parseSubtitleTimestamp(end) + offsetSeconds)}${settings}`,
  );
}

function App() {
  const isAdminPath = window.location.pathname.startsWith("/admin");
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adminSection, setAdminSection] = useState<"overview" | "settings">("overview");
  const [selectedMedia, setSelectedMedia] = useState<Media | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setLoading(true);
      if (isAdminPath) setOverview(await api<Overview>("/api/overview"));
      else setCatalog(await api<Catalog>("/api/catalog"));
      setError("");
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "无法连接本地服务");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [isAdminPath]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!isAdminPath || (!overview?.settings.autoScanEnabled && !overview?.scanning && !overview?.jobs.some((job) => job.status === "queued" || job.status === "running"))) return;
    const timer = window.setInterval(() => refresh(true), 1800);
    return () => window.clearInterval(timer);
  }, [isAdminPath, overview?.jobs, overview?.scanning, overview?.settings.autoScanEnabled, refresh]);
  useEffect(() => {
    if (isAdminPath || (!catalog?.scan?.enabled && !catalog?.scan?.scanning && !catalog?.media.some((item) => ["waiting", "queued", "running"].includes(item.compatibleCopyStatus || "")))) return;
    const timer = window.setInterval(() => refresh(true), 4000);
    return () => window.clearInterval(timer);
  }, [catalog?.media, catalog?.scan?.enabled, catalog?.scan?.scanning, isAdminPath, refresh]);
  useEffect(() => {
    if (!selectedMedia || !catalog) return;
    const updatedMedia = catalog.media.find((item) => item.id === selectedMedia.id);
    if (updatedMedia && mediaLiveContentKey(updatedMedia) !== mediaLiveContentKey(selectedMedia)) setSelectedMedia(updatedMedia);
  }, [catalog, selectedMedia]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f7fb" : "#0b0d12");
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The theme remains active for this page even when storage is unavailable.
    }
  }, [theme]);

  const toggleTheme = () => setTheme((currentTheme) => currentTheme === "dark" ? "light" : "dark");

  if (loading) return <LoadingScreen />;

  return (
    <div className="app-shell">
      {isAdminPath ? (
        <AdminApp
          overview={overview}
          error={error}
          notice={notice}
          section={adminSection}
          onSectionChange={setAdminSection}
          onRefresh={refresh}
          onNotice={setNotice}
          onPlay={setSelectedMedia}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      ) : (
        <ClientApp catalog={catalog} error={error} onRefresh={refresh} theme={theme} onToggleTheme={toggleTheme} />
      )}
      {isAdminPath && selectedMedia && <PlayerModal media={selectedMedia} onClose={() => setSelectedMedia(null)} />}
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <div className="loading-mark">L</div>
      <p>正在连接 LVD…</p>
    </main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <div className="brand-mark">L</div>
      {!compact && <div><strong>LVD</strong><span>LOCAL VIDEO DIRECTORY</span></div>}
    </div>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: ThemeMode; onToggle: () => void }) {
  const isLight = theme === "light";
  const nextThemeLabel = isLight ? "深色模式" : "明亮模式";
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`切换到${nextThemeLabel}`}
      aria-pressed={isLight}
      title={`切换到${nextThemeLabel}`}
    >
      <span className="theme-toggle-icon" aria-hidden="true">{isLight ? <Sun size={16} /> : <Moon size={16} />}</span>
      <span className="theme-toggle-label">{isLight ? "明亮" : "深色"}</span>
    </button>
  );
}

function mediaDisplayName(media: Media) {
  return media.display?.alias || media.title;
}

function mediaLiveContentKey(media: Media) {
  return JSON.stringify({
    remuxUrl: media.remuxUrl,
    compatibleCopyStatus: media.compatibleCopyStatus,
    subtitles: media.subtitles.map(({ id, name, format, language, size, modifiedAt }) => ({ id, name, format, language, size, modifiedAt })),
    fonts: media.fonts.map(({ id, name, size, modifiedAt }) => ({ id, name, size, modifiedAt })),
  });
}

type SeriesView = DisplayGroup & { media: Media[] };

function ClientApp({ catalog, error, onRefresh, theme, onToggleTheme }: {
  catalog: Catalog | null;
  error: string;
  onRefresh: (quiet?: boolean) => Promise<void>;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("series"));
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("video"));
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNotice, setScanNotice] = useState<{ text: string; tone: "warning" | "success" } | null>(null);
  const allMedia = catalog?.media || [];
  const normalizedSearch = search.trim().toLowerCase();
  const series = useMemo<SeriesView[]>(() => (catalog?.groups || []).map((group) => ({
    ...group,
    media: allMedia
      .filter((item) => item.display?.groupId === group.id)
      .sort((left, right) => (left.display?.episode || 0) - (right.display?.episode || 0)),
  })), [allMedia, catalog?.groups]);
  const selectedSeries = series.find((group) => group.id === selectedGroupId) || null;
  const matchesSearch = (item: Media) => `${mediaDisplayName(item)} ${item.title} ${item.fileName} ${item.tags.join(" ")}`.toLowerCase().includes(normalizedSearch);
  const visibleSeries = selectedSeries ? [] : series.filter((group) => !normalizedSearch || group.title.toLowerCase().includes(normalizedSearch) || group.media.some(matchesSearch));
  const visibleEpisodes = selectedSeries ? selectedSeries.media.filter((item) => !normalizedSearch || matchesSearch(item)) : [];
  const selectedMedia = allMedia.find((item) => item.id === selectedMediaId) || null;
  const totalVideos = allMedia.length;

  useEffect(() => {
    const syncRouteFromHistory = () => {
      const parameters = new URLSearchParams(window.location.search);
      setSelectedGroupId(parameters.get("series"));
      setSelectedMediaId(parameters.get("video"));
      setSearch("");
    };
    window.addEventListener("popstate", syncRouteFromHistory);
    return () => window.removeEventListener("popstate", syncRouteFromHistory);
  }, []);

  const openSeries = (groupId: string) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("series", groupId);
    nextUrl.searchParams.delete("video");
    window.history.pushState({ series: groupId }, "", nextUrl);
    setSelectedGroupId(groupId);
    setSelectedMediaId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openMedia = (media: Media) => {
    const nextUrl = new URL(window.location.href);
    if (media.display?.groupId) nextUrl.searchParams.set("series", media.display.groupId);
    nextUrl.searchParams.set("video", media.id);
    window.history.pushState({ series: media.display?.groupId || null, video: media.id }, "", nextUrl);
    setSelectedGroupId(media.display?.groupId || selectedGroupId);
    setSelectedMediaId(media.id);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openLibrary = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("series");
    nextUrl.searchParams.delete("video");
    window.history.pushState({ series: null }, "", nextUrl);
    setSelectedGroupId(null);
    setSelectedMediaId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const scanNow = async () => {
    setScanBusy(true);
    setScanNotice({ text: "正在扫描视频目录并刷新文件列表…", tone: "success" });
    try {
      const result = await api<{ count: number }>("/api/catalog/scan", { method: "POST" });
      await onRefresh(true);
      setScanNotice({ text: `扫描完成，当前共有 ${result.count} 个视频文件。`, tone: "success" });
    } catch (operationError) {
      setScanNotice({ text: operationError instanceof Error ? operationError.message : "扫描刷新失败", tone: "warning" });
    } finally { setScanBusy(false); }
  };

  if (selectedMedia) {
    return (
      <div className="client-page client-player-page">
        <header className="client-header"><Brand /><ThemeToggle theme={theme} onToggle={onToggleTheme} /></header>
        <main className="client-player-main">
          <PlayerModal media={selectedMedia} pageMode />
        </main>
      </div>
    );
  }

  return (
    <div className="client-page" style={{ "--hero-hue": selectedSeries?.media[0]?.posterHue || 205 } as React.CSSProperties}>
      <header className="client-header">
        <Brand />
        <div className="header-actions">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button className="client-scan-now" onClick={scanNow} disabled={scanBusy} title="立即扫描并刷新文件"><RefreshCw size={16} className={scanBusy ? "spin" : ""} /><span>立即刷新</span></button>
          <label className="search-box"><Search size={17} /><input aria-label="搜索作品或剧集" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索作品、剧集…" /></label>
        </div>
      </header>

      <main className="client-main">
        {error && <StatusBanner tone="warning" icon={<AlertTriangle size={18} />}>{error}</StatusBanner>}
        {scanNotice && <StatusBanner tone={scanNotice.tone} icon={scanNotice.tone === "warning" ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}>{scanNotice.text}</StatusBanner>}
        <section className={`library-hero${selectedSeries ? " series-hero" : ""}`}>
          <div className={`hero-copy${selectedSeries ? "" : " hero-copy-brand"}`}>
            {selectedSeries ? <>
              <button className="library-back" onClick={openLibrary}><ChevronLeft size={17} />全部作品</button>
              <h1>{selectedSeries.title}</h1>
              <p>第 {selectedSeries.season} 季已整理完成，选择一集即可开始播放。</p>
            </> : <span className="hero-wordmark" aria-label="LVD">LVD</span>}
          </div>
          <div className="hero-stats" aria-label="媒体库概览">
            <div><strong>{selectedSeries ? selectedSeries.mediaCount : series.length}</strong><span>{selectedSeries ? "个视频" : "部作品"}</span></div>
            <div><strong>{selectedSeries ? `S${String(selectedSeries.season).padStart(2, "0")}` : totalVideos}</strong><span>{selectedSeries ? "当前季度" : "个视频"}</span></div>
          </div>
        </section>
        <section className="media-section">
          <div className="section-heading">
            <div><span className="section-kicker">{selectedSeries ? "EPISODES" : "LIBRARY"}</span><h2>{selectedSeries ? "全部剧集" : "全部作品"}</h2></div>
            <span className="media-count">{selectedSeries ? `${visibleEpisodes.length} 个视频` : `${visibleSeries.length} 个作品`}</span>
          </div>
          <div className="media-grid">
            {selectedSeries
              ? visibleEpisodes.map((item) => <MediaCard key={item.id} media={item} onPlay={() => openMedia(item)} />)
              : visibleSeries.map((group) => <SeriesCard key={group.id} series={group} onOpen={() => openSeries(group.id)} />)}
          </div>
          {!(selectedSeries ? visibleEpisodes.length : visibleSeries.length) && <div className="client-empty"><Library size={30} /><strong>{normalizedSearch ? "没有匹配的内容" : "媒体库暂时为空"}</strong><span>{normalizedSearch ? "请尝试其他作品名或集数。" : "请在服务器电脑的管理端添加视频目录并扫描。"}</span></div>}
        </section>
      </main>
    </div>
  );
}

function SeriesCard({ series, onOpen }: { series: SeriesView; onOpen: () => void }) {
  const cover = series.media[0];
  return (
    <article className="media-card" style={{ "--poster-hue": cover?.posterHue || 180 } as React.CSSProperties}>
      <button className="card-hit-area" onClick={onOpen} aria-label={`打开 ${series.title}`} />
      <div className="media-poster">
        {cover?.thumbnailUrl && <img className="video-thumbnail" src={cover.thumbnailUrl} alt={`${series.title} 作品缩略图`} loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <div className="poster-grain" />
        <span className="format-badge">作品</span>
        <span className="play-orb" aria-hidden="true"><FolderOpen size={20} /></span>
        <div className="poster-caption"><FolderOpen size={20} /><span>{series.mediaCount} 个视频</span></div>
      </div>
      <div className="media-card-body">
        <h3>{series.title}</h3>
        <p>第 {series.season} 季 · {series.mediaCount} 个视频</p>
        <div className="subtitle-summary"><CheckCircle2 size={14} />{series.configured ? "网页代号已设置" : "使用文件夹名显示"}</div>
      </div>
    </article>
  );
}

function MediaCard({ media, onPlay }: { media: Media; onPlay: () => void }) {
  const displayName = mediaDisplayName(media);
  return (
    <article className="media-card" style={{ "--poster-hue": media.posterHue } as React.CSSProperties}>
      <button className="card-hit-area" onClick={onPlay} aria-label={`播放 ${displayName}`} />
      <div className="media-poster">
        {media.thumbnailUrl && <img className="video-thumbnail" src={media.thumbnailUrl} alt={`${displayName} 视频缩略图`} loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <div className="poster-grain" />
        <span className="format-badge">{media.extension}</span>
        {media.hdr && <span className="poster-hdr">{media.hdr}</span>}
        <span className="play-orb" aria-hidden="true"><Play size={20} fill="currentColor" /></span>
        <div className="poster-caption"><Film size={20} /><span>{media.height ? `${media.height}P` : "原画"}</span></div>
      </div>
      <div className="media-card-body">
        <h3>{displayName}</h3>
        <p>{codecName(media.videoCodec)} · {media.bitDepth || 8}-bit · {formatDuration(media.durationSeconds)}</p>
        <div className="subtitle-summary"><Captions size={14} />{media.subtitles.length ? `${media.subtitles.length} 条字幕` : "暂无字幕"}</div>
      </div>
    </article>
  );
}

function AdminApp(props: {
  overview: Overview | null;
  error: string;
  notice: string;
  section: "overview" | "settings";
  onSectionChange: (section: "overview" | "settings") => void;
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (notice: string) => void;
  onPlay: (media: Media) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const { overview, error, notice, section, onSectionChange, onRefresh, onNotice, onPlay, theme, onToggleTheme } = props;
  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <Brand />
        <div className="sidebar-label">本机管理</div>
        <nav>
          <button className={section === "overview" ? "active" : ""} onClick={() => onSectionChange("overview")}><Gauge size={19} />总览</button>
          <button className={section === "settings" ? "active" : ""} onClick={() => onSectionChange("settings")}><Settings size={19} />运行设置</button>
        </nav>
        <div className="sidebar-bottom">
          <a className="server-pill" href="/" aria-label="打开观看端（端口 8096）" title="打开观看端"><span className={error ? "dot warning" : "dot"} /><div><strong>{error ? "服务异常" : "本地服务在线"}</strong><span>端口 8096 · 点击打开观看端</span></div></a>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar"><div><span className="eyebrow">LVD LOCAL CONTROL</span><h1>{section === "overview" ? "总览" : "运行设置"}</h1></div><ThemeToggle theme={theme} onToggle={onToggleTheme} /></header>
        {error && <StatusBanner tone="warning" icon={<AlertTriangle size={18} />}>{error}</StatusBanner>}
        {notice && <StatusBanner tone="success" icon={<CheckCircle2 size={18} />}>{notice}</StatusBanner>}
        {section === "overview" && <OverviewPanel overview={overview} onRefresh={onRefresh} onNotice={onNotice} onPlay={onPlay} />}
        {section === "settings" && <SettingsPanel overview={overview} onRefresh={onRefresh} onNotice={onNotice} />}
      </main>
    </div>
  );
}

function OverviewPanel({ overview, onRefresh, onNotice, onPlay }: { overview: Overview | null; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void; onPlay: (media: Media) => void }) {
  const [folderPath, setFolderPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [compatibilityExpanded, setCompatibilityExpanded] = useState(false);
  const media = overview?.media || [];
  const activeJobs = overview?.jobs.filter((job) => ["queued", "running"].includes(job.status)).length || 0;
  const activeMediaIds = new Set(overview?.jobs.filter((job) => ["queued", "running"].includes(job.status)).map((job) => job.mediaId) || []);
  const pendingCompatibility = media.filter((item) => item.compatibility?.needsCompatibleCopy && !item.remuxUrl);

  const addLibrary = async () => {
    if (!folderPath.trim()) return;
    setBusy(true);
    try {
      await api("/api/libraries", { method: "POST", body: JSON.stringify({ folderPath: folderPath.trim() }) });
      onNotice("视频目录已添加。点击“重新扫描”即可读取视频、外挂字幕和内嵌字幕。");
      setFolderPath("");
      await onRefresh();
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "添加失败");
    } finally { setBusy(false); }
  };

  const chooseFolder = async () => {
    setBusy(true);
    onNotice("请在弹出的 Windows 窗口中选择视频文件夹…");
    try {
      const result = await api<{ cancelled: boolean; path: string | null }>("/api/folders/select", { method: "POST" });
      if (result.cancelled || !result.path) return onNotice("已取消选择文件夹。");
      setFolderPath(result.path);
      await api("/api/libraries", { method: "POST", body: JSON.stringify({ folderPath: result.path }) });
      onNotice(`已添加视频目录：${result.path}。现在可以点击“重新扫描”。`);
      setFolderPath("");
      await onRefresh();
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法选择文件夹");
    } finally { setBusy(false); }
  };

  const scan = async () => {
    setBusy(true);
    onNotice("正在扫描目录。视频较多时需要等待片刻…");
    try {
      const result = await api<{ count: number }>("/api/scan", { method: "POST" });
      onNotice(`扫描完成，共发现 ${result.count} 个视频。`);
      await onRefresh();
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "扫描失败");
    } finally { setBusy(false); }
  };

  const toggleAutoScan = async () => {
    if (!overview) return;
    const enabled = !overview.settings.autoScanEnabled;
    setBusy(true);
    try {
      await api("/api/settings/auto-scan", { method: "PATCH", body: JSON.stringify({ enabled }) });
      onNotice(enabled
        ? `已开启自动扫描，每 ${overview.settings.autoScanIntervalSeconds} 秒检查一次媒体目录。`
        : "已关闭自动扫描；仍可在管理端手动重新扫描。");
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法修改自动扫描状态");
    } finally { setBusy(false); }
  };

  const remux = async (item: Media) => {
    if (!overview?.tools.available) return onNotice(overview?.tools.hint || "尚未找到 FFmpeg。请先在运行设置中完成安装。");
    await api(`/api/media/${item.id}/remux`, { method: "POST", body: JSON.stringify({ convertAudioToAac: true }) });
    onNotice(`“${item.title}”已加入无损重封装队列；视频码流不会重新压缩。`);
    await onRefresh(true);
  };

  const prepareCompatibleCopies = async () => {
    if (!overview?.tools.available) return onNotice(overview?.tools.hint || "尚未找到 FFmpeg。请先在运行设置中完成安装。");
    setBusy(true);
    try {
      const result = await api<{ count: number }>("/api/media/prepare-compatible", { method: "POST" });
      onNotice(result.count
        ? `已将 ${result.count} 个视频加入兼容副本队列。程序每次只处理 1 个：视频无损复制，音频转换为 AAC。`
        : "没有需要处理的新视频；兼容副本可能已就绪或正在队列中。");
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法创建兼容副本");
    } finally { setBusy(false); }
  };

  return (
    <div className="admin-content">
      <section className="panel library-panel">
        <div className="panel-title"><div><span className="panel-icon"><FolderOpen size={20} /></span><div><h2>视频目录</h2><p>使用 Windows 选择窗口添加文件夹，程序只读取文件，不会移动原视频；自动扫描统一在管理端控制。</p></div></div><div className="panel-actions"><button className={`secondary-button auto-scan-button${overview?.settings.autoScanEnabled ? " active" : ""}`} onClick={toggleAutoScan} disabled={busy || !overview}><RefreshCw size={16} className={overview?.scanning ? "spin" : ""} />{overview?.settings.autoScanEnabled ? `自动扫描 ${overview.settings.autoScanIntervalSeconds}s` : "自动扫描已关闭"}</button><button className="secondary-button" onClick={scan} disabled={busy || overview?.scanning || !overview?.libraries.length}><RefreshCw size={16} className={busy || overview?.scanning ? "spin" : ""} />重新扫描</button></div></div>
        <div className="folder-form"><button className="secondary-button folder-picker-button" onClick={chooseFolder} disabled={busy}><FolderSearch size={17} />选择并添加文件夹</button><input aria-label="视频目录路径" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !busy && folderPath.trim()) { event.preventDefault(); void addLibrary(); } }} placeholder="也可以手动输入路径，按 Enter 添加" /></div>
        <div className="folder-list">
          {overview?.libraries.length ? overview.libraries.map((library) => <div className="folder-item" key={library.id}><HardDrive size={18} /><div><strong>{library.name}</strong><span>{library.path}</span></div><CheckCircle2 size={18} className="success-icon" /></div>) : <div className="empty-row"><FolderOpen size={22} /><span>还没有媒体目录。添加后才能读取真实视频。</span></div>}
        </div>
      </section>

      <DisplayFoldersPanel folders={overview?.displayFolders || []} onRefresh={onRefresh} onNotice={onNotice} />

      <section className={`panel media-table-panel collapsible-panel${compatibilityExpanded ? "" : " is-collapsed"}`}>
        <div className="panel-title"><div><span className="panel-icon"><Library size={20} /></span><div><h2>自动兼容处理</h2><p>扫描或启动时会自动检测 MKV、FLAC/Opus 等浏览器不易直放的组合，顺序生成 MP4 + AAC 副本；视频不重新压缩。</p></div></div><div className="panel-actions"><span className="table-count">{media.length} 个文件 · {pendingCompatibility.length} 个等待/处理中</span><button className="secondary-button" onClick={prepareCompatibleCopies} disabled={busy || !pendingCompatibility.length}><RefreshCw size={16} className={activeJobs ? "spin" : ""} />重新检查自动队列</button><button type="button" className="collapse-button" onClick={() => setCompatibilityExpanded((expanded) => !expanded)} aria-expanded={compatibilityExpanded} aria-controls="compatibility-list" aria-label={compatibilityExpanded ? "折叠自动兼容处理" : "展开自动兼容处理"} title={compatibilityExpanded ? "折叠" : "展开"}><ChevronDown size={18} /></button></div></div>
        {compatibilityExpanded && <div className="media-table" id="compatibility-list">
          {media.length ? media.map((item) => (
            <div className="media-row" key={item.id}>
              <div className="tiny-poster" style={{ "--poster-hue": item.posterHue } as React.CSSProperties}><Film size={18} /></div>
              <div className="media-file"><strong>{item.title}</strong><span>{item.path}</span></div>
              <div className="technical"><span>{item.extension}</span><span>{codecName(item.videoCodec)}</span><span>{item.bitDepth || 8}-bit</span>{item.hdr && <span className="hdr-chip">{item.hdr}</span>}</div>
              <div className="row-actions"><button title="预览播放" onClick={() => onPlay(item)}><Play size={16} /></button><button className="remux-button" onClick={() => remux(item)} disabled={Boolean(item.remuxUrl) || activeMediaIds.has(item.id)}>{item.remuxUrl ? <><Check size={15} />兼容副本就绪</> : activeMediaIds.has(item.id) ? <><LoaderCircle size={15} className="spin" />处理中</> : <>重封装 + AAC</>}</button></div>
            </div>
          )) : <div className="empty-table"><Film size={28} /><strong>媒体库还是空的</strong><span>先在上方添加一个视频目录，再执行扫描。</span></div>}
        </div>}
      </section>

      {!!overview?.jobs.length && <JobsPanel jobs={overview.jobs} />}
    </div>
  );
}

function DisplayFoldersPanel({ folders, onRefresh, onNotice }: { folders: DisplayFolder[]; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`panel display-groups-panel collapsible-panel${expanded ? "" : " is-collapsed"}`}>
      <div className="panel-title"><div><span className="panel-icon"><FolderOpen size={20} /></span><div><h2>网页作品代号</h2><p>每个视频文件夹填写一次作品名和季度；只改变网页显示，不修改原视频或字幕文件名。</p></div></div><div className="panel-actions"><span className="table-count">{folders.filter((folder) => folder.configured).length}/{folders.length} 个已设置</span><button type="button" className="collapse-button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="display-folders-list" aria-label={expanded ? "折叠网页作品代号" : "展开网页作品代号"} title={expanded ? "折叠" : "展开"}><ChevronDown size={18} /></button></div></div>
      {expanded && <div className="display-group-list" id="display-folders-list">
        {folders.length ? folders.map((folder) => <DisplayFolderRow key={folder.id} folder={folder} onRefresh={onRefresh} onNotice={onNotice} />) : <div className="empty-table"><FolderOpen size={28} /><strong>还没有可设置的作品文件夹</strong><span>添加视频目录并扫描后会自动列出。</span></div>}
      </div>}
    </section>
  );
}

function DisplayFolderRow({ folder, onRefresh, onNotice }: { folder: DisplayFolder; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void }) {
  const [title, setTitle] = useState(folder.customTitle);
  const [season, setSeason] = useState(folder.season);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setTitle(folder.customTitle); setSeason(folder.season); }, [folder.customTitle, folder.season]);
  const episode = Number(folder.sampleAlias.match(/E(\d+)$/)?.[1] || 1);
  const previewTitle = title.trim() || folder.folderName || folder.title;
  const preview = `${previewTitle} - S${String(season || 1).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

  const save = async () => {
    if (!title.trim()) return onNotice(`请先为“${folder.folderName}”填写作品名。`);
    setSaving(true);
    try {
      await api(`/api/display-groups/${folder.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim(), season }) });
      onNotice(`“${title.trim()}”的网页代号已保存；磁盘文件名没有改变。`);
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法保存作品代号");
    } finally { setSaving(false); }
  };

  return (
    <div className="display-group-row">
      <div className="display-group-meta"><FolderOpen size={18} /><div><strong>{folder.folderName}</strong><span>{folder.path}</span><small>{folder.mediaCount} 个视频 · 示例：{preview}</small></div></div>
      <div className="display-group-form"><label><span>作品名</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：缘之空" /></label><label className="season-field"><span>季度</span><input type="number" min="1" max="99" value={season} onChange={(event) => setSeason(Number(event.target.value))} /></label><button className="primary-button" onClick={save} disabled={saving || !title.trim()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存代号</button></div>
    </div>
  );
}

function JobsPanel({ jobs }: { jobs: Job[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`panel jobs-panel collapsible-panel${expanded ? "" : " is-collapsed"}`}>
      <div className="panel-title"><div><span className="panel-icon"><RefreshCw size={20} /></span><div><h2>自动处理队列</h2><p>这里只改变容器和必要的音频格式，视频画面码流原样复制；每次只处理一部。</p></div></div><button type="button" className="collapse-button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="automatic-jobs-list" aria-label={expanded ? "折叠自动处理队列" : "展开自动处理队列"} title={expanded ? "折叠" : "展开"}><ChevronDown size={18} /></button></div>
      {expanded && <div id="automatic-jobs-list">{jobs.slice(0, 5).map((job) => <div className="job-row" key={job.id}><span className={`job-status ${job.status}`}>{job.status === "running" ? <LoaderCircle size={16} className="spin" /> : job.status === "completed" ? <Check size={16} /> : job.status === "failed" ? <X size={16} /> : <RefreshCw size={16} />}</span><div><strong>{job.title}</strong><span>{job.type} · {job.message}</span></div><div className="job-progress"><div><span style={{ width: `${job.progress}%` }} /></div><b>{job.progress}%</b></div></div>)}</div>}
    </section>
  );
}

function SettingsPanel({ overview, onRefresh, onNotice }: { overview: Overview | null; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void }) {
  const refreshTools = async () => { await api("/api/tools/refresh", { method: "POST" }); await onRefresh(); onNotice("已重新检查媒体工具。 "); };
  const toggleAutostart = async () => {
    const enabled = !overview?.autostart.enabled;
    try {
      await api("/api/autostart", { method: "POST", body: JSON.stringify({ enabled }) });
      await onRefresh();
      onNotice(enabled ? "已开启开机自启；下次登录 Windows 后 LVD 会在后台启动。" : "已关闭开机自启。");
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法修改开机自启设置");
    }
  };
  return (
    <div className="admin-content settings-grid">
      <section className="panel setting-card"><div className={`setting-icon ${overview?.tools.available ? "ready" : "warning"}`}>{overview?.tools.available ? <CheckCircle2 /> : <AlertTriangle />}</div><div><span className="eyebrow">MEDIA ENGINE</span><h2>{overview?.tools.available ? "FFmpeg 已就绪" : "等待安装 FFmpeg"}</h2><p>{overview?.tools.available ? overview.tools.version : overview?.tools.hint}</p><button className="secondary-button" onClick={refreshTools}><RefreshCw size={16} />重新检查</button></div></section>
      <section className="panel setting-card"><div className={`setting-icon ${overview?.autostart.enabled ? "ready" : "standby"}`}><Power /></div><div><span className="eyebrow">WINDOWS STARTUP</span><h2>开机自启{overview?.autostart.enabled ? "已开启" : "已关闭"}</h2><p>开启后，每次登录 Windows 都会在后台启动 LVD；不会自动打开管理网页或信息窗口。</p><button className={overview?.autostart.enabled ? "secondary-button" : "primary-button"} onClick={toggleAutostart}>{overview?.autostart.enabled ? "关闭开机自启" : "开启开机自启"}</button></div></section>
    </div>
  );
}

function StatusBanner({ children, icon, tone }: { children: React.ReactNode; icon: React.ReactNode; tone: "warning" | "success" }) {
  return <div className={`status-banner ${tone}`}>{icon}<span>{children}</span></div>;
}

function PlayerModal({ media, onClose, pageMode = false }: { media: Media; onClose?: () => void; pageMode?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<JASSUB | null>(null);
  // Start with subtitles disabled so video decoding is tested independently.
  // The viewer can then enable SRT or ASS/SSA after the picture starts.
  const [subtitleId, setSubtitleId] = useState("off");
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  const [srtTrackUrl, setSrtTrackUrl] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const selectedSubtitle = media.subtitles.find((item) => item.id === subtitleId);
  const needsCompatibleCopy = Boolean(media.compatibility?.needsCompatibleCopy && !media.remuxUrl);
  const compatibilityIssues = media.compatibility?.issues.join("、") || `${media.extension} / ${codecName(media.videoCodec)} / ${codecName(media.audioCodec)}`;
  const displayName = mediaDisplayName(media);
  const autoPreparingCopy = ["waiting", "queued", "running"].includes(media.compatibleCopyStatus || "");

  useEffect(() => {
    const subtitle = media.subtitles.find((item) => item.id === subtitleId);
    const video = videoRef.current;
    if (!video || !subtitle || !["ASS", "SSA"].includes(subtitle.format)) {
      rendererRef.current?.destroy();
      rendererRef.current = null;
      Array.from(video?.textTracks || []).forEach((track) => { track.mode = "disabled"; });
      return;
    }
    const controller = new AbortController();
    let active = true;
    let renderer: JASSUB | null = null;
    Array.from(video.textTracks).forEach((track) => { track.mode = "disabled"; });
    void (async () => {
      try {
        const response = await fetch(subtitle.url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`字幕请求失败（${response.status}）`);
        const content = shiftAssSubtitles(await response.text(), subtitleOffset);
        if (!active) return;
        renderer = new JASSUB({
          video,
          subContent: content,
          workerUrl,
          wasmUrl,
          modernWasmUrl,
          fonts: media.fonts.map((font) => font.url),
          queryFonts: "local",
        });
        rendererRef.current = renderer;
        await renderer.ready;
      } catch { }
    })();
    return () => {
      active = false;
      controller.abort();
      renderer?.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [media, subtitleId, subtitleOffset]);

  useEffect(() => {
    const subtitle = media.subtitles.find((item) => item.id === subtitleId);
    if (subtitle?.format !== "SRT") {
      setSrtTrackUrl("");
      return;
    }
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";
    setSrtTrackUrl("");
    void (async () => {
      try {
        const response = await fetch(`${subtitle.url}?format=vtt`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`字幕请求失败（${response.status}）`);
        const content = shiftWebVttSubtitles(await response.text(), subtitleOffset);
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([content], { type: "text/vtt" }));
        setSrtTrackUrl(objectUrl);
      } catch { }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media, subtitleId, subtitleOffset]);

  const enterFullscreen = () => playerRef.current?.requestFullscreen?.();
  const reportPlaybackError = () => {
    if (needsCompatibleCopy) {
      setPlaybackError(autoPreparingCopy
        ? `浏览器无法直接解码 ${compatibilityIssues}；LVD 正在后台自动生成兼容副本，完成后播放器会自动切换。`
        : `浏览器无法直接解码 ${compatibilityIssues}，自动兼容处理未完成，请在服务器电脑管理端查看处理队列。`);
    } else if (media.remuxUrl && media.compatibility?.deviceCodecDependent) {
      setPlaybackError(`兼容副本已经是 MP4 + AAC，但此设备的浏览器仍不支持 ${codecName(media.videoCodec)} 视频解码。`);
    } else {
      setPlaybackError("浏览器无法播放这个视频源，请检查文件是否完整以及当前设备是否支持该视频编码。");
    }
  };

  const player = (
      <div className={`player-modal${pageMode ? " player-page-panel" : ""}`} ref={playerRef}>
        <div className="player-topbar"><div><strong>{displayName}</strong><span>{media.demo ? "播放器界面示例" : `${media.extension} · ${codecName(media.videoCodec)} · ${media.bitDepth || 8}-bit`}</span></div><div><button onClick={enterFullscreen}><Maximize size={18} />网页全屏</button>{!pageMode && onClose && <button className="close-button" onClick={onClose} aria-label="关闭播放器"><X size={20} /></button>}</div></div>
        <div className={`video-stage ${media.demo ? "demo-stage" : ""}`} style={{ "--poster-hue": media.posterHue } as React.CSSProperties}>
          {media.demo ? <div className="demo-player-copy"><div className="play-orb large"><Play size={28} fill="currentColor" /></div><h2>这里将播放你的原始视频</h2><p>播放器使用 Range 直传，并在画面上方渲染 ASS/SSA 特效字幕。</p></div> : <video ref={videoRef} src={media.remuxUrl || media.streamUrl} controls autoPlay playsInline preload="metadata" onError={reportPlaybackError} onLoadedMetadata={() => setPlaybackError("")}>{selectedSubtitle?.format === "SRT" && srtTrackUrl && <track key={`${selectedSubtitle.id}-${subtitleOffset}`} kind="subtitles" src={srtTrackUrl} srcLang="zh" label={selectedSubtitle.language} default onLoad={(event) => { event.currentTarget.track.mode = "showing"; }} />}</video>}
        </div>
        {!media.demo && (playbackError || needsCompatibleCopy) && <div className={`playback-status ${playbackError ? "error" : "warning"}`}><AlertTriangle size={17} /><span>{playbackError || (autoPreparingCopy ? `检测到 ${compatibilityIssues}，LVD 已自动加入兼容处理队列；完成后本页会自动改用 MP4 + AAC 副本。` : `当前原片包含 ${compatibilityIssues}，请在服务器电脑管理端检查自动兼容处理状态。`)}</span></div>}
        <div className="player-toolbar">
          <div className="player-subtitle-controls">
            <div className="track-select"><Captions size={17} /><label htmlFor="subtitle-track">字幕</label><select id="subtitle-track" value={subtitleId} onChange={(event) => setSubtitleId(event.target.value)}><option value="off">关闭字幕</option>{media.subtitles.map((subtitle) => <option value={subtitle.id} key={subtitle.id}>{subtitle.language} · {subtitle.format} · {subtitle.name}</option>)}</select></div>
            <div className="subtitle-offset"><label htmlFor="subtitle-offset">时间偏移</label><select id="subtitle-offset" value={subtitleOffset} onChange={(event) => setSubtitleOffset(Number(event.target.value))} disabled={!selectedSubtitle}><option value={0}>不偏移</option>{SUBTITLE_OFFSET_OPTIONS.filter((value) => value !== 0).map((value) => <option value={value} key={value}>{subtitleOffsetLabel(value)}</option>)}</select></div>
          </div>
          <div className="player-technical"><span>{media.width || 1920}×{media.height || 1080}</span><span>{media.remuxUrl ? "AAC" : codecName(media.audioCodec)}</span>{media.remuxUrl && <span>MP4 兼容副本</span>}{media.hdr && <span className="hdr-chip">{media.hdr}</span>}</div>
        </div>
      </div>
  );

  if (pageMode) return player;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`播放 ${displayName}`}>
      {player}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
