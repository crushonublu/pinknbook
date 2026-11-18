//! X-Ray relationship labels and character descriptions written by an AI
//! model the reader chooses: Claude (Anthropic) or DeepSeek. The reader's own
//! API key is kept in the Windows Credential Manager, never in the database.
//!
//! Only short passages from the part of the book already read are sent: for
//! each pair, a few stretches where both people appear; for each person, a
//! few where they appear.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SERVICE: &str = "pinknbook";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_COUNT_URL: &str = "https://api.anthropic.com/v1/messages/count_tokens";
const ANTHROPIC_VERSION: &str = "2026-10-21";
const ANTHROPIC_FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const CLAUDE_MODEL: &str = "claude-opus-5-5";
/// USD per million tokens (input, output) for Claude Opus 5.5.
const CLAUDE_PRICE: (f64, f64) = (4.0, 20.0);
const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL: &str = "deepseek-flash";
/// USD per million tokens (input, output) for DeepSeek Flash at peak hours
/// (off-peak is half), so the estimate never comes in low.
const DEEPSEEK_PRICE: (f64, f64) = (0.30, 1.20);

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Deepseek,
}

fn account(p: Provider) -> &'static str {
    match p {
        Provider::Anthropic => "ai-key-anthropic",
        Provider::Deepseek => "ai-key-deepseek",
    }
}

fn key_entry(p: Provider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account(p)).map_err(|e| e.to_string())
}

fn load_key(p: Provider) -> Result<Option<String>, String> {
    match key_entry(p)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The end of a key, enough to recognise it.
fn hint(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

#[derive(Serialize)]
pub struct KeyStatus {
    pub anthropic: Option<String>,
    pub deepseek: Option<String>,
}

#[tauri::command]
pub fn ai_key_status() -> Result<KeyStatus, String> {
    Ok(KeyStatus {
        anthropic: load_key(Provider::Anthropic)?.map(|k| hint(&k)),
        deepseek: load_key(Provider::Deepseek)?.map(|k| hint(&k)),
    })
}

#[tauri::command]
pub fn ai_key_set(provider: Provider, key: String) -> Result<String, String> {
    let key = key.trim().to_string();
    if key.len() < 20 || key.len() > 400 || key.chars().any(char::is_whitespace) {
        return Err("bad key".into());
    }
    key_entry(provider)?.set_password(&key).map_err(|e| e.to_string())?;
    Ok(hint(&key))
}

#[tauri::command]
pub fn ai_key_clear(provider: Provider) -> Result<(), String> {
    match key_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- Request ------------------------------------------------------------------

#[derive(Deserialize)]
pub struct Person {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub previous: Option<String>,
    #[serde(default)]
    pub passages: Vec<String>,
}

#[derive(Deserialize)]
pub struct Pair {
    pub id: String,
    pub a: String,
    pub b: String,
    #[serde(default)]
    pub previous: Option<String>,
    #[serde(default)]
    pub passages: Vec<String>,
}

/// Everyone on the map, so `same_as` can point at someone not in this batch.
#[derive(Deserialize)]
pub struct RosterItem {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
pub struct XrayJob {
    pub title: String,
    /// Language to write in: "vi" or "en".
    pub lang: String,
    pub people: Vec<Person>,
    pub pairs: Vec<Pair>,
    #[serde(default)]
    pub roster: Vec<RosterItem>,
}

fn system_prompt(lang: &str) -> String {
    let vi = lang.starts_with("vi");
    let language = if vi { "Vietnamese" } else { "English" };
    // Examples only in the language wanted, so the model is not drawn to the other.
    let (examples, unclear) = if vi {
        ("\"cha – con\", \"vợ – chồng\", \"anh – em\", \"chủ – người hầu\", \"bạn thân\", \"cùng làng\"", "\"quen biết\"")
    } else {
        ("\"father – son\", \"husband – wife\", \"brothers\", \"master – servant\", \"close friends\"", "\"acquaintances\"")
    };
    let (narrator, kin) = if vi { ("\"Tôi (người kể)\"", "\"Bố tôi\"") } else { ("\"I (narrator)\"", "\"My father\"") };
    format!(
        "You help a reader keep track of the people in a book they are reading. The reader reads in \
{language}: write every description, label and detail in {language} only, whatever language the passages, \
names or earlier notes are in (keep names as the book writes them). You are given short \
passages from the part of the book they have already read. Base everything only on these passages: do not \
use what you may know about the book, and never hint at anything that happens later.

For each person, write `description`: one or two sentences on who they are and their part in the story so far. \
If an earlier description is given, update it with what the new passages add. \
Also give `same_as`: the id (from ALL PEOPLE) of a different listed name that is the very same person, or an \
empty string. Use it when the passages make it clear, for example the book's narrator (listed as {narrator}) \
and the name others call the narrator by, or someone the narrator calls {kin} and that person's own name. \
Never guess.

For each pair, write `label`: their relationship in a few words, naming both sides when they differ, the first \
person's side first (for example {examples}). If the passages do not make it clear, say only what they show \
(for example {unclear}). If the two names are the same person, say so. Write `detail`: one short sentence explaining it. If an earlier label is given, \
keep it unless the new passages change it.

Everything you write is in {language}; never mix languages. Use each `id` exactly as given. Reply with JSON only."
    )
}

fn user_prompt(job: &XrayJob) -> String {
    let mut s = format!("Book: {}\n", job.title);
    if !job.roster.is_empty() {
        s += "\nALL PEOPLE (ids for same_as)\n";
        for r in &job.roster {
            s += &format!("{}: {}\n", r.id, r.name);
        }
    }
    s += "\nPEOPLE\n";
    for p in &job.people {
        s += &format!("\n[id: {}] {}", p.id, p.name);
        if !p.aliases.is_empty() {
            s += &format!(" (also: {})", p.aliases.join(", "));
        }
        s += "\n";
        if let Some(prev) = &p.previous {
            s += &format!("Earlier description: {prev}\n");
        }
        for (i, t) in p.passages.iter().enumerate() {
            s += &format!("Passage {}: {}\n", i + 1, t);
        }
    }
    s += "\nPAIRS\n";
    for p in &job.pairs {
        s += &format!("\n[id: {}] {} & {}\n", p.id, p.a, p.b);
        if let Some(prev) = &p.previous {
            s += &format!("Earlier label: {prev}\n");
        }
        for (i, t) in p.passages.iter().enumerate() {
            s += &format!("Passage {}: {}\n", i + 1, t);
        }
    }
    s
}

fn schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["people", "pairs"],
        "properties": {
            "people": { "type": "array", "items": {
                "type": "object", "additionalProperties": false, "required": ["id", "description", "same_as"],
                "properties": { "id": { "type": "string" }, "description": { "type": "string" }, "same_as": { "type": "string" } }
            }},
            "pairs": { "type": "array", "items": {
                "type": "object", "additionalProperties": false, "required": ["id", "label", "detail"],
                "properties": { "id": { "type": "string" }, "label": { "type": "string" }, "detail": { "type": "string" } }
            }}
        }
    })
}

/// Rough output size: a sentence or two per person and pair, plus thinking.
fn output_guess(job: &XrayJob) -> u64 {
    300 + 90 * job.people.len() as u64 + 70 * job.pairs.len() as u64
}

#[derive(Serialize)]
pub struct Estimate {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    /// Input counted by the provider (Claude) rather than guessed from length.
    pub exact_input: bool,
    pub model: String,
}

fn cost(p: Provider, input: u64, output: u64) -> f64 {
    let (i, o) = match p {
        Provider::Anthropic => CLAUDE_PRICE,
        Provider::Deepseek => DEEPSEEK_PRICE,
    };
    (input as f64 * i + output as f64 * o) / 1_000_000.0
}

fn key_or_err(p: Provider) -> Result<String, String> {
    load_key(p)?.ok_or_else(|| "no_key".to_string())
}

async fn http_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("HTTP {}: {msg}", status.as_u16())
}

/// What a run would send and roughly cost.
#[tauri::command]
pub async fn xray_ai_estimate(provider: Provider, job: XrayJob) -> Result<Estimate, String> {
    let system = system_prompt(&job.lang);
    let user = user_prompt(&job);
    let output = output_guess(&job);
    let (input, exact) = match provider {
        Provider::Anthropic => {
            let key = key_or_err(provider)?;
            let resp = reqwest::Client::new()
                .post(ANTHROPIC_COUNT_URL)
                .header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .json(&json!({
                    "model": CLAUDE_MODEL,
                    "system": system,
                    "messages": [{ "role": "user", "content": user }],
                }))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }
            let v: Value = resp.json().await.map_err(|e| e.to_string())?;
            (v.get("input_tokens").and_then(Value::as_u64).unwrap_or(0), true)
        }
        // No counting endpoint: about 3 characters per token for mixed
        // Vietnamese/English text, rounded up.
        Provider::Deepseek => (((system.chars().count() + user.chars().count()) as u64).div_ceil(3), false),
    };
    Ok(Estimate {
        input_tokens: input,
        output_tokens: output * if provider == Provider::Anthropic { 2 } else { 1 },
        cost_usd: cost(provider, input, output * if provider == Provider::Anthropic { 2 } else { 1 }),
        exact_input: exact,
        model: match provider {
            Provider::Anthropic => CLAUDE_MODEL.into(),
            Provider::Deepseek => DEEPSEEK_MODEL.into(),
        },
    })
}

#[derive(Serialize)]
pub struct AiResult {
    pub result: Value,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub model: String,
}

/// Run the labelling. The result is `{people: [{id, description}], pairs: [{id, label, detail}]}`.
#[tauri::command]
pub async fn xray_ai_run(provider: Provider, job: XrayJob) -> Result<AiResult, String> {
    let key = key_or_err(provider)?;
    let system = system_prompt(&job.lang);
    let user = user_prompt(&job);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    match provider {
        Provider::Anthropic => {
            let resp = client
                .post(ANTHROPIC_URL)
                .header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("anthropic-beta", ANTHROPIC_FALLBACK_BETA)
                .json(&json!({
                    "model": CLAUDE_MODEL,
                    "max_tokens": 16000,
                    "system": system,
                    "messages": [{ "role": "user", "content": user }],
                    "output_config": {
                        "effort": "low",
                        "format": { "type": "json_schema", "schema": schema() }
                    },
                    // On a safety decline, the API retries on a fallback model.
                    "fallbacks": "default",
                }))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }
            let v: Value = resp.json().await.map_err(|e| e.to_string())?;
            match v.get("stop_reason").and_then(Value::as_str) {
                Some("refusal") => return Err("refusal".into()),
                Some("max_tokens") => return Err("max_tokens".into()),
                _ => {}
            }
            let text: String = v
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect();
            let result: Value = serde_json::from_str(&text).map_err(|e| format!("bad JSON: {e}"))?;
            let input = v.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0);
            let output = v.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0);
            Ok(AiResult {
                result,
                input_tokens: input,
                output_tokens: output,
                cost_usd: cost(provider, input, output),
                model: v.get("model").and_then(Value::as_str).unwrap_or(CLAUDE_MODEL).into(),
            })
        }
        Provider::Deepseek => {
            // JSON mode wants the word "json" and an example of the shape.
            let system = format!(
                "{system}\n\nReply with a json object shaped like: \
{{\"people\": [{{\"id\": \"p1\", \"description\": \"...\", \"same_as\": \"\"}}], \"pairs\": [{{\"id\": \"r1\", \"label\": \"...\", \"detail\": \"...\"}}]}}"
            );
            let mut last_err = String::new();
            // JSON mode can come back blank; try once more.
            for _ in 0..2 {
                let resp = client
                    .post(DEEPSEEK_URL)
                    .bearer_auth(&key)
                    .json(&json!({
                        "model": DEEPSEEK_MODEL,
                        "max_tokens": 32000,
                        // Thinking is on by default and eats the output budget;
                        // labelling short passages does not need it.
                        "thinking": { "type": "disabled" },
                        "response_format": { "type": "json_object" },
                        "messages": [
                            { "role": "system", "content": system },
                            { "role": "user", "content": user },
                        ],
                    }))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                if !resp.status().is_success() {
                    return Err(http_error(resp).await);
                }
                let v: Value = resp.json().await.map_err(|e| e.to_string())?;
                let text = v.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if v.pointer("/choices/0/finish_reason").and_then(Value::as_str) == Some("length") {
                    return Err("max_tokens".into());
                }
                match serde_json::from_str::<Value>(&text) {
                    Ok(result) if !text.is_empty() => {
                        let input = v.pointer("/usage/prompt_tokens").and_then(Value::as_u64).unwrap_or(0);
                        let output = v.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(0);
                        return Ok(AiResult {
                            result,
                            input_tokens: input,
                            output_tokens: output,
                            cost_usd: cost(provider, input, output),
                            model: v.get("model").and_then(Value::as_str).unwrap_or(DEEPSEEK_MODEL).into(),
                        });
                    }
                    Ok(_) => last_err = "empty answer".into(),
                    Err(e) => last_err = format!("bad JSON: {e}"),
                }
            }
            Err(last_err)
        }
    }
}

// ---- X-Ray storage ----------------------------------------------------------------

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS xray (
    asin  TEXT PRIMARY KEY,
    idx   TEXT,
    edits TEXT,
    ai    TEXT
);
";

#[derive(Serialize)]
pub struct XrayStored {
    pub idx: Option<String>,
    pub edits: Option<String>,
    pub ai: Option<String>,
}

#[tauri::command]
pub fn xray_load(db: tauri::State<crate::db::Db>, asin: String) -> Result<XrayStored, String> {
    let conn = db.0.lock().unwrap();
    use rusqlite::OptionalExtension;
    let row = conn
        .query_row("SELECT idx, edits, ai FROM xray WHERE asin = ?1", [&asin], |r| {
            Ok(XrayStored { idx: r.get(0)?, edits: r.get(1)?, ai: r.get(2)? })
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.unwrap_or(XrayStored { idx: None, edits: None, ai: None }))
}

/// Save one part ("idx", "edits" or "ai") of a book's X-Ray as JSON text.
#[tauri::command]
pub fn xray_save(db: tauri::State<crate::db::Db>, asin: String, part: String, json: String) -> Result<(), String> {
    let col = match part.as_str() {
        "idx" => "idx",
        "edits" => "edits",
        "ai" => "ai",
        _ => return Err("bad part".into()),
    };
    serde_json::from_str::<Value>(&json).map_err(|e| e.to_string())?;
    let conn = db.0.lock().unwrap();
    conn.execute(
        &format!("INSERT INTO xray (asin, {col}) VALUES (?1, ?2) ON CONFLICT(asin) DO UPDATE SET {col} = excluded.{col}"),
        rusqlite::params![asin, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_lists_people_and_pairs() {
        let job = XrayJob {
            title: "T".into(),
            lang: "vi".into(),
            people: vec![Person { id: "p1".into(), name: "Alyosha".into(), aliases: vec!["Alexey".into()], previous: None, passages: vec!["x".into()] }],
            pairs: vec![Pair { id: "r1".into(), a: "Alyosha".into(), b: "Ivan".into(), previous: Some("anh – em".into()), passages: vec!["y".into()] }],
            roster: vec![RosterItem { id: "p1".into(), name: "Alyosha".into() }, RosterItem { id: "p2".into(), name: "Tôi (người kể)".into() }],
        };
        let u = user_prompt(&job);
        assert!(u.contains("[id: p1] Alyosha (also: Alexey)"));
        assert!(u.contains("[id: r1] Alyosha & Ivan"));
        assert!(u.contains("Earlier label: anh – em"));
        assert!(u.contains("ALL PEOPLE") && u.contains("p2: Tôi (người kể)"));
        assert!(system_prompt("vi").contains("Bố tôi") && system_prompt("en").contains("My father"));
        let vi = system_prompt("vi");
        assert!(vi.contains("in Vietnamese only") && vi.contains("vợ – chồng") && !vi.contains("father"));
        let en = system_prompt("en");
        assert!(en.contains("in English only") && en.contains("father – son") && !en.contains("vợ"));
    }

    #[test]
    fn costs_add_up() {
        assert!((cost(Provider::Anthropic, 1_000_000, 0) - 4.0).abs() < 1e-9);
        assert!((cost(Provider::Deepseek, 0, 1_000_000) - 1.2).abs() < 1e-9);
        assert_eq!(hint("sk-ant-api03-abcdefgh"), "…efgh");
    }
}
