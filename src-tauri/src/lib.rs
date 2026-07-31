use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env, fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseInfo {
    path: String,
    exists: bool,
    size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    name: String,
    observation_count: i64,
    session_count: i64,
    prompt_count: i64,
    latest_activity: Option<String>,
    first_memory_at: Option<String>,
    directory: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemorySummary {
    id: i64,
    sync_id: Option<String>,
    session_id: String,
    memory_type: String,
    title: String,
    preview: String,
    project: Option<String>,
    scope: String,
    topic_key: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryDetail {
    id: i64,
    sync_id: Option<String>,
    session_id: String,
    memory_type: String,
    title: String,
    content: String,
    tool_name: Option<String>,
    project: Option<String>,
    scope: String,
    topic_key: Option<String>,
    revision_count: i64,
    duplicate_count: i64,
    last_seen_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryQuery {
    project: Option<String>,
    query: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
    sort_order: Option<SortOrder>,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum SortOrder {
    Latest,
    Oldest,
}

impl Default for SortOrder {
    fn default() -> Self {
        Self::Latest
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PagedMemories {
    items: Vec<MemorySummary>,
    total: i64,
    page: u32,
    page_size: u32,
}

const PROMPT_PAGE_SIZE_DEFAULT: u32 = 30;
const PROMPT_PAGE_SIZE_MAX: u32 = 100;
const PROMPT_PAGE_MAX: u32 = 50_000;
const MAX_PROMPT_CONTENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptQuery {
    project: String,
    page: Option<u32>,
    page_size: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptSummary {
    id: i64,
    sync_id: Option<String>,
    session_id: String,
    preview: String,
    project: Option<String>,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PagedPrompts {
    items: Vec<PromptSummary>,
    total: i64,
    page: u32,
    page_size: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptRequest {
    project: String,
    id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptDetail {
    id: i64,
    sync_id: Option<String>,
    session_id: String,
    content: String,
    project: Option<String>,
    created_at: String,
}

const ADR_DIRECTORY: &str = "docs/adr";
const MAX_ADR_DOCUMENTS: usize = 500;
const MAX_ADR_DOCUMENT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ADR_PATH_BYTES: usize = 1_024;
const MAX_PROJECT_NAME_BYTES: usize = 1_024;

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AdrDocumentsStatus {
    Available,
    MissingRoot,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AdrDocumentSummary {
    path: String,
    name: String,
    title: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AdrDocumentsIndex {
    status: AdrDocumentsStatus,
    items: Vec<AdrDocumentSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdrDocumentDetail {
    path: String,
    name: String,
    title: String,
    size_bytes: u64,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdrDocumentRequest {
    project: String,
    path: String,
}

fn validate_project_name(project: &str) -> Result<&str, String> {
    let trimmed = project.trim();
    if trimmed.is_empty() {
        return Err("A project must be selected before loading ADR documents".to_string());
    }
    if trimmed.len() > MAX_PROJECT_NAME_BYTES {
        return Err("Project name is too long".to_string());
    }
    if trimmed.chars().any(|character| character.is_control()) {
        return Err("Project name contains unsupported control characters".to_string());
    }
    Ok(trimmed)
}

fn validate_relative_adr_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("ADR path cannot be empty".to_string());
    }
    if path.as_os_str().to_string_lossy().len() > MAX_ADR_PATH_BYTES {
        return Err("ADR path is too long".to_string());
    }
    let raw_path = path.as_os_str().to_string_lossy();
    let looks_like_windows_absolute = raw_path.len() >= 3
        && raw_path.as_bytes()[1] == b':'
        && matches!(raw_path.as_bytes()[2], b'\\' | b'/');
    if path.is_absolute()
        || raw_path.starts_with("\\\\")
        || raw_path.starts_with("//")
        || looks_like_windows_absolute
    {
        return Err("Absolute ADR paths are not allowed".to_string());
    }

    let mut has_normal_component = false;
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                has_normal_component = true;
                if value
                    .to_string_lossy()
                    .chars()
                    .any(|character| character.is_control())
                {
                    return Err("ADR path contains unsupported control characters".to_string());
                }
            }
            Component::ParentDir => return Err("ADR paths cannot contain '..'".to_string()),
            Component::CurDir => return Err("ADR paths cannot contain '.' segments".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("Absolute ADR paths are not allowed".to_string())
            }
        }
    }
    if !has_normal_component {
        return Err("ADR path is invalid".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "ADR path must have a .md extension".to_string())?;
    if !extension.eq_ignore_ascii_case("md") {
        return Err("Only Markdown ADR files (.md) are allowed".to_string());
    }
    Ok(())
}

fn canonicalize_confined_path(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        format!(
            "Could not canonicalize ADR root {}: {error}",
            root.display()
        )
    })?;
    let canonical_candidate = fs::canonicalize(candidate).map_err(|error| {
        format!(
            "Could not canonicalize ADR path {}: {error}",
            candidate.display()
        )
    })?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!(
            "ADR path {} resolves outside the docs/adr root",
            candidate.display()
        ));
    }
    Ok(canonical_candidate)
}

fn readable_adr_title(path: &Path) -> String {
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("ADR");
    let without_number = name
        .trim_start_matches(|character: char| {
            character.is_ascii_digit() || character == '-' || character == '_' || character == ' '
        })
        .trim();
    let title = if without_number.is_empty() {
        name
    } else {
        without_number
    };
    title
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn document_summary(root: &Path, canonical_file: &Path) -> Result<AdrDocumentSummary, String> {
    let metadata = fs::metadata(canonical_file).map_err(|error| {
        format!(
            "Could not inspect ADR {}: {error}",
            canonical_file.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "ADR path {} is not a regular file",
            canonical_file.display()
        ));
    }
    if metadata.len() > MAX_ADR_DOCUMENT_BYTES {
        return Err(format!(
            "ADR {} exceeds the {} MiB size limit",
            canonical_file.display(),
            MAX_ADR_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    let relative = canonical_file.strip_prefix(root).map_err(|_| {
        format!(
            "ADR path {} is outside the docs/adr root",
            canonical_file.display()
        )
    })?;
    let path = relative.to_string_lossy().replace('\\', "/");
    validate_relative_adr_path(Path::new(&path))?;
    let name = relative
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "ADR filename is not valid UTF-8".to_string())?
        .to_string();
    Ok(AdrDocumentSummary {
        path,
        name,
        title: readable_adr_title(relative),
        size_bytes: metadata.len(),
    })
}

fn collect_adr_documents(
    root: &Path,
    current: &Path,
    items: &mut Vec<AdrDocumentSummary>,
    visited_directories: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let canonical_current = canonicalize_confined_path(root, current)?;
    let current_metadata = fs::metadata(&canonical_current).map_err(|error| {
        format!(
            "Could not inspect ADR directory {}: {error}",
            current.display()
        )
    })?;
    if !current_metadata.is_dir() {
        return Err(format!("ADR root {} is not a directory", current.display()));
    }
    if !visited_directories.insert(canonical_current.clone()) {
        return Ok(());
    }
    for entry in fs::read_dir(&canonical_current).map_err(|error| {
        format!(
            "Could not list ADR directory {}: {error}",
            canonical_current.display()
        )
    })? {
        let entry =
            entry.map_err(|error| format!("Could not read ADR directory entry: {error}"))?;
        let candidate = entry.path();
        let canonical_candidate = canonicalize_confined_path(root, &candidate)?;
        let metadata = fs::metadata(&canonical_candidate)
            .map_err(|error| format!("Could not inspect ADR {}: {error}", candidate.display()))?;
        if metadata.is_dir() {
            collect_adr_documents(root, &canonical_candidate, items, visited_directories)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let extension_is_markdown = canonical_candidate
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("md"));
        if !extension_is_markdown {
            continue;
        }
        if items.len() >= MAX_ADR_DOCUMENTS {
            return Err(format!(
                "The docs/adr directory contains more than {MAX_ADR_DOCUMENTS} Markdown files"
            ));
        }
        items.push(document_summary(root, &canonical_candidate)?);
    }
    Ok(())
}

fn list_adr_documents_from_root(root: &Path) -> Result<AdrDocumentsIndex, String> {
    if !root.exists() {
        return Ok(AdrDocumentsIndex {
            status: AdrDocumentsStatus::MissingRoot,
            items: Vec::new(),
        });
    }
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        format!(
            "Could not canonicalize docs/adr root {}: {error}",
            root.display()
        )
    })?;
    if !fs::metadata(&canonical_root)
        .map_err(|error| {
            format!(
                "Could not inspect docs/adr root {}: {error}",
                root.display()
            )
        })?
        .is_dir()
    {
        return Ok(AdrDocumentsIndex {
            status: AdrDocumentsStatus::MissingRoot,
            items: Vec::new(),
        });
    }
    let mut items = Vec::new();
    collect_adr_documents(
        &canonical_root,
        &canonical_root,
        &mut items,
        &mut HashSet::new(),
    )?;
    items.sort_by(|first, second| first.path.cmp(&second.path));
    Ok(AdrDocumentsIndex {
        status: AdrDocumentsStatus::Available,
        items,
    })
}

fn resolve_project_directory(conn: &Connection, project: &str) -> Result<Option<PathBuf>, String> {
    conn.query_row(
        r#"
        SELECT directory
        FROM sessions
        WHERE project = ?1 AND directory IS NOT NULL AND trim(directory) <> ''
        ORDER BY datetime(started_at) DESC, id DESC
        LIMIT 1
        "#,
        params![project],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("Failed to resolve project directory: {error}"))
    .map(|directory| directory.map(PathBuf::from))
}

fn resolve_adr_root(conn: &Connection, project: &str) -> Result<Option<PathBuf>, String> {
    let Some(project_directory) = resolve_project_directory(conn, project)? else {
        return Ok(None);
    };
    let canonical_project_directory = match fs::canonicalize(&project_directory) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    let candidate_root = canonical_project_directory.join(ADR_DIRECTORY);
    if !candidate_root.exists() {
        return Ok(None);
    }
    let canonical_root = fs::canonicalize(&candidate_root)
        .map_err(|error| format!("Could not canonicalize docs/adr root: {error}"))?;
    if !canonical_root.starts_with(&canonical_project_directory) {
        return Err(
            "The docs/adr root resolves outside the selected project directory".to_string(),
        );
    }
    if !fs::metadata(&canonical_root)
        .map_err(|error| format!("Could not inspect docs/adr root: {error}"))?
        .is_dir()
    {
        return Ok(None);
    }
    Ok(Some(canonical_root))
}

fn list_project_adr_documents_impl(project: &str) -> Result<AdrDocumentsIndex, String> {
    let project = validate_project_name(project)?;
    let conn = open_engram_readonly()?;
    let Some(root) = resolve_adr_root(&conn, project)? else {
        return Ok(AdrDocumentsIndex {
            status: AdrDocumentsStatus::MissingRoot,
            items: Vec::new(),
        });
    };
    list_adr_documents_from_root(&root)
}

fn read_project_adr_document_impl(
    project: &str,
    relative_path: &str,
) -> Result<AdrDocumentDetail, String> {
    let project = validate_project_name(project)?;
    let relative_path = PathBuf::from(relative_path);
    validate_relative_adr_path(&relative_path)?;
    let conn = open_engram_readonly()?;
    let Some(root) = resolve_adr_root(&conn, project)? else {
        return Err(format!(
            "Project {project} does not have a docs/adr directory"
        ));
    };
    let canonical_file = canonicalize_confined_path(&root, &root.join(&relative_path))?;
    let summary = document_summary(&root, &canonical_file)?;
    let bytes = fs::read(&canonical_file)
        .map_err(|error| format!("Could not read ADR {}: {error}", summary.path))?;
    if bytes.len() as u64 > MAX_ADR_DOCUMENT_BYTES {
        return Err(format!(
            "ADR {} exceeds the {} MiB size limit",
            summary.path,
            MAX_ADR_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| format!("ADR {} is not valid UTF-8", summary.path))?;
    Ok(AdrDocumentDetail {
        path: summary.path,
        name: summary.name,
        title: summary.title,
        size_bytes: summary.size_bytes,
        content,
    })
}

#[tauri::command]
fn list_project_adr_documents(project: String) -> Result<AdrDocumentsIndex, String> {
    list_project_adr_documents_impl(&project)
}

#[tauri::command]
fn read_project_adr_document(request: AdrDocumentRequest) -> Result<AdrDocumentDetail, String> {
    read_project_adr_document_impl(&request.project, &request.path)
}

fn prompt_list_sql() -> &'static str {
    r#"
        SELECT id, sync_id, session_id, substr(content, 1, 520), project, created_at
        FROM user_prompts
        WHERE project = ?1
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?2 OFFSET ?3
    "#
}

fn prompt_page_parameters(page: Option<u32>, page_size: Option<u32>) -> (u32, u32, i64) {
    let page = page.unwrap_or(1).clamp(1, PROMPT_PAGE_MAX);
    let page_size = page_size
        .unwrap_or(PROMPT_PAGE_SIZE_DEFAULT)
        .clamp(1, PROMPT_PAGE_SIZE_MAX);
    let offset = i64::from(page - 1) * i64::from(page_size);
    (page, page_size, offset)
}

fn prompt_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptSummary> {
    Ok(PromptSummary {
        id: row.get(0)?,
        sync_id: row.get(1)?,
        session_id: row.get(2)?,
        preview: compact_preview(row.get(3)?),
        project: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn list_prompts_from_connection(
    conn: &Connection,
    project: &str,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<PagedPrompts, String> {
    let project = validate_project_name(project)?;
    let (page, page_size, offset) = prompt_page_parameters(page, page_size);
    let total = conn
        .query_row(
            "SELECT COUNT(*) FROM user_prompts WHERE project = ?1",
            params![project],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Failed to count project prompts: {error}"))?;

    let mut statement = conn
        .prepare(prompt_list_sql())
        .map_err(|error| format!("Failed to prepare project prompt query: {error}"))?;
    let items = statement
        .query_map(
            params![project, i64::from(page_size), offset],
            prompt_summary_from_row,
        )
        .map_err(|error| format!("Failed to list project prompts: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read project prompt row: {error}"))?;

    Ok(PagedPrompts {
        items,
        total,
        page,
        page_size,
    })
}

fn get_prompt_from_connection(
    conn: &Connection,
    project: &str,
    id: i64,
) -> Result<Option<PromptDetail>, String> {
    let project = validate_project_name(project)?;
    conn.query_row(
        r#"
        SELECT id, sync_id, session_id, content, project, created_at
        FROM user_prompts
        WHERE id = ?1 AND project = ?2
        "#,
        params![id, project],
        |row| {
            Ok(PromptDetail {
                id: row.get(0)?,
                sync_id: row.get(1)?,
                session_id: row.get(2)?,
                content: row.get(3)?,
                project: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("Failed to load project prompt {id}: {error}"))
}

fn list_project_prompts_impl(request: PromptQuery) -> Result<PagedPrompts, String> {
    let project = validate_project_name(&request.project)?;
    let conn = open_engram_readonly()?;
    list_prompts_from_connection(&conn, project, request.page, request.page_size)
}

fn read_project_prompt_impl(request: PromptRequest) -> Result<PromptDetail, String> {
    let project = validate_project_name(&request.project)?;
    if request.id <= 0 {
        return Err("Prompt ID must be positive".to_string());
    }
    let conn = open_engram_readonly()?;
    let Some(prompt) = get_prompt_from_connection(&conn, project, request.id)? else {
        return Err(format!(
            "Prompt {} was not found for project {}",
            request.id, project
        ));
    };
    if prompt.content.len() > MAX_PROMPT_CONTENT_BYTES {
        return Err(format!(
            "Prompt {} exceeds the {} MiB size limit",
            request.id,
            MAX_PROMPT_CONTENT_BYTES / (1024 * 1024)
        ));
    }
    Ok(prompt)
}

#[tauri::command]
fn list_project_prompts(request: PromptQuery) -> Result<PagedPrompts, String> {
    list_project_prompts_impl(request)
}

#[tauri::command]
fn read_project_prompt(request: PromptRequest) -> Result<PromptDetail, String> {
    read_project_prompt_impl(request)
}

fn engram_db_path() -> Result<PathBuf, String> {
    if let Ok(data_dir) = env::var("ENGRAM_DATA_DIR") {
        return Ok(PathBuf::from(data_dir).join("engram.db"));
    }

    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .map_err(|_| {
            "Could not resolve USERPROFILE or HOME for Engram data directory".to_string()
        })?;

    Ok(PathBuf::from(home).join(".engram").join("engram.db"))
}

fn open_engram_readonly() -> Result<Connection, String> {
    let db_path = engram_db_path()?;

    if !db_path.exists() {
        return Err(format!(
            "Engram database not found at {}",
            db_path.display()
        ));
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Failed to open Engram database read-only: {error}"))?;

    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Failed to set SQLite busy timeout: {error}"))?;
    conn.pragma_update(None, "query_only", true)
        .map_err(|error| format!("Failed to enable SQLite query_only mode: {error}"))?;

    Ok(conn)
}

fn normalize_optional_filter(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn normalize_query(query: Option<String>) -> String {
    query
        .unwrap_or_default()
        .trim()
        .chars()
        .take(160)
        .collect::<String>()
        .to_lowercase()
}

fn fts_term(raw: &str) -> Option<String> {
    let term = raw
        .trim_matches(|character: char| character.is_ascii_punctuation())
        .chars()
        .filter(|character| !character.is_control() && *character != '"')
        .collect::<String>();

    if term.is_empty() {
        None
    } else {
        Some(format!("\"{}\"", term.replace('"', "\"\"")))
    }
}

fn build_fts_query(query: &str) -> Option<String> {
    let terms = query
        .split_whitespace()
        .filter_map(fts_term)
        .collect::<Vec<_>>();

    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" AND "))
    }
}

fn compact_preview(content: String) -> String {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");

    if compact.chars().count() > 260 {
        format!("{}...", compact.chars().take(260).collect::<String>())
    } else {
        compact
    }
}

#[tauri::command]
fn get_database_info() -> Result<DatabaseInfo, String> {
    let path = engram_db_path()?;
    let metadata = fs::metadata(&path).ok();

    Ok(DatabaseInfo {
        path: path.display().to_string(),
        exists: path.exists(),
        size_bytes: metadata.map(|item| item.len()),
    })
}

#[tauri::command]
fn list_projects() -> Result<Vec<ProjectSummary>, String> {
    let conn = open_engram_readonly()?;

    let mut statement = conn
        .prepare(
            r#"
            WITH projects(project) AS (
                SELECT project FROM observations WHERE project IS NOT NULL AND project <> ''
                UNION
                SELECT project FROM sessions WHERE project IS NOT NULL AND project <> ''
                UNION
                SELECT project FROM user_prompts WHERE project IS NOT NULL AND project <> ''
            ),
            observation_counts AS (
                SELECT project, COUNT(*) AS observation_count
                FROM observations
                WHERE project IS NOT NULL AND project <> '' AND deleted_at IS NULL
                GROUP BY project
            ),
            session_counts AS (
                SELECT project, COUNT(*) AS session_count
                FROM sessions
                WHERE project IS NOT NULL AND project <> ''
                GROUP BY project
            ),
            prompt_counts AS (
                SELECT project, COUNT(*) AS prompt_count
                FROM user_prompts
                WHERE project IS NOT NULL AND project <> ''
                GROUP BY project
            ),
            first_memory AS (
                SELECT project, MIN(created_at) AS first_memory_at
                FROM observations
                WHERE project IS NOT NULL AND project <> '' AND deleted_at IS NULL
                GROUP BY project
            ),
            project_directories AS (
                SELECT project, directory
                FROM (
                    SELECT
                        project,
                        directory,
                        ROW_NUMBER() OVER (
                            PARTITION BY project
                            ORDER BY started_at DESC, id DESC
                        ) AS row_number
                    FROM sessions
                    WHERE project IS NOT NULL AND project <> '' AND directory <> ''
                )
                WHERE row_number = 1
            ),
            activity AS (
                SELECT project, MAX(ts) AS latest_activity
                FROM (
                    SELECT project, updated_at AS ts
                    FROM observations
                    WHERE project IS NOT NULL AND project <> '' AND deleted_at IS NULL
                    UNION ALL
                    SELECT project, started_at AS ts
                    FROM sessions
                    WHERE project IS NOT NULL AND project <> ''
                    UNION ALL
                    SELECT project, created_at AS ts
                    FROM user_prompts
                    WHERE project IS NOT NULL AND project <> ''
                )
                WHERE ts IS NOT NULL
                GROUP BY project
            )
            SELECT
                p.project,
                COALESCE(oc.observation_count, 0) AS observation_count,
                COALESCE(sc.session_count, 0) AS session_count,
                COALESCE(pc.prompt_count, 0) AS prompt_count,
                activity.latest_activity,
                first_memory.first_memory_at,
                project_directories.directory
            FROM projects p
            LEFT JOIN observation_counts oc ON oc.project = p.project
            LEFT JOIN session_counts sc ON sc.project = p.project
            LEFT JOIN prompt_counts pc ON pc.project = p.project
            LEFT JOIN activity ON activity.project = p.project
            LEFT JOIN first_memory ON first_memory.project = p.project
            LEFT JOIN project_directories ON project_directories.project = p.project
            ORDER BY observation_count DESC, session_count DESC, prompt_count DESC, p.project ASC
            "#,
        )
        .map_err(|error| format!("Failed to prepare project query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(ProjectSummary {
                name: row.get(0)?,
                observation_count: row.get(1)?,
                session_count: row.get(2)?,
                prompt_count: row.get(3)?,
                latest_activity: row.get(4)?,
                first_memory_at: row.get(5)?,
                directory: row.get(6)?,
            })
        })
        .map_err(|error| format!("Failed to list projects: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read project row: {error}"))
}

#[tauri::command]
fn list_memories(request: MemoryQuery) -> Result<PagedMemories, String> {
    let conn = open_engram_readonly()?;
    let snapshot = conn
        .unchecked_transaction()
        .map_err(|error| format!("Failed to start read snapshot: {error}"))?;
    let project = normalize_optional_filter(request.project);
    let query = normalize_query(request.query);
    let page_size = request.page_size.unwrap_or(30).clamp(10, 100);
    let page = request.page.unwrap_or(1).clamp(1, 50_000);
    let offset = i64::from(page - 1) * i64::from(page_size);
    let sort_order = request.sort_order.unwrap_or_default();

    if query.is_empty() {
        return list_memories_without_search(
            &snapshot,
            project.as_deref(),
            page,
            page_size,
            offset,
            sort_order,
        );
    }

    let Some(fts_query) = build_fts_query(&query) else {
        return Ok(PagedMemories {
            items: Vec::new(),
            total: 0,
            page,
            page_size,
        });
    };

    list_memories_with_search(
        &snapshot,
        project.as_deref(),
        &fts_query,
        page,
        page_size,
        offset,
        sort_order,
    )
}

fn memory_list_sql(project: Option<&str>, sort_order: SortOrder) -> &'static str {
    match (project.is_some(), sort_order) {
        (true, SortOrder::Latest) => {
            r#"
            SELECT id, sync_id, session_id, type, title,
                   substr(content, 1, 520), project, scope, topic_key, created_at, updated_at
            FROM observations
            WHERE deleted_at IS NULL AND project = ?1
            ORDER BY datetime(updated_at) DESC, id DESC
            LIMIT ?2 OFFSET ?3
        "#
        }
        (true, SortOrder::Oldest) => {
            r#"
            SELECT id, sync_id, session_id, type, title,
                   substr(content, 1, 520), project, scope, topic_key, created_at, updated_at
            FROM observations
            WHERE deleted_at IS NULL AND project = ?1
            ORDER BY datetime(created_at) ASC, id ASC
            LIMIT ?2 OFFSET ?3
        "#
        }
        (false, SortOrder::Latest) => {
            r#"
            SELECT id, sync_id, session_id, type, title,
                   substr(content, 1, 520), project, scope, topic_key, created_at, updated_at
            FROM observations
            WHERE deleted_at IS NULL
            ORDER BY datetime(updated_at) DESC, id DESC
            LIMIT ?1 OFFSET ?2
        "#
        }
        (false, SortOrder::Oldest) => {
            r#"
            SELECT id, sync_id, session_id, type, title,
                   substr(content, 1, 520), project, scope, topic_key, created_at, updated_at
            FROM observations
            WHERE deleted_at IS NULL
            ORDER BY datetime(created_at) ASC, id ASC
            LIMIT ?1 OFFSET ?2
        "#
        }
    }
}

fn list_memories_without_search(
    conn: &Connection,
    project: Option<&str>,
    page: u32,
    page_size: u32,
    offset: i64,
    sort_order: SortOrder,
) -> Result<PagedMemories, String> {
    let total = match project {
        Some(project) => conn.query_row(
            "SELECT COUNT(*) FROM observations WHERE deleted_at IS NULL AND project = ?1",
            params![project],
            |row| row.get::<_, i64>(0),
        ),
        None => conn.query_row(
            "SELECT COUNT(*) FROM observations WHERE deleted_at IS NULL",
            [],
            |row| row.get::<_, i64>(0),
        ),
    }
    .map_err(|error| format!("Failed to count memories: {error}"))?;

    let mut statement = conn
        .prepare(memory_list_sql(project, sort_order))
        .map_err(|error| format!("Failed to prepare memory query: {error}"))?;
    let limit = i64::from(page_size);
    let items = match project {
        Some(project) => {
            statement.query_map(params![project, limit, offset], memory_summary_from_row)
        }
        None => statement.query_map(params![limit, offset], memory_summary_from_row),
    }
    .map_err(|error| format!("Failed to list memories: {error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("Failed to read memory row: {error}"))?;

    Ok(PagedMemories {
        items,
        total,
        page,
        page_size,
    })
}

fn list_memories_with_search(
    conn: &Connection,
    project: Option<&str>,
    fts_query: &str,
    page: u32,
    page_size: u32,
    offset: i64,
    sort_order: SortOrder,
) -> Result<PagedMemories, String> {
    let total = conn
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM observations o
            JOIN observations_fts ON observations_fts.rowid = o.id
            WHERE o.deleted_at IS NULL
              AND (?1 IS NULL OR o.project = ?1)
              AND observations_fts MATCH ?2
            "#,
            params![project, fts_query],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Failed to count searched memories: {error}"))?;

    let memory_query = match sort_order {
        SortOrder::Latest => {
            r#"
            SELECT
                o.id,
                o.sync_id,
                o.session_id,
                o.type,
                o.title,
                substr(o.content, 1, 520) AS preview,
                o.project,
                o.scope,
                o.topic_key,
                o.created_at,
                o.updated_at
            FROM observations o
            JOIN observations_fts ON observations_fts.rowid = o.id
            WHERE o.deleted_at IS NULL
              AND (?1 IS NULL OR o.project = ?1)
              AND observations_fts MATCH ?2
            ORDER BY datetime(o.updated_at) DESC, o.id DESC
            LIMIT ?3 OFFSET ?4
            "#
        }
        SortOrder::Oldest => {
            r#"
            SELECT
                o.id,
                o.sync_id,
                o.session_id,
                o.type,
                o.title,
                substr(o.content, 1, 520) AS preview,
                o.project,
                o.scope,
                o.topic_key,
                o.created_at,
                o.updated_at
            FROM observations o
            JOIN observations_fts ON observations_fts.rowid = o.id
            WHERE o.deleted_at IS NULL
              AND (?1 IS NULL OR o.project = ?1)
              AND observations_fts MATCH ?2
            ORDER BY datetime(o.created_at) ASC, o.id ASC
            LIMIT ?3 OFFSET ?4
            "#
        }
    };

    let mut statement = conn
        .prepare(memory_query)
        .map_err(|error| format!("Failed to prepare searched memory query: {error}"))?;

    let items = statement
        .query_map(
            params![project, fts_query, i64::from(page_size), offset],
            memory_summary_from_row,
        )
        .map_err(|error| format!("Failed to search memories: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read searched memory row: {error}"))?;

    Ok(PagedMemories {
        items,
        total,
        page,
        page_size,
    })
}

fn memory_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemorySummary> {
    Ok(MemorySummary {
        id: row.get(0)?,
        sync_id: row.get(1)?,
        session_id: row.get(2)?,
        memory_type: row.get(3)?,
        title: row.get(4)?,
        preview: compact_preview(row.get(5)?),
        project: row.get(6)?,
        scope: row.get(7)?,
        topic_key: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

#[tauri::command]
fn get_memory(id: i64) -> Result<Option<MemoryDetail>, String> {
    let conn = open_engram_readonly()?;

    conn.query_row(
        r#"
        SELECT
            id,
            sync_id,
            session_id,
            type,
            title,
            content,
            tool_name,
            project,
            scope,
            topic_key,
            revision_count,
            duplicate_count,
            last_seen_at,
            created_at,
            updated_at
        FROM observations
        WHERE id = ?1 AND deleted_at IS NULL
        "#,
        params![id],
        |row| {
            Ok(MemoryDetail {
                id: row.get(0)?,
                sync_id: row.get(1)?,
                session_id: row.get(2)?,
                memory_type: row.get(3)?,
                title: row.get(4)?,
                content: row.get(5)?,
                tool_name: row.get(6)?,
                project: row.get(7)?,
                scope: row.get(8)?,
                topic_key: row.get(9)?,
                revision_count: row.get(10)?,
                duplicate_count: row.get(11)?,
                last_seen_at: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("Failed to load memory {id}: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_database_info,
            list_projects,
            list_memories,
            get_memory,
            list_project_adr_documents,
            read_project_adr_document,
            list_project_prompts,
            read_project_prompt
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_queries_keep_project_predicates_indexable() {
        let project_sql = memory_list_sql(Some("demo"), SortOrder::Latest);
        assert!(project_sql.contains("project = ?1"));
        assert!(!project_sql.contains("?1 IS NULL"));
        assert!(project_sql.contains("datetime("));

        let all_sql = memory_list_sql(None, SortOrder::Latest);
        assert!(!all_sql.contains("project = ?1"));
        assert!(all_sql.contains("datetime("));
    }

    #[test]
    fn builds_safe_fts_query() {
        assert_eq!(
            build_fts_query(r#"auth bug "quote" %%%"#),
            Some(r#""auth" AND "bug" AND "quote""#.to_string())
        );
    }

    #[test]
    fn returns_no_fts_query_for_punctuation_only_input() {
        assert_eq!(build_fts_query(r#"%%% "" --"#), None);
    }

    #[test]
    fn compacts_long_previews() {
        let preview = compact_preview("alpha\n beta   gamma".to_string());
        assert_eq!(preview, "alpha beta gamma");
    }

    #[test]
    fn validates_relative_markdown_paths() {
        assert!(validate_relative_adr_path(std::path::Path::new("nested/0002.MD")).is_ok());
        assert!(validate_relative_adr_path(std::path::Path::new("../outside.md")).is_err());
        assert!(validate_relative_adr_path(std::path::Path::new("notes.txt")).is_err());

        #[cfg(windows)]
        assert!(validate_relative_adr_path(std::path::Path::new("C:\\outside.md")).is_err());
    }

    #[test]
    fn lists_markdown_documents_recursively_in_stable_order() {
        let root = test_temp_directory("adr-list");
        std::fs::create_dir_all(root.join("nested")).expect("create nested ADR directory");
        std::fs::write(root.join("002-second.md"), "# Second").expect("write second ADR");
        std::fs::write(root.join("nested").join("001-first.MD"), "# First")
            .expect("write first ADR");
        std::fs::write(root.join("nested").join("ignore.txt"), "ignore")
            .expect("write ignored file");

        let index = list_adr_documents_from_root(&root).expect("list ADR documents");
        assert_eq!(index.status, AdrDocumentsStatus::Available);
        assert_eq!(
            index
                .items
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>(),
            vec!["002-second.md", "nested/001-first.MD"]
        );

        remove_test_temp_directory(&root);
    }

    #[test]
    fn blocks_paths_that_escape_the_canonical_adr_root() {
        let root = test_temp_directory("adr-confine");
        std::fs::create_dir_all(&root).expect("create ADR root");
        let outside = root
            .parent()
            .expect("temp root parent")
            .join("adr-outside.md");
        std::fs::write(&outside, "# outside").expect("write outside file");

        let escaped = root.join("..").join("adr-outside.md");
        let error = canonicalize_confined_path(&root, &escaped).expect_err("escape must fail");
        assert!(error.contains("outside"));

        remove_test_temp_directory(&root);
        let _ = std::fs::remove_file(outside);
    }

    #[test]
    fn reports_missing_adr_root_without_failing() {
        let root = test_temp_directory("adr-missing");
        let index = list_adr_documents_from_root(&root).expect("missing root is a valid state");
        assert_eq!(index.status, AdrDocumentsStatus::MissingRoot);
        assert!(index.items.is_empty());
    }

    fn test_temp_directory(label: &str) -> std::path::PathBuf {
        let base = std::env::current_dir()
            .map(|dir| dir.join("target").join("tmp"))
            .unwrap_or_else(|_| std::env::temp_dir());
        let _ = std::fs::create_dir_all(&base);
        base.join(format!(
            "engramview-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ))
    }

    fn remove_test_temp_directory(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn prompt_list_sql_is_project_scoped_and_latest_first() {
        let sql = prompt_list_sql();
        assert!(sql.contains("project = ?1"));
        assert!(sql.contains("ORDER BY datetime(created_at) DESC, id DESC"));
        assert!(sql.contains("LIMIT ?2 OFFSET ?3"));
    }

    #[test]
    fn clamps_prompt_pagination_bounds() {
        let (page, page_size, offset) = prompt_page_parameters(Some(u32::MAX), Some(u32::MAX));
        assert_eq!(page, PROMPT_PAGE_MAX);
        assert_eq!(page_size, PROMPT_PAGE_SIZE_MAX);
        assert_eq!(
            offset,
            i64::from(PROMPT_PAGE_MAX - 1) * i64::from(PROMPT_PAGE_SIZE_MAX)
        );
    }

    #[test]
    fn lists_prompts_with_bounded_pagination_and_read_only_queries() {
        let conn = rusqlite::Connection::open_in_memory().expect("open test database");
        conn.execute_batch(
            "CREATE TABLE user_prompts (
                id INTEGER PRIMARY KEY,
                sync_id TEXT,
                session_id TEXT NOT NULL,
                content TEXT NOT NULL,
                project TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .expect("create prompt table");
        for (id, created_at) in [
            (1_i64, "2024-01-01 10:00:00"),
            (2, "2024-01-02 10:00:00"),
            (3, "2024-01-03 10:00:00"),
        ] {
            conn.execute(
                "INSERT INTO user_prompts (id, sync_id, session_id, content, project, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, format!("sync-{id}"), format!("session-{id}"), format!("Prompt {id}"), "demo", created_at],
            )
            .expect("insert prompt fixture");
        }
        conn.pragma_update(None, "query_only", true)
            .expect("enable read-only query mode");

        let page = list_prompts_from_connection(&conn, "demo", Some(2), Some(2))
            .expect("list prompt page");
        assert_eq!(page.total, 3);
        assert_eq!(page.page, 2);
        assert_eq!(page.page_size, 2);
        assert_eq!(
            page.items.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec![1]
        );
        assert!(conn
            .execute("DELETE FROM user_prompts WHERE id = 1", [])
            .is_err());
    }

    #[test]
    fn prompt_detail_requires_matching_project() {
        let conn = rusqlite::Connection::open_in_memory().expect("open test database");
        conn.execute_batch(
            "CREATE TABLE user_prompts (
                id INTEGER PRIMARY KEY,
                sync_id TEXT,
                session_id TEXT NOT NULL,
                content TEXT NOT NULL,
                project TEXT,
                created_at TEXT NOT NULL
            );
            INSERT INTO user_prompts (id, session_id, content, project, created_at)
            VALUES (7, 'session-7', '# Prompt', 'demo', '2024-01-01 10:00:00');",
        )
        .expect("create prompt fixture");

        let detail = get_prompt_from_connection(&conn, "demo", 7)
            .expect("prompt detail query")
            .expect("matching prompt should exist");
        assert_eq!(detail.content, "# Prompt");
        assert!(get_prompt_from_connection(&conn, "other", 7)
            .expect("mismatched project query")
            .is_none());
    }

    #[test]
    fn reads_local_engram_database_without_mutation_commands() {
        let database = get_database_info().expect("database info should resolve");
        if !database.exists {
            return;
        }

        let projects = list_projects().expect("projects should be readable");
        assert!(!projects.is_empty(), "expected at least one Engram project");

        let project = projects
            .iter()
            .find(|project| project.observation_count > 0)
            .expect("expected at least one project with observations");

        let page = list_memories(MemoryQuery {
            project: Some(project.name.clone()),
            query: None,
            page: Some(1),
            page_size: Some(10),
            sort_order: Some(SortOrder::Latest),
        })
        .expect("memories should be readable");

        assert_eq!(page.page, 1);
        assert_eq!(page.page_size, 10);
        assert!(page.total >= page.items.len() as i64);
        assert!(project.first_memory_at.is_some());
        let serialized_project =
            serde_json::to_value(project).expect("project summary should serialize");
        assert!(
            matches!(
                serialized_project.get("directory"),
                Some(serde_json::Value::Null | serde_json::Value::String(_))
            ),
            "project summary should expose directory as a nullable string"
        );
        assert_sorted_by_updated_descending(&page.items);

        let oldest_page = list_memories(MemoryQuery {
            project: Some(project.name.clone()),
            query: None,
            page: Some(1),
            page_size: Some(10),
            sort_order: Some(SortOrder::Oldest),
        })
        .expect("oldest memories should be readable");
        assert_sorted_by_created_ascending(&oldest_page.items);

        let searched_page = list_memories(MemoryQuery {
            project: Some(project.name.clone()),
            query: page.items.first().map(|memory| memory.title.clone()),
            page: Some(1),
            page_size: Some(10),
            sort_order: Some(SortOrder::Latest),
        })
        .expect("FTS memory search should be readable");
        assert!(searched_page.total >= 0);

        if let Some(first_memory) = page.items.first() {
            let detail = get_memory(first_memory.id).expect("memory detail query should work");
            assert!(detail.is_some(), "selected memory should load by ID");
        }
    }

    fn assert_sorted_by_updated_descending(items: &[MemorySummary]) {
        for pair in items.windows(2) {
            assert!(
                pair[0].updated_at >= pair[1].updated_at,
                "expected latest-first memory order"
            );
        }
    }

    fn assert_sorted_by_created_ascending(items: &[MemorySummary]) {
        for pair in items.windows(2) {
            assert!(
                pair[0].created_at <= pair[1].created_at,
                "expected oldest-first memory order"
            );
        }
    }
}
