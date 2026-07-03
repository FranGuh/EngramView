import { invoke } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  FolderOpen,
  Loader2,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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

const PAGE_SIZE = 24;

type SortOrder = "latest" | "oldest";

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

function App() {
  const [databaseInfo, setDatabaseInfo] = useState<DatabaseInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [isSafeModeExpanded, setIsSafeModeExpanded] = useState(false);
  const [isMemoryListCollapsed, setIsMemoryListCollapsed] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [page, setPage] = useState(1);
  const [sortOrder, setSortOrder] = useState<SortOrder>("latest");
  const [memories, setMemories] = useState<PagedMemories>({
    items: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
  });
  const [selectedMemoryId, setSelectedMemoryId] = useState<number | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<MemoryDetail | null>(null);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isLoadingMemories, setIsLoadingMemories] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredProjects = useMemo(() => {
    const normalizedFilter = projectFilter.trim().toLowerCase();

    if (!normalizedFilter) return projects;

    return projects.filter((project) =>
      project.name.toLowerCase().includes(normalizedFilter),
    );
  }, [projectFilter, projects]);

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
        const [database, projectList] = await Promise.all([
          invoke<DatabaseInfo>("get_database_info"),
          invoke<ProjectSummary[]>("list_projects"),
        ]);

        if (!isCurrent) return;

        setDatabaseInfo(database);
        setProjects(projectList);
        setSelectedProject(projectList[0]?.name ?? null);
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
  }, []);

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, selectedProject, sortOrder]);

  useEffect(() => {
    let isCurrent = true;

    async function loadMemories() {
      setIsLoadingMemories(true);
      setError(null);

      try {
        const response = await invoke<PagedMemories>("list_memories", {
          request: {
            project: selectedProject,
            query: debouncedQuery,
            page,
            pageSize: PAGE_SIZE,
            sortOrder,
          },
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
  }, [debouncedQuery, page, selectedProject, sortOrder]);

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

  return (
    <main className="h-screen overflow-hidden bg-[#f7f4ef] text-[#1f2933]">
      <div className="flex h-full min-h-0">
        <aside className="flex h-full w-[340px] shrink-0 flex-col overflow-hidden border-r border-black/10 bg-white/55 p-5 backdrop-blur">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Database className="size-4" />
              Local reader
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">EngramView</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              Read-only memory browser grouped by project.
            </p>
          </div>

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
                filteredProjects.map((project) => (
                  <button
                    className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                      selectedProject === project.name
                        ? "border-black/20 bg-black text-white shadow-sm"
                        : "border-black/10 bg-white/70 hover:bg-white"
                    }`}
                    key={project.name}
                    type="button"
                    onClick={() => setSelectedProject(project.name)}
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
                ))
              )}
            </div>
          </ScrollArea>
        </aside>

        <section className="flex h-full min-w-0 flex-1 flex-col overflow-hidden p-6">
          <header className="mb-5 shrink-0 items-start justify-between gap-4 space-y-4 xl:flex xl:space-y-0">
            <div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FolderOpen className="size-4" />
                {selectedProject ?? "All projects"}
              </div>
              <h2 className="mt-1 text-3xl font-semibold tracking-tight">
                {selectedProjectSummary?.observationCount ?? memories.total} memories
              </h2>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>Latest activity: {formatDate(latestActivity)}</span>
                <span>First memory: {formatDate(firstMemoryAt)}</span>
                <span>Project age: {formatAgeSince(firstMemoryAt)}</span>
              </div>
            </div>

            <div className="relative w-[360px] max-w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="bg-white/80 pl-9"
                placeholder="Search title, content, type, or topic"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
          </header>

          {error ? (
            <Card className="mb-5 border-red-200 bg-red-50 text-red-950">
              <CardContent className="p-4 text-sm">{error}</CardContent>
            </Card>
          ) : null}

          <div
            className={`grid min-h-0 flex-1 gap-5 ${
              isMemoryListCollapsed
                ? "grid-cols-[minmax(76px,92px)_1fr]"
                : "grid-cols-[minmax(340px,440px)_1fr]"
            }`}
          >
            <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden border-black/10 bg-white/70 shadow-sm">
              <CardHeader className="shrink-0 pb-3">
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
                <CardContent className="flex min-h-0 flex-1 flex-col items-center justify-between gap-3 px-3 pb-4">
                  <button
                    className="flex w-full flex-1 items-center justify-center rounded-xl border border-black/10 bg-white/60 px-2 text-xs font-medium text-muted-foreground transition hover:bg-white"
                    type="button"
                    onClick={() => setIsMemoryListCollapsed(false)}
                  >
                    <span className="-rotate-90 whitespace-nowrap">Show memories</span>
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {memories.items.length} shown
                  </span>
                </CardContent>
              ) : (
                <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-0 pb-4">
                  <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 pr-5">
                    <div className="space-y-3">
                      {memories.items.map((memory) => (
                        <button
                          className={`box-border w-full max-w-full rounded-xl border p-4 text-left transition ${
                            selectedMemoryId === memory.id
                              ? "border-black/25 bg-black text-white shadow-sm"
                              : "border-black/10 bg-white/70 hover:bg-white"
                          }`}
                          key={memory.id}
                          type="button"
                          onClick={() => setSelectedMemoryId(memory.id)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{memory.title}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs opacity-70">
                                <span>#{memory.id}</span>
                                <span>{memory.memoryType}</span>
                                <span>
                                  {sortOrder === "oldest"
                                    ? `Created ${formatDate(memory.createdAt)}`
                                    : `Updated ${formatDate(memory.updatedAt)}`}
                                </span>
                              </div>
                            </div>
                            <Badge variant="secondary" className="shrink-0">
                              {memory.scope}
                            </Badge>
                          </div>
                          <p className="mt-3 line-clamp-3 text-sm leading-6 opacity-75">
                            {memory.preview || "No preview available."}
                          </p>
                        </button>
                      ))}

                      {!isLoadingMemories && memories.items.length === 0 ? (
                        <div className="rounded-xl border border-dashed bg-white/55 p-8 text-center text-sm text-muted-foreground">
                          No memories match this view.
                        </div>
                      ) : null}
                    </div>
                  </div>

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

            <Card className="flex min-h-0 flex-col border-black/10 bg-white/75 shadow-sm">
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
                  {isLoadingDetail ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : null}
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

                    <ScrollArea className="min-h-0 flex-1 rounded-2xl border border-black/10 bg-[#fbfaf7]">
                      <pre className="whitespace-pre-wrap break-words p-5 text-sm leading-7 text-[#25313d]">
                        {selectedMemory.content}
                      </pre>
                    </ScrollArea>
                  </>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed bg-white/55 text-sm text-muted-foreground">
                    Nothing selected yet.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </main>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-black/10 bg-white/65 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

export default App;
