use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

pub const MAX_BODY: usize = 1024 * 1024;
pub const CHUNK_SIZE: usize = 64 * 1024;
pub const MAX_WIRE: usize = MAX_BODY * 4 / 3 + 64 * 1024;
pub const REQUEST_HEADERS: &[&str] = &[
    "accept",
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
];
pub const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "cache-control",
    "retry-after",
];
pub type Writer = mpsc::Sender<Message>;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Incoming {
    Request {
        id: Uuid,
        target_id: String,
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body_base64: String,
        timeout_ms: u64,
    },
    Ack {
        id: Uuid,
    },
    Cancel {
        id: Uuid,
    },
    Command {
        id: Uuid,
        action: String,
        arguments: Value,
    },
}

pub struct HttpRequest {
    pub id: Uuid,
    pub method: reqwest::Method,
    pub path: String,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
    pub timeout: Duration,
}
impl HttpRequest {
    pub fn validate(
        id: Uuid,
        method: &str,
        path: String,
        headers: HashMap<String, String>,
        encoded: &str,
        timeout_ms: u64,
    ) -> Result<Self, String> {
        if !matches!(
            (method, path.as_str()),
            ("GET" | "POST" | "DELETE", "/mcp") | ("POST", "/api")
        ) {
            return Err("only GET/POST/DELETE /mcp and POST /api are supported".into());
        }
        if encoded.len() > MAX_BODY.div_ceil(3) * 4 {
            return Err("request body exceeds 1 MiB".into());
        }
        let body = STANDARD
            .decode(encoded)
            .map_err(|_| "body_base64 is not valid standard base64")?;
        if body.len() > MAX_BODY {
            return Err("request body exceeds 1 MiB".into());
        }
        if headers.len() > 64
            || headers
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>()
                > 32 * 1024
        {
            return Err("request headers exceed limits".into());
        }
        let mut filtered = reqwest::header::HeaderMap::new();
        for (key, value) in headers {
            let key = key.to_ascii_lowercase();
            if REQUEST_HEADERS.contains(&key.as_str()) {
                let key = reqwest::header::HeaderName::from_bytes(key.as_bytes())
                    .map_err(|_| "invalid request header name")?;
                let value = reqwest::header::HeaderValue::from_str(&value)
                    .map_err(|_| "invalid request header value")?;
                if filtered.insert(key, value).is_some() {
                    return Err("duplicate request header after case normalization".into());
                }
            }
        }
        Ok(Self {
            id,
            method: reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
            path,
            headers: filtered,
            body,
            timeout: Duration::from_millis(timeout_ms.clamp(1, 360_000)),
        })
    }
}

// Accounting prevents unsolicited/duplicate acknowledgements from inflating the window.
pub struct Credits {
    semaphore: Semaphore,
    outstanding: AtomicUsize,
}
impl Credits {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            semaphore: Semaphore::new(8),
            outstanding: AtomicUsize::new(0),
        })
    }
    pub fn ack(&self) {
        if self
            .outstanding
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            self.semaphore.add_permits(1);
        }
    }
    pub async fn take(&self) -> Result<(), String> {
        self.semaphore
            .acquire()
            .await
            .map_err(|_| "request canceled")?
            .forget();
        self.outstanding.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

pub fn message(value: Value) -> Message {
    Message::Text(value.to_string().into())
}
pub async fn send(tx: &Writer, value: Value) -> Result<(), String> {
    tx.send(message(value))
        .await
        .map_err(|_| "connector connection closed".into())
}
pub async fn chunks(tx: &Writer, id: Uuid, bytes: &[u8], credits: &Credits) -> Result<(), String> {
    for piece in bytes.chunks(CHUNK_SIZE) {
        credits.take().await?;
        send(
            tx,
            json!({"type":"response_chunk","id":id,"data_base64":STANDARD.encode(piece)}),
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_request_limits_methods_and_header_filter() {
        let mut headers = HashMap::new();
        headers.insert("Authorization".into(), "Bearer hidden".into());
        headers.insert("Cookie".into(), "secret".into());
        headers.insert("Host".into(), "evil.test".into());
        headers.insert("Mcp-Session-Id".into(), "session".into());
        let req = HttpRequest::validate(
            Uuid::new_v4(),
            "POST",
            "/mcp".into(),
            headers,
            "eA==",
            u64::MAX,
        )
        .unwrap();
        assert_eq!(req.headers.len(), 1);
        assert_eq!(req.body, b"x");
        assert_eq!(req.timeout, Duration::from_secs(360));
        for (method, path) in [
            ("PUT", "/mcp"),
            ("GET", "/api"),
            ("POST", "/api?x=1"),
            ("GET", "//evil"),
            ("GET", "/mcp/"),
        ] {
            assert!(HttpRequest::validate(
                Uuid::new_v4(),
                method,
                path.into(),
                HashMap::new(),
                "",
                1
            )
            .is_err());
        }
        assert!(HttpRequest::validate(
            Uuid::new_v4(),
            "POST",
            "/api".into(),
            HashMap::new(),
            "!",
            1
        )
        .is_err());
        assert!(HttpRequest::validate(
            Uuid::new_v4(),
            "POST",
            "/api".into(),
            HashMap::new(),
            &STANDARD.encode(vec![0; MAX_BODY + 1]),
            1
        )
        .is_err());
        assert!(serde_json::from_value::<Incoming>(
            json!({"type":"ack","id":Uuid::new_v4(),"extra":1})
        )
        .is_err());
    }
    #[tokio::test]
    async fn stream_is_chunked_and_pauses_until_ack() {
        let (tx, mut rx) = mpsc::channel(32);
        let credits = Credits::new();
        for _ in 0..100 {
            credits.ack();
        }
        let credit_copy = credits.clone();
        let payload = vec![7; CHUNK_SIZE * 9 + 17];
        let expected = payload.clone();
        let id = Uuid::new_v4();
        let task = tokio::spawn(async move {
            chunks(&tx, id, &payload, &credit_copy).await.unwrap();
        });
        let mut received = Vec::new();
        for _ in 0..8 {
            let frame = rx.recv().await.unwrap();
            let json: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            assert_eq!(json["id"], id.to_string());
            let bytes = STANDARD
                .decode(json["data_base64"].as_str().unwrap())
                .unwrap();
            assert!(bytes.len() <= CHUNK_SIZE);
            received.extend(bytes);
        }
        assert!(tokio::time::timeout(Duration::from_millis(30), rx.recv())
            .await
            .is_err());
        credits.ack();
        credits.ack();
        for _ in 0..2 {
            let frame = rx.recv().await.unwrap();
            let json: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            received.extend(
                STANDARD
                    .decode(json["data_base64"].as_str().unwrap())
                    .unwrap(),
            );
        }
        task.await.unwrap();
        assert_eq!(received, expected);
    }
}
