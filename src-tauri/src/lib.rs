use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf, time::Duration};

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
            get_memory
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
