import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronLeft,
  BookOpen,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  Layers3,
  Loader2,
  MapPin,
  Maximize2,
  Minimize2,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Search,
  ShieldCheck,
  Square,
  Sun,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { MarkdownContent } from "@/components/MarkdownContent";

const PAGE_SIZE = 24;
const PROJECT_HOVER_CARD_ID = "project-hover-card";
const PINNED_PROJECTS_STORAGE_KEY = "engramview:pinned-projects";
const SELECTED_PROJECT_STORAGE_KEY = "engramview:selected-project";
const SELECTED_MEMORY_ID_STORAGE_KEY = "engramview:selected-memory-id";
const IS_READING_FOCUS_STORAGE_KEY = "engramview:is-reading-focus";
const READER_THEME_STORAGE_KEY = "engramview:reader-theme";
const PROJECTS_COLLAPSED_STORAGE_KEY = "engramview:projects-collapsed";
const MEMORY_LIST_COLLAPSED_STORAGE_KEY = "engramview:memory-list-collapsed";
const SORT_ORDER_STORAGE_KEY = "engramview:sort-order";
const QUERY_STORAGE_KEY = "engramview:query";
const PROJECT_FILTER_STORAGE_KEY = "engramview:project-filter";
const PAGE_STORAGE_KEY = "engramview:page";

let initialDataPromise: Promise<[DatabaseInfo, ProjectSummary[]]> | null = null;
const listRequestPromises = new Map<string, Promise<PagedMemories>>();

function loadInitialDataOnce() {
  if (initialDataPromise) return initialDataPromise;
  const pending = Promise.all([
    invoke<DatabaseInfo>("get_database_info"),
    invoke<ProjectSummary[]>("list_projects"),
  ]);
  initialDataPromise = pending;
  void pending.then(
    () => { if (initialDataPromise === pending) initialDataPromise = null; },
    () => { if (initialDataPromise === pending) initialDataPromise = null; },
  );
  return pending;
}

function listMemoriesOnce(request: object) {
  const key = JSON.stringify(request);
  const existing = listRequestPromises.get(key);
  if (existing) return existing;
  const pending = invoke<PagedMemories>("list_memories", { request });
  listRequestPromises.set(key, pending);
  void pending.then(
    () => listRequestPromises.delete(key),
    () => listRequestPromises.delete(key),
  );
  return pending;
}

type SortOrder = "latest" | "oldest";
type ReaderTheme = "warm" | "dark";

interface DatabaseInfo {
  path: string;
  exists: boolean;
  sizeBytes?: number;
}

interface ProjectSummary {
  name: string;
  observationCount: number;
  sessionCount: number;
  promptCount: number;
  latestActivity?: string;
  firstMemoryAt?: string;
  directory?: string;
}

interface ProjectHoverState {
  project: ProjectSummary;
  anchor: HTMLElement;
}

interface HoverCardPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

interface MemorySummary {
  id: number;
  syncId?: string;
  sessionId: string;
  memoryType: string;
  title: string;
  preview: string;
  project?: string;
  scope: string;
  topicKey?: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryDetail extends Omit<MemorySummary, "preview"> {
  content: string;
  toolName?: string;
  revisionCount: number;
  duplicateCount: number;
  lastSeenAt?: string;
}

interface PagedMemories {
  items: MemorySummary[];
  total: number;
  page: number;
  pageSize: number;
}

function useDebouncedValue(value: string, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [delayMs, value]);

  return debouncedValue;
}

function parseDate(value?: string) {
  if (!value) return null;

  const date = new Date(value.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value?: string) {
  if (!value) return "No date";

  const date = parseDate(value);
  if (!date) return value;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatAgeSince(value?: string) {
  const firstMemoryDate = parseDate(value);
  if (!firstMemoryDate) return "No age";

  const now = new Date();
  const elapsedMs = now.getTime() - firstMemoryDate.getTime();
  if (elapsedMs < 0) return "Future date";

  const elapsedDays = Math.floor(elapsedMs / 86_400_000);
  let months =
    (now.getFullYear() - firstMemoryDate.getFullYear()) * 12 +
    now.getMonth() -
    firstMemoryDate.getMonth();

  if (now.getDate() < firstMemoryDate.getDate()) {
    months -= 1;
  }

  if (months < 1) {
    return `${elapsedDays} ${elapsedDays === 1 ? "day" : "days"}`;
  }

  if (months < 12) {
    return `${months} ${months === 1 ? "month" : "months"}`;
  }

  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  const yearLabel = years === 1 ? "yr" : "yrs";

  if (remainingMonths === 0) return `${years} ${yearLabel}`;

  return `${years} ${yearLabel} ${remainingMonths} mo`;
}

function formatBytes(value?: number) {
  if (value === undefined) return "Unknown size";

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatCardPreview(text: string | null | undefined, maxLength = 130): string {
  if (!text || !text.trim()) return "No preview available.";

  const cleaned = text
    .replace(/\\n/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > maxLength) {
    return cleaned.slice(0, maxLength).trim() + "…";
  }

  return cleaned;
}

async function runWindowAction<T>(
  action: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    console.warn(`[EngramView] Window ${action} failed.`, error);
    return undefined;
  }
}

function App() {
  const [databaseInfo, setDatabaseInfo] = useState<DatabaseInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pinnedProjects, setPinnedProjects] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem(PINNED_PROJECTS_STORAGE_KEY);
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed)
        ? parsed.filter((name): name is string => typeof name === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [selectedProject, setSelectedProject] = useState<string | null>(() => {
    try {
      const stored = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
      if (stored === "__ALL_PROJECTS__") return null;
      return stored && stored.trim() !== "" ? stored : null;
    } catch {
      return null;
    }
  });
  const [isSafeModeExpanded, setIsSafeModeExpanded] = useState(false);
  const [isProjectsCollapsed, setIsProjectsCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(PROJECTS_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [isMemoryListCollapsed, setIsMemoryListCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(MEMORY_LIST_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [isReadingFocus, setIsReadingFocus] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(IS_READING_FOCUS_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(() => {
    try {
      const stored = window.localStorage.getItem(READER_THEME_STORAGE_KEY);
      return stored === "dark" ? "dark" : "warm";
    } catch {
      return "warm";
    }
  });
  const [isToolbarSearchOpen, setIsToolbarSearchOpen] = useState(false);
  const [hoveredProject, setHoveredProject] = useState<ProjectHoverState | null>(null);
  const [hoverCardPosition, setHoverCardPosition] = useState<HoverCardPosition | null>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const layoutBeforeFocus = useRef({ projectsCollapsed: false, memoriesCollapsed: false });
  const [projectFilter, setProjectFilter] = useState<string>(() => {
    try {
      return window.localStorage.getItem(PROJECT_FILTER_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [query, setQuery] = useState<string>(() => {
    try {
      return window.localStorage.getItem(QUERY_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const debouncedQuery = useDebouncedValue(query, 250);
  const [page, setPage] = useState<number>(() => {
    try {
      const stored = window.localStorage.getItem(PAGE_STORAGE_KEY);
      return stored ? Math.max(1, Number(stored)) : 1;
    } catch {
      return 1;
    }
  });
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => {
    try {
      const stored = window.localStorage.getItem(SORT_ORDER_STORAGE_KEY);
      return stored === "oldest" ? "oldest" : "latest";
    } catch {
      return "latest";
    }
  });
  const [memories, setMemories] = useState<PagedMemories>({
    items: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
  });
  const [selectedMemoryId, setSelectedMemoryId] = useState<number | null>(() => {
    try {
      const stored = window.localStorage.getItem(SELECTED_MEMORY_ID_STORAGE_KEY);
      return stored ? Number(stored) : null;
    } catch {
      return null;
    }
  });
  const [selectedMemory, setSelectedMemory] = useState<MemoryDetail | null>(null);
  const [isInitialDataReady, setIsInitialDataReady] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isLoadingMemories, setIsLoadingMemories] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memoryFilterKeyRef = useRef<string | null>(null);
  const lastProjectRefreshRef = useRef(0);
  const [projectRefreshGeneration, setProjectRefreshGeneration] = useState(0);

  const pinnedSet = useMemo(() => new Set(pinnedProjects), [pinnedProjects]);

  const filteredProjects = useMemo(() => {
    const normalizedFilter = projectFilter.trim().toLowerCase();

    const matchingProjects = !normalizedFilter ? projects : projects.filter((project) =>
      project.name.toLowerCase().includes(normalizedFilter),
    );

    return [...matchingProjects].sort((first, second) =>
      Number(pinnedSet.has(second.name)) - Number(pinnedSet.has(first.name)),
    );
  }, [pinnedSet, projectFilter, projects]);

  const appStateRef = useRef({
    pinnedProjects,
    selectedProject,
    selectedMemoryId,
    isReadingFocus,
    readerTheme,
    isProjectsCollapsed,
    isMemoryListCollapsed,
    sortOrder,
    projectFilter,
    query,
    page,
  });

  useEffect(() => {
    appStateRef.current = {
      pinnedProjects,
      selectedProject,
      selectedMemoryId,
      isReadingFocus,
      readerTheme,
      isProjectsCollapsed,
      isMemoryListCollapsed,
      sortOrder,
      projectFilter,
      query,
      page,
    };
  }, [
    pinnedProjects,
    selectedProject,
    selectedMemoryId,
    isReadingFocus,
    readerTheme,
    isProjectsCollapsed,
    isMemoryListCollapsed,
    sortOrder,
    projectFilter,
    query,
    page,
  ]);

  const lastSavedJsonRef = useRef<string>("");

  const saveStateToDisk = useCallback(() => {
    try {
      if (document.visibilityState !== "visible") return;

      const s = appStateRef.current;
      const currentJson = JSON.stringify(s);
      if (lastSavedJsonRef.current === currentJson) return;
      lastSavedJsonRef.current = currentJson;

      window.localStorage.setItem(PINNED_PROJECTS_STORAGE_KEY, JSON.stringify(s.pinnedProjects));
      if (s.selectedProject !== null) {
        window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, s.selectedProject);
      } else {
        window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, "__ALL_PROJECTS__");
      }
      if (s.selectedMemoryId !== null) {
        window.localStorage.setItem(SELECTED_MEMORY_ID_STORAGE_KEY, String(s.selectedMemoryId));
      } else {
        window.localStorage.removeItem(SELECTED_MEMORY_ID_STORAGE_KEY);
      }
      window.localStorage.setItem(IS_READING_FOCUS_STORAGE_KEY, String(s.isReadingFocus));
      window.localStorage.setItem(READER_THEME_STORAGE_KEY, s.readerTheme);
      window.localStorage.setItem(PROJECTS_COLLAPSED_STORAGE_KEY, String(s.isProjectsCollapsed));
      window.localStorage.setItem(MEMORY_LIST_COLLAPSED_STORAGE_KEY, String(s.isMemoryListCollapsed));
      window.localStorage.setItem(SORT_ORDER_STORAGE_KEY, s.sortOrder);
      window.localStorage.setItem(PROJECT_FILTER_STORAGE_KEY, s.projectFilter);
      window.localStorage.setItem(QUERY_STORAGE_KEY, s.query);
      window.localStorage.setItem(PAGE_STORAGE_KEY, String(s.page));
    } catch {}
  }, []);

  // Debounce disk writes (500ms delay after last interaction)
  useEffect(() => {
    const timer = setTimeout(() => {
      saveStateToDisk();
    }, 500);

    return () => clearTimeout(timer);
  }, [
    pinnedProjects,
    selectedProject,
    selectedMemoryId,
    isReadingFocus,
    readerTheme,
    isProjectsCollapsed,
    isMemoryListCollapsed,
    sortOrder,
    projectFilter,
    query,
    page,
    saveStateToDisk,
  ]);

  // Instantly flush state on app close / unload
  useEffect(() => {
    const handleUnload = () => {
      saveStateToDisk();
    };
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
    };
  }, [saveStateToDisk]);

  function toggleProjectPin(projectName: string) {
    setPinnedProjects((current) =>
      current.includes(projectName)
        ? current.filter((name) => name !== projectName)
        : [...current, projectName],
    );
  }

  const allProjectsLatestActivity = useMemo(() => {
    return projects.reduce<string | undefined>((latest, project) => {
      const candidate = parseDate(project.latestActivity);
      if (!candidate) return latest;

      const currentLatest = parseDate(latest);
      return !currentLatest || candidate > currentLatest
        ? project.latestActivity
        : latest;
    }, undefined);
  }, [projects]);

  const allProjectsFirstMemoryAt = useMemo(() => {
    return projects.reduce<string | undefined>((earliest, project) => {
      const candidate = parseDate(project.firstMemoryAt);
      if (!candidate) return earliest;

      const currentEarliest = parseDate(earliest);
      return !currentEarliest || candidate < currentEarliest
        ? project.firstMemoryAt
        : earliest;
    }, undefined);
  }, [projects]);

  const totalPages = Math.max(1, Math.ceil(memories.total / memories.pageSize));
  const allProjectsMemoryCount = projects.reduce(
    (total, project) => total + project.observationCount,
    0,
  );
  const selectedProjectSummary = projects.find(
    (project) => project.name === selectedProject,
  );
  const latestActivity =
    selectedProject === null
      ? allProjectsLatestActivity
      : selectedProjectSummary?.latestActivity;
  const firstMemoryAt =
    selectedProject === null
      ? allProjectsFirstMemoryAt
      : selectedProjectSummary?.firstMemoryAt;

  useEffect(() => {
    let isCurrent = true;

    async function loadInitialData() {
      setIsLoadingProjects(true);
      setError(null);

      try {
        const [database, projectList] = await loadInitialDataOnce();

        if (!isCurrent) return;

        setDatabaseInfo(database);
        setProjects(projectList);
        setSelectedProject((current) => {
          const stored = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
          if (stored === "__ALL_PROJECTS__") return null;
          if (current !== null && projectList.some((project) => project.name === current)) {
            return current;
          }
          if (stored && projectList.some((project) => project.name === stored)) {
            return stored;
          }
          return projectList[0]?.name ?? null;
        });
        lastProjectRefreshRef.current = Date.now();
        setIsInitialDataReady(true);
      } catch (caughtError) {
        if (isCurrent) setError(String(caughtError));
      } finally {
        if (isCurrent) setIsLoadingProjects(false);
      }
    }

    void loadInitialData();

    return () => {
      isCurrent = false;
    };
  }, [projectRefreshGeneration]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (Date.now() - lastProjectRefreshRef.current >= 30_000) {
        setProjectRefreshGeneration((generation) => generation + 1);
      }
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, []);

  function retryInitialLoad() {
    setError(null);
    setIsInitialDataReady(false);
    setProjectRefreshGeneration((generation) => generation + 1);
  }

  useEffect(() => {
    if (!isInitialDataReady) return;

    const filterKey = JSON.stringify([selectedProject, debouncedQuery, sortOrder]);
    if (memoryFilterKeyRef.current !== filterKey) {
      memoryFilterKeyRef.current = filterKey;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }

    let isCurrent = true;

    async function loadMemories() {
      setIsLoadingMemories(true);
      setError(null);

      try {
        const response = await listMemoriesOnce({
          project: selectedProject,
          query: debouncedQuery,
          page,
          pageSize: PAGE_SIZE,
          sortOrder,
        });

        if (!isCurrent) return;

        setMemories(response);
        setSelectedMemoryId((currentId) => {
          if (response.items.some((memory) => memory.id === currentId)) {
            return currentId;
          }

          return response.items[0]?.id ?? null;
        });
      } catch (caughtError) {
        if (isCurrent) setError(String(caughtError));
      } finally {
        if (isCurrent) setIsLoadingMemories(false);
      }
    }

    void loadMemories();

    return () => {
      isCurrent = false;
    };
  }, [debouncedQuery, isInitialDataReady, page, selectedProject, sortOrder]);

  useEffect(() => {
    let isCurrent = true;

    async function loadMemoryDetail(memoryId: number) {
      setIsLoadingDetail(true);
      setError(null);

      try {
        const response = await invoke<MemoryDetail | null>("get_memory", {
          id: memoryId,
        });

        if (isCurrent) setSelectedMemory(response);
      } catch (caughtError) {
        if (isCurrent) setError(String(caughtError));
      } finally {
        if (isCurrent) setIsLoadingDetail(false);
      }
    }

    if (selectedMemoryId === null) {
      setSelectedMemory(null);
      return () => {
        isCurrent = false;
      };
    }

    void loadMemoryDetail(selectedMemoryId);

    return () => {
      isCurrent = false;
    };
  }, [selectedMemoryId]);

  useLayoutEffect(() => {
    if (!hoveredProject) {
      setHoverCardPosition(null);
      return;
    }

    let animationFrame = 0;
    const updatePosition = () => {
      if (!hoveredProject || !document.body.contains(hoveredProject.anchor)) {
        setHoveredProject(null);
        return;
      }
      const margin = 12;
      const gap = 10;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(320, Math.max(0, viewportWidth - margin * 2));
      const maxHeight = Math.max(0, viewportHeight - margin * 2);
      const anchorRect = hoveredProject.anchor.getBoundingClientRect();
      const measuredHeight = Math.min(
        hoverCardRef.current?.getBoundingClientRect().height ?? 180,
        maxHeight,
      );

      let left = anchorRect.right + gap;
      if (left + width > viewportWidth - margin) {
        left = anchorRect.left - width - gap;
      }
      left = Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - width - margin));
      const top = Math.min(
        Math.max(margin, anchorRect.top),
        Math.max(margin, viewportHeight - measuredHeight - margin),
      );

      setHoverCardPosition((current) => {
        const next = { left, top, width, maxHeight };
        return current &&
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width &&
          current.maxHeight === next.maxHeight
          ? current
          : next;
      });
    };

    updatePosition();
    animationFrame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [hoveredProject]);

  function toggleReadingFocus() {
    if (isReadingFocus) {
      setIsProjectsCollapsed(layoutBeforeFocus.current.projectsCollapsed);
      setIsMemoryListCollapsed(layoutBeforeFocus.current.memoriesCollapsed);
      setIsReadingFocus(false);
      return;
    }

    layoutBeforeFocus.current = {
      projectsCollapsed: isProjectsCollapsed,
      memoriesCollapsed: isMemoryListCollapsed,
    };
    setIsProjectsCollapsed(true);
    setIsMemoryListCollapsed(true);
    setIsReadingFocus(true);
  }

  const titleBar = (
    <AppTitleBar
      age={formatAgeSince(allProjectsFirstMemoryAt)}
      firstMemory={formatDate(allProjectsFirstMemoryAt)}
      isSearchOpen={isToolbarSearchOpen}
      latestActivity={formatDate(allProjectsLatestActivity)}
      memoryCount={allProjectsMemoryCount}
      onQueryChange={setQuery}
      onSearchToggle={() => setIsToolbarSearchOpen((isOpen) => !isOpen)}
      onThemeChange={setReaderTheme}
      query={query}
      theme={readerTheme}
    />
  );

  if (isReadingFocus) {
    return (
      <ReaderCanvas
        isLoading={isLoadingDetail}
        memory={selectedMemory}
        onRestore={toggleReadingFocus}
        theme={readerTheme}
        titleBar={titleBar}
      />
    );
  }

  return (
    <main className={`app-shell flex h-[100dvh] w-[100dvw] flex-col overflow-hidden ${readerTheme === "dark" ? "dark app-theme-dark" : "app-theme-warm"}`}>
      {titleBar}
      <div className="flex min-h-0 flex-1">
        <aside
          data-project-sidebar
          className={`flex h-full shrink-0 flex-col overflow-hidden border-r border-black/10 bg-white/55 backdrop-blur transition-[width,padding] duration-200 ${
            isProjectsCollapsed ? "w-[76px] p-3" : "w-[347px] p-5"
          }`}
        >
          <div className={`flex shrink-0 items-center ${isProjectsCollapsed ? "justify-center" : "justify-between"}`}>
            {!isProjectsCollapsed ? (
              <span className="flex items-center gap-2 text-sm font-semibold">
                <FolderOpen className="size-4 text-[#e45a45]" />
                Projects
              </span>
            ) : null}
            <Button
              className="shrink-0"
              size="icon"
              variant="ghost"
              aria-label={isProjectsCollapsed ? "Expand projects" : "Collapse projects to icons"}
              title={isProjectsCollapsed ? "Expand projects" : "Collapse projects to icons"}
              onClick={() => setIsProjectsCollapsed((isCollapsed) => !isCollapsed)}
            >
              {isProjectsCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </Button>
          </div>

          {isProjectsCollapsed ? (
            <ScrollArea className="mt-4 min-h-0 flex-1">
              <div className="flex flex-col items-center gap-2 pb-3">
                <button
                  className={`flex size-11 items-center justify-center rounded-xl border transition ${
                    selectedProject === null
                      ? "border-black bg-black text-white shadow-sm"
                      : "border-black/10 bg-white/70 hover:bg-white"
                  }`}
                  type="button"
                  aria-label="All projects"
                  title="All projects"
                  onClick={() => setSelectedProject(null)}
                >
                  <Layers3 className="size-5" />
                </button>
                {filteredProjects.map((project) => (
                  <button
                    className={`relative flex size-11 items-center justify-center rounded-xl border transition ${
                      selectedProject === project.name
                        ? "border-black bg-black text-white shadow-sm"
                        : "border-black/10 bg-white/70 hover:bg-white"
                    } ${project.sessionCount === 0 ? "project-no-sessions" : ""}`}
                    key={project.name}
                    type="button"
                    aria-label={project.name}
                    aria-describedby={
                      hoveredProject?.project.name === project.name && hoverCardPosition
                        ? PROJECT_HOVER_CARD_ID
                        : undefined
                    }
                    title={project.name}
                    onClick={() => setSelectedProject(project.name)}
                    onMouseEnter={(event) => setHoveredProject({ project, anchor: event.currentTarget })}
                    onMouseLeave={() => setHoveredProject(null)}
                    onFocus={(event) => setHoveredProject({ project, anchor: event.currentTarget })}
                    onBlur={() => setHoveredProject(null)}
                  >
                    <Folder className="size-5" />
                    {pinnedProjects.includes(project.name) ? (
                      <Pin className="absolute right-0.5 top-0.5 size-3 fill-current" />
                    ) : null}
                  </button>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <>
              <Card className="mt-4 shrink-0 border-black/10 bg-white/75 shadow-sm">
                <button
                  className="flex w-full items-center justify-between gap-3 p-3 text-left text-sm transition hover:bg-white/70"
                  type="button"
                  aria-expanded={isSafeModeExpanded}
                  onClick={() => setIsSafeModeExpanded((isExpanded) => !isExpanded)}
                >
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <ShieldCheck className="size-4 shrink-0 text-emerald-700" />
                    <span>Safe mode</span>
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    Read-only
                  </Badge>
                </button>
                {isSafeModeExpanded ? (
                  <CardContent className="space-y-3 px-3 pb-3 pt-0 text-sm">
                    <p className="text-muted-foreground">
                      SQLite is opened read-only and mutation commands are not exposed.
                    </p>
                    <Separator />
                    <p className="break-all text-xs text-muted-foreground">
                      {databaseInfo?.path ?? "Loading database path..."}
                    </p>
                    <Badge variant="secondary">{formatBytes(databaseInfo?.sizeBytes)}</Badge>
                  </CardContent>
                ) : null}
              </Card>

              <div className="relative mt-5 shrink-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="bg-white/80 pl-9"
                  placeholder="Filter projects"
                  value={projectFilter}
                  onChange={(event) => setProjectFilter(event.currentTarget.value)}
                />
              </div>

              <ScrollArea className="mt-4 min-h-0 flex-1 pr-3">
                <div className="space-y-2">
                  <button
                    className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                      selectedProject === null
                        ? "border-black/20 bg-black text-white shadow-sm"
                        : "border-black/10 bg-white/70 hover:bg-white"
                    }`}
                    type="button"
                    onClick={() => setSelectedProject(null)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">All projects</span>
                      <Badge variant="secondary">
                        {projects.reduce(
                          (total, project) => total + project.observationCount,
                          0,
                        )}
                      </Badge>
                    </div>
                  </button>

                  {isLoadingProjects ? (
                    <p className="px-3 py-8 text-sm text-muted-foreground">
                      Loading projects...
                    </p>
                  ) : (
                    filteredProjects.map((project) => {
                      const isPinned = pinnedProjects.includes(project.name);
                      return (
                        <div
                          className={`project-card group relative w-full rounded-xl border transition ${
                            selectedProject === project.name
                              ? "border-black/20 bg-black text-white shadow-sm"
                              : "border-black/10 bg-white/70 hover:bg-white"
                          } ${project.sessionCount === 0 ? "project-no-sessions" : ""}`}
                          key={project.name}
                          data-selected={selectedProject === project.name}
                        >
                          <button
                            className="w-full px-3 py-3 pr-11 text-left"
                            type="button"
                            aria-describedby={hoveredProject?.project.name === project.name && hoverCardPosition ? PROJECT_HOVER_CARD_ID : undefined}
                            onClick={() => setSelectedProject(project.name)}
                            onMouseEnter={(event) => setHoveredProject({ project, anchor: event.currentTarget })}
                            onMouseLeave={() => setHoveredProject(null)}
                            onFocus={(event) => setHoveredProject({ project, anchor: event.currentTarget })}
                            onBlur={() => setHoveredProject(null)}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="line-clamp-2 break-words text-sm font-medium leading-5">
                                  {project.name}
                                </div>
                                <div className="mt-1 text-xs opacity-70">
                                  {project.sessionCount} sessions / {project.promptCount} prompts
                                </div>
                              </div>
                              <Badge variant="secondary">{project.observationCount}</Badge>
                            </div>
                          </button>
                          <button
                            className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md opacity-70 transition hover:bg-black/10 hover:opacity-100 focus-visible:opacity-100"
                            type="button"
                            aria-label={`${isPinned ? "Unpin" : "Pin"} ${project.name}`}
                            title={isPinned ? "Unpin project" : "Pin project"}
                            onClick={() => toggleProjectPin(project.name)}
                          >
                            <Pin className={`size-3.5 ${isPinned ? "fill-current" : ""}`} />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </aside>

        <section className="flex h-full min-w-0 flex-1 flex-col overflow-hidden p-4 lg:p-6">
          {selectedProject ? (
            <header className="project-summary-bar mb-4 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-black/10 bg-white/65 px-4 py-3 text-sm shadow-sm">
              <span className="flex min-w-0 items-center gap-2 font-medium">
                <FolderOpen className="size-4 shrink-0 text-[#e45a45]" />
                <span className="truncate">{selectedProject}</span>
              </span>
              <strong className="font-semibold">
                {selectedProjectSummary?.observationCount ?? memories.total} memories
              </strong>
              <span className="text-muted-foreground">Latest: {formatDate(latestActivity)}</span>
              <span className="text-muted-foreground">Age: {formatAgeSince(firstMemoryAt)}</span>
            </header>
          ) : null}

          {error ? (
            <Card className="error-card mb-5 border-red-200 bg-red-50 text-red-950">
              <CardContent className="flex items-center justify-between gap-3 p-4 text-sm">
                <span>{error}</span>
                {!isInitialDataReady ? <Button size="sm" variant="outline" onClick={retryInitialLoad}>Retry</Button> : null}
              </CardContent>
            </Card>
          ) : null}

          <div
            className={`grid min-h-0 flex-1 gap-5 ${
              isMemoryListCollapsed
                ? "grid-cols-[72px_minmax(0,1fr)]"
                : "grid-cols-[minmax(300px,420px)_minmax(0,1fr)]"
            }`}
          >
            <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden border-black/10 bg-white/70 shadow-sm">
              <CardHeader className={isMemoryListCollapsed ? "hidden" : "shrink-0 pb-3"}>
                <div className="flex items-center justify-between gap-3">
                  {isMemoryListCollapsed ? (
                    <div className="min-w-0">
                      <CardTitle className="text-sm">List</CardTitle>
                      <CardDescription>{memories.total}</CardDescription>
                    </div>
                  ) : (
                    <div>
                      <CardTitle className="text-base">Memory list</CardTitle>
                      <CardDescription>
                        Page {memories.page} of {totalPages} - {memories.total} found
                      </CardDescription>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {isLoadingMemories ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={
                        isMemoryListCollapsed
                          ? "Expand memory list"
                          : "Collapse memory list"
                      }
                      onClick={() =>
                        setIsMemoryListCollapsed((isCollapsed) => !isCollapsed)
                      }
                    >
                      {isMemoryListCollapsed ? (
                        <ChevronRight className="size-4" />
                      ) : (
                        <ChevronLeft className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
                {!isMemoryListCollapsed ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={sortOrder === "latest" ? "default" : "outline"}
                      onClick={() => setSortOrder("latest")}
                    >
                      Latest first
                    </Button>
                    <Button
                      size="sm"
                      variant={sortOrder === "oldest" ? "default" : "outline"}
                      onClick={() => setSortOrder("oldest")}
                    >
                      Oldest first
                    </Button>
                  </div>
                ) : null}
              </CardHeader>
              {isMemoryListCollapsed ? (
                <CardContent className="flex min-h-0 flex-1 p-2">
                  <button
                    className="flex min-h-0 w-full flex-1 flex-col items-center justify-between gap-3 overflow-hidden rounded-xl border border-black/10 bg-white/65 px-1 py-3 text-xs font-medium text-muted-foreground transition hover:border-black/20 hover:bg-white focus-visible:ring-2 focus-visible:ring-ring"
                    type="button"
                    aria-label="Expand memory list"
                    title="Expand memory list"
                    onClick={() => setIsMemoryListCollapsed(false)}
                  >
                    <ChevronRight className="size-4 shrink-0" />
                    <span className="rotate-180 whitespace-nowrap [writing-mode:vertical-rl]">
                      Show memories
                    </span>
                    <span className="shrink-0 tabular-nums">{memories.items.length}</span>
                  </button>
                </CardContent>
              ) : (
                <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-0 pb-4">
                  <ScrollArea className="min-h-0 min-w-0 flex-1 px-4 pb-6 pr-3">
                    <div className="w-full min-w-0 space-y-3">
                      {memories.items.map((memory) => (
                        <button
                          className={`box-border w-full min-w-0 max-w-full overflow-hidden rounded-xl border p-4 text-left transition ${
                            selectedMemoryId === memory.id
                              ? "border-black/25 bg-black text-white shadow-sm"
                              : "border-black/10 bg-white/70 hover:bg-white"
                          }`}
                          key={memory.id}
                          type="button"
                          onClick={() => setSelectedMemoryId(memory.id)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1 overflow-hidden">
                              <div className="line-clamp-2 break-all font-medium leading-snug text-ellipsis overflow-hidden" title={memory.title}>
                                {memory.title}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs opacity-70">
                                <span>#{memory.id}</span>
                                <span>{memory.memoryType}</span>
                                <span className="truncate">
                                  {sortOrder === "oldest"
                                    ? `Created ${formatDate(memory.createdAt)}`
                                    : `Updated ${formatDate(memory.updatedAt)}`}
                                </span>
                              </div>
                            </div>
                            <Badge variant="secondary" className="shrink min-w-0 max-w-[30%] truncate text-center">
                              {memory.scope}
                            </Badge>
                          </div>
                          <p className="mt-2.5 line-clamp-2 break-all text-xs leading-5 opacity-75 overflow-hidden">
                            {formatCardPreview(memory.preview)}
                          </p>
                        </button>
                      ))}

                      {!isLoadingMemories && memories.items.length === 0 ? (
                        <div className="empty-state rounded-xl border border-dashed bg-white/55 p-8 text-center text-sm text-muted-foreground">
                          No memories match this view.
                        </div>
                      ) : null}
                    </div>
                  </ScrollArea>

                  <div className="mt-4 flex shrink-0 items-center justify-between gap-3 px-4">
                    <Button
                      disabled={page <= 1 || isLoadingMemories}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setPage((currentPage) => Math.max(1, currentPage - 1))
                      }
                    >
                      <ChevronLeft className="size-4" />
                      Previous
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {memories.items.length} shown
                    </span>
                    <Button
                      disabled={page >= totalPages || isLoadingMemories}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setPage((currentPage) => Math.min(totalPages, currentPage + 1))
                      }
                    >
                      Next
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>

            <Card className="memory-detail-card flex min-h-0 flex-col border-black/10 bg-white/75 shadow-sm">
              <CardHeader className="shrink-0 pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <FileText className="size-5" />
                      {selectedMemory?.title ?? "Select a memory"}
                    </CardTitle>
                    <CardDescription className="mt-2">
                      {selectedMemory
                        ? `ID #${selectedMemory.id} / ${selectedMemory.memoryType}`
                        : "Pick a memory from the list to read its full content."}
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isLoadingDetail ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      aria-pressed={isReadingFocus}
                      aria-label={isReadingFocus ? "Restore browser layout" : "Focus reading view"}
                      title={isReadingFocus ? "Restore browser layout" : "Focus reading view"}
                      onClick={toggleReadingFocus}
                    >
                      {isReadingFocus ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                      <span className="hidden sm:inline">{isReadingFocus ? "Restore layout" : "Focus reading"}</span>
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="flex min-h-0 flex-1 flex-col space-y-4 px-5 pb-5">
                {selectedMemory ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-sm xl:grid-cols-4">
                      <MetaItem label="Project" value={selectedMemory.project ?? "-"} />
                      <MetaItem label="Topic" value={selectedMemory.topicKey ?? "-"} />
                      <MetaItem label="Sync ID" value={selectedMemory.syncId ?? "-"} />
                      <MetaItem label="Updated" value={formatDate(selectedMemory.updatedAt)} />
                    </div>

                    <ScrollArea className="memory-content-panel min-h-0 flex-1 rounded-2xl border border-black/10 bg-[#fbfaf7]">
                      <div className={isReadingFocus ? "px-8 py-7 lg:px-12" : "p-5"}>
                        <MarkdownContent content={selectedMemory.content} />
                      </div>
                    </ScrollArea>
                  </>
                ) : (
                  <div className="empty-state flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed bg-white/55 text-sm text-muted-foreground">
                    Nothing selected yet.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </section>
      </div>

      {hoveredProject && hoverCardPosition ? (
        <div
          className="project-hover-card pointer-events-none fixed z-50 overflow-auto rounded-2xl border border-black/15 bg-white p-4 shadow-2xl"
          id={PROJECT_HOVER_CARD_ID}
          ref={hoverCardRef}
          role="tooltip"
          style={{
            left: hoverCardPosition.left,
            top: hoverCardPosition.top,
            width: hoverCardPosition.width,
            maxHeight: hoverCardPosition.maxHeight,
          }}
        >
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-black text-white">
              <Folder className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="break-words font-semibold leading-5">{hoveredProject.project.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {hoveredProject.project.sessionCount} sessions
              </p>
            </div>
          </div>
          <div className="project-hover-card-location mt-4 flex items-start gap-2 rounded-xl bg-[#f7f4ef] p-3 text-sm">
            <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-all text-[#374151]">
              {hoveredProject.project.directory ?? "Project location is not recorded."}
            </span>
          </div>
        </div>
      ) : null}
    </main>
  );
}

interface AppTitleBarProps {
  age: string;
  firstMemory: string;
  isSearchOpen: boolean;
  latestActivity: string;
  memoryCount: number;
  onQueryChange: (query: string) => void;
  onSearchToggle: () => void;
  onThemeChange: (theme: ReaderTheme) => void;
  query: string;
  theme: ReaderTheme;
}

function AppTitleBar({
  age,
  firstMemory,
  isSearchOpen,
  latestActivity,
  memoryCount,
  onQueryChange,
  onSearchToggle,
  onThemeChange,
  query,
  theme,
}: AppTitleBarProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [isMaximized, setIsMaximized] = useState(false);
  const isDark = theme === "dark";

  useEffect(() => {
    let isCurrent = true;
    let unlisten: (() => void) | undefined;
    const syncMaximized = async () => {
      const maximized = await runWindowAction(
        "state sync",
        () => appWindow.isMaximized(),
      );
      if (isCurrent && maximized !== undefined) setIsMaximized(maximized);
    };

    void syncMaximized();
    void runWindowAction(
      "resize listener",
      () => appWindow.onResized(() => void syncMaximized()),
    ).then((stopListening) => {
      if (!stopListening) return;
      if (isCurrent) unlisten = stopListening;
      else stopListening();
    });

    return () => {
      isCurrent = false;
      unlisten?.();
    };
  }, [appWindow]);

  async function toggleWindowMaximize() {
    const toggled = await runWindowAction("maximize toggle", async () => {
      await appWindow.toggleMaximize();
      return true;
    });
    if (!toggled) return;

    const maximized = await runWindowAction(
      "state sync",
      () => appWindow.isMaximized(),
    );
    if (maximized !== undefined) setIsMaximized(maximized);
  }

  return (
    <header className="app-titlebar relative z-40 flex h-12 shrink-0 select-none items-center border-b">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3" data-tauri-drag-region>
        <div className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#e45a45] text-white" data-tauri-drag-region>
            <BookOpen className="size-3.5" />
          </div>
          <span className="truncate text-sm font-semibold" data-tauri-drag-region>EngramView</span>
        </div>
        <div className="titlebar-stat ml-2" title="All projects total memories" data-tauri-drag-region>
          {memoryCount} memories
        </div>
        <div className="titlebar-stat hidden min-[1040px]:block" title={`Latest activity: ${latestActivity}`} data-tauri-drag-region>
          Latest {latestActivity}
        </div>
        <div className="titlebar-stat hidden min-[1180px]:block" title={`First memory: ${firstMemory}; age: ${age}`} data-tauri-drag-region>
          Age {age}
        </div>
        <div className="h-full min-w-3 flex-1" data-tauri-drag-region />
      </div>

      <div className="flex shrink-0 items-center gap-1 px-1">
        {isSearchOpen ? (
          <div className="relative w-[min(30vw,280px)] min-w-40">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              className="h-8 bg-transparent pl-8 text-sm"
              aria-label="Search memories"
              placeholder="Search memories"
              value={query}
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onSearchToggle();
              }}
            />
          </div>
        ) : null}
        <button
          className="titlebar-action"
          type="button"
          aria-expanded={isSearchOpen}
          aria-label={
            isSearchOpen
              ? "Collapse memory search"
              : query.trim()
                ? "Search memories, filter active"
                : "Search memories"
          }
          title={isSearchOpen ? "Collapse memory search" : query.trim() ? "Search memories (filter active)" : "Search memories"}
          onClick={onSearchToggle}
        >
          <Search className="size-4" />
          {query && !isSearchOpen ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-[#e45a45]" /> : null}
        </button>
        <button
          className="titlebar-action"
          type="button"
          aria-label={isDark ? "Use warm theme" : "Use dark theme"}
          title={isDark ? "Use warm theme" : "Use dark theme"}
          onClick={() => onThemeChange(isDark ? "warm" : "dark")}
        >
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>

      <div className="ml-1 flex h-full shrink-0">
        <button className="window-control" type="button" aria-label="Minimize window" title="Minimize" onClick={() => void runWindowAction("minimize", () => appWindow.minimize())}>
          <Minus className="size-4" />
        </button>
        <button className="window-control" type="button" aria-label={isMaximized ? "Restore window" : "Maximize window"} title={isMaximized ? "Restore" : "Maximize"} onClick={() => void toggleWindowMaximize()}>
          {isMaximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
        </button>
        <button className="window-control window-control-close" type="button" aria-label="Close window" title="Close" onClick={() => void runWindowAction("close", () => appWindow.close())}>
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}

interface ReaderCanvasProps {
  isLoading: boolean;
  memory: MemoryDetail | null;
  onRestore: () => void;
  theme: ReaderTheme;
  titleBar: ReactNode;
}

function ReaderCanvas({
  isLoading,
  memory,
  onRestore,
  theme,
  titleBar,
}: ReaderCanvasProps) {
  const isDark = theme === "dark";

  return (
    <main
      className={`app-shell reader-canvas flex h-[100dvh] w-[100dvw] flex-col overflow-hidden ${
        isDark ? "dark app-theme-dark reader-canvas-dark" : "app-theme-warm reader-canvas-warm"
      }`}
    >
      {titleBar}
      <header className="reader-toolbar flex h-14 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-x-4 overflow-hidden text-sm">
          <div className="min-w-0">
            <p className="reader-toolbar-label text-[0.68rem] font-semibold uppercase tracking-wider">
              Memory
            </p>
            <p className="truncate font-medium">
              {memory ? `#${memory.id} / ${memory.memoryType}` : "Nothing selected"}
            </p>
          </div>
          {memory ? (
            <>
              <ToolbarMeta label="Project" value={memory.project ?? "-"} />
              <ToolbarMeta className="hidden md:block" label="Topic" value={memory.topicKey ?? "-"} />
              <ToolbarMeta className="hidden xl:block" label="Updated" value={formatDate(memory.updatedAt)} />
            </>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isLoading ? <Loader2 className="size-4 animate-spin opacity-60" /> : null}
          <Button
            className={isDark ? "border-white/15 bg-white/5 text-white hover:bg-white/10" : "bg-[#eee4d5] hover:bg-[#e5d8c5]"}
            size="sm"
            variant="outline"
            aria-label="Restore browser layout"
            title="Restore browser layout"
            onClick={onRestore}
          >
            <Minimize2 className="size-4" />
            <span className="hidden sm:inline">Restore layout</span>
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {memory ? (
          <div className="mx-auto w-full max-w-[900px] px-5 py-8 sm:px-8 sm:py-12 lg:px-12">
            <header className="reader-article-header mb-8 border-b pb-6">
              <p className="reader-article-id text-sm font-medium">
                ID #{memory.id} / {memory.memoryType}
              </p>
              <h1 className="mt-2 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
                {memory.title}
              </h1>
              <div className="mt-5 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <ReaderMeta label="Project" value={memory.project ?? "-"} />
                <ReaderMeta label="Topic" value={memory.topicKey ?? "-"} />
                <ReaderMeta label="Sync ID" value={memory.syncId ?? "-"} />
                <ReaderMeta label="Updated" value={formatDate(memory.updatedAt)} />
              </div>
            </header>
            <MarkdownContent content={memory.content} />
          </div>
        ) : (
          <div className="flex h-full min-h-80 items-center justify-center p-8 text-sm opacity-60">
            Nothing selected yet.
          </div>
        )}
      </ScrollArea>
    </main>
  );
}


function ToolbarMeta({ className = "", label, value }: { className?: string; label: string; value: string }) {
  return (
    <div className={`min-w-0 max-w-52 ${className}`}>
      <p className="reader-toolbar-label text-[0.68rem] font-semibold uppercase tracking-wider">{label}</p>
      <p className="truncate font-medium" title={value}>{value}</p>
    </div>
  );
}

function ReaderMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="reader-meta min-w-0 rounded-xl border p-3">
      <div className="reader-meta-label text-[0.68rem] font-semibold uppercase tracking-wider">
        {label}
      </div>
      <div className="mt-1 truncate font-medium" title={value}>{value}</div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-item min-w-0 rounded-xl border border-black/10 bg-white/65 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

export default App;
