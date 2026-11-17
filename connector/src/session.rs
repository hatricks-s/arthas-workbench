use crate::{
    config::{server_endpoint, Config, Target},
    process,
    protocol::{self, Credits, HttpRequest, Incoming, Writer},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, Mutex, RwLock},
    task::{AbortHandle, JoinSet},
    time::Instant,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Endpoints = Arc<RwLock<HashMap<String, url::Url>>>;
struct Active {
    abort: AbortHandle,
    credits: Arc<Credits>,
}

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .pool_max_idle_per_host(4)
        .build()
        .map_err(|_| "failed to initialize HTTP client".into())
}

pub async fn stream_http(
    client: &reqwest::Client,
    endpoint: &url::Url,
    request: HttpRequest,
    tx: &Writer,
    credits: &Credits,
) -> Result<(), String> {
    let mut url = endpoint.clone();
    url.set_path(&request.path);
    let response = client
        .request(request.method, url)
        .headers(request.headers)
        .body(request.body)
        .header("accept-encoding", "identity")
        .send()
        .await
        .map_err(|error| {
            if error.is_connect() {
                "target unavailable; check Arthas or port-forward"
            } else {
                "upstream HTTP request failed"
            }
        })?;
    let mut headers = HashMap::new();
    for key in protocol::RESPONSE_HEADERS {
        if let Some(value) = response.headers().get(*key).and_then(|v| v.to_str().ok()) {
            headers.insert(*key, value);
        }
    }
    protocol::send(tx,json!({"type":"response_start","id":request.id,"status":response.status().as_u16(),"headers":headers})).await?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "upstream response stream failed")?;
        protocol::chunks(tx, request.id, &chunk, credits).await?;
    }
    protocol::send(tx, json!({"type":"response_end","id":request.id})).await
}

async fn request_task(
    client: reqwest::Client,
    endpoint: url::Url,
    request: HttpRequest,
    tx: Writer,
    credits: Arc<Credits>,
) {
    let id = request.id;
    let outcome = tokio::time::timeout(
        request.timeout,
        stream_http(&client, &endpoint, request, &tx, &credits),
    )
    .await;
    let error = match outcome {
        Ok(Ok(())) => return,
        Ok(Err(e)) => e,
        Err(_) => "request timed out (maximum 360000 ms, including flow-control waits)".into(),
    };
    let _ = protocol::send(&tx, json!({"type":"response_error","id":id,"error":error})).await;
}

async fn target_lifecycle(
    config: Arc<Config>,
    target: Target,
    endpoints: Endpoints,
    tx: Writer,
    client: reqwest::Client,
    shutdown: CancellationToken,
) {
    let id = target.id().to_owned();
    let prepared = match &target {
        Target::Local { endpoint, .. } => {
            crate::config::local_endpoint(endpoint).map(|url| (None, url))
        }
        Target::K8s { .. } => process::forward(&config, &target)
            .await
            .map(|(child, url)| (Some(child), url)),
    };
    let (mut child, endpoint) = match prepared {
        Ok(value) => value,
        Err(error) => {
            let _ = protocol::send(&tx,json!({"type":"target_status","target_id":id,"status":"unavailable","detail":error})).await;
            return;
        }
    };
    endpoints.write().await.insert(id.clone(), endpoint.clone());
    let reachable = process::probe(&client, &endpoint).await;
    let detail = if reachable {
        "configured /mcp endpoint responded"
    } else {
        "Arthas /mcp is unreachable; start Arthas or verify the configured port"
    };
    let _ = protocol::send(&tx,json!({"type":"target_status","target_id":id,"status":if reachable {"ready"} else {"unavailable"},"detail":detail})).await;
    if let Some(child) = child.as_mut() {
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => { child.stop().await; break; }
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    if child.exited() {
                        endpoints.write().await.remove(&id);
                        // Raw kubectl stderr may contain kubeconfig credentials; keep its bounded
                        // capture private and emit an actionable nonsecret summary instead.
                        let _ = protocol::send(&tx,json!({"type":"target_status","target_id":id,"status":"unavailable","detail":"owned kubectl port-forward exited; check credentials, RBAC and pod health; connector reconnect will restart it"})).await;
                        break;
                    }
                }
            }
        }
    }
}

async fn command_task(
    config: Arc<Config>,
    id: Uuid,
    action: String,
    arguments: Value,
    client: reqwest::Client,
    tx: Writer,
    attach_lock: Arc<Mutex<()>>,
) {
    let result = match action.as_str() {
        "scan_java" => {
            if arguments.as_object().is_some_and(|args| args.is_empty()) {
                Ok(process::scan(&config).await)
            } else {
                Err("scan_java arguments must be an empty object".into())
            }
        }
        "attach_local" => match serde_json::from_value::<process::AttachArgs>(arguments) {
            Ok(args) => {
                let target_id = args.target_id.clone();
                let _guard = attach_lock.lock().await;
                let result = process::attach(&config, args, &client).await;
                let endpoint = config.targets.iter().find_map(|target| match target {
                    Target::Local { id, endpoint, .. } if *id == target_id => {
                        crate::config::local_endpoint(endpoint).ok()
                    }
                    _ => None,
                });
                if let Some(endpoint) = endpoint {
                    let ready = result.is_ok() || process::probe(&client, &endpoint).await;
                    let detail = if result.is_ok() {
                        "attach completed and /mcp responded"
                    } else if ready {
                        "attach rejected or failed; existing /mcp endpoint still responds; see command_error"
                    } else {
                        "attach did not complete and /mcp is unavailable; see command_error"
                    };
                    let _ = protocol::send(&tx,json!({"type":"target_status","target_id":target_id,"status":if ready {"ready"} else {"unavailable"},"detail":detail})).await;
                }
                result
            }
            Err(_) => Err(
                "attach_local arguments must contain only target_id, positive pid and identity"
                    .into(),
            ),
        },
        _ => Err("unsupported command; use scan_java or attach_local".into()),
    };
    let response = match result {
        Ok(result) => json!({"type":"command_result","id":id,"result":result}),
        Err(error) => json!({"type":"command_error","id":id,"error":error}),
    };
    let _ = protocol::send(&tx, response).await;
}

pub async fn connection(config: Arc<Config>, stop: CancellationToken) -> Result<(), String> {
    let endpoint = server_endpoint(&config.server_url)?;
    let mut request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|_| "invalid WebSocket request")?;
    let mut auth = format!("Bearer {}", config.token)
        .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
        .map_err(|_| "invalid node token")?;
    auth.set_sensitive(true);
    request.headers_mut().insert("authorization", auth);
    request.headers_mut().insert(
        "x-node-id",
        config
            .node_id
            .parse()
            .map_err(|_| "invalid node_id header")?,
    );
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(protocol::MAX_WIRE))
        .max_frame_size(Some(protocol::MAX_WIRE));
    let connection = tokio::select! {
        _ = stop.cancelled() => return Ok(()),
        outcome = tokio::time::timeout(Duration::from_secs(10),connect_async_with_config(request,Some(ws_config),true)) => outcome,
    };
    let (socket, _) = connection
        .map_err(|_| "WebSocket handshake timed out")?
        .map_err(|_| {
            "WebSocket connection failed; check server_url, TLS certificate and node credentials"
        })?;
    eprintln!("connector connected");
    let (mut sink, mut source) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(32);
    let mut writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            match tokio::time::timeout(Duration::from_secs(10), sink.send(message)).await {
                Ok(Ok(())) => {}
                _ => return,
            }
        }
    });
    let targets: Vec<Value> = config.targets.iter().map(|target| json!({"id":target.id(),"name":target.name(),"kind":target.kind(),"status":"unknown"})).collect();
    let capabilities = if config.allow_attach {
        vec!["scan_java", "attach_local"]
    } else {
        vec!["scan_java"]
    };
    if protocol::send(
        &tx,
        json!({"type":"hello","version":1,"targets":targets,"capabilities":capabilities}),
    )
    .await
    .is_err()
    {
        writer.abort();
        return Err("WebSocket writer stopped before hello".into());
    }
    let client = http_client()?;
    let endpoints: Endpoints = Arc::new(RwLock::new(HashMap::new()));
    let shutdown = CancellationToken::new();
    let attach_lock = Arc::new(Mutex::new(()));
    let mut targets = JoinSet::new();
    for target in &config.targets {
        targets.spawn(target_lifecycle(
            config.clone(),
            target.clone(),
            endpoints.clone(),
            tx.clone(),
            client.clone(),
            shutdown.clone(),
        ));
    }
    let mut jobs = JoinSet::new();
    let mut active: HashMap<Uuid, Active> = HashMap::new();
    let mut commands: HashMap<Uuid, AbortHandle> = HashMap::new();
    let mut job_ids: HashMap<tokio::task::Id, Uuid> = HashMap::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let mut last_pong = Instant::now();
    let mut sequence: u64 = 0;
    let mut expected_pong = Vec::new();
    let reason = loop {
        tokio::select! {
            _ = stop.cancelled() => break "connector stopping",
            _ = &mut writer => break "WebSocket writer stopped",
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(60) { break "WebSocket heartbeat expired"; }
                sequence += 1;
                expected_pong = sequence.to_be_bytes().to_vec();
                if tx.try_send(Message::Ping(expected_pong.clone().into())).is_err() { break "WebSocket writer is congested"; }
            }
            joined = jobs.join_next_with_id(), if !jobs.is_empty() => {
                let task_id = match joined { Some(Ok((task_id,()))) => task_id, Some(Err(error)) => error.id(), None => continue };
                if let Some(id) = job_ids.remove(&task_id) {
                    if active.get(&id).is_some_and(|a| a.abort.id() == task_id) { active.remove(&id); }
                    if commands.get(&id).is_some_and(|a| a.id() == task_id) { commands.remove(&id); }
                }
            }
            _ = targets.join_next(), if !targets.is_empty() => {},
            incoming = source.next() => {
                let frame = match incoming { Some(Ok(frame)) => frame, _ => break "WebSocket connection lost" };
                match frame {
                    Message::Ping(bytes) => { if tx.try_send(Message::Pong(bytes)).is_err() { break "WebSocket writer is congested"; } }
                    Message::Pong(bytes) => { if bytes.as_ref() == expected_pong { last_pong = Instant::now(); } }
                    Message::Close(_) => break "WebSocket server closed connection",
                    Message::Text(text) => {
                        let incoming = match serde_json::from_str::<Incoming>(&text) {
                            Ok(incoming) => incoming,
                            Err(_) => {
                                // Malformed envelopes get correlated errors when their UUID is usable;
                                // never log their bodies or headers, which can contain secrets.
                                let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
                                let id = value["id"].as_str().and_then(|s| Uuid::parse_str(s).ok());
                                if let Some(id) = id {
                                    let kind = if value["type"] == "command" {"command_error"} else {"response_error"};
                                    if tx.try_send(protocol::message(json!({"type":kind,"id":id,"error":"invalid protocol v1 message; check required fields, types and unknown fields"}))).is_err() { break "WebSocket writer is congested"; }
                                    continue;
                                }
                                break "invalid protocol v1 message without a UUID";
                            }
                        };
                        match incoming {
                            Incoming::Ack {id} => { if let Some(request) = active.get(&id) { request.credits.ack(); } }
                            Incoming::Cancel {id} => {
                                if let Some(request) = active.remove(&id) { request.abort.abort(); }
                                if let Some(command) = commands.remove(&id) { command.abort(); }
                            }
                            Incoming::Request {id,target_id,method,path,headers,body_base64,timeout_ms} => {
                                if active.contains_key(&id) || commands.contains_key(&id) { break "duplicate active request UUID"; }
                                let validated = if active.len() >= 16 { Err("connector allows at most 16 in-flight HTTP requests".into()) }
                                    else { HttpRequest::validate(id,&method,path,headers,&body_base64,timeout_ms) };
                                let endpoint = endpoints.read().await.get(&target_id).cloned();
                                match (validated,endpoint) {
                                    (Ok(request),Some(endpoint)) => {
                                        let credits = Credits::new();
                                        let abort = jobs.spawn(request_task(client.clone(),endpoint,request,tx.clone(),credits.clone()));
                                        job_ids.insert(abort.id(),id);
                                        active.insert(id,Active{abort,credits});
                                    }
                                    (validation,_) => {
                                        let error = validation.err().unwrap_or_else(|| "target unavailable or not configured on this connector".into());
                                        if tx.try_send(protocol::message(json!({"type":"response_error","id":id,"error":error}))).is_err() { break "WebSocket writer is congested"; }
                                    }
                                }
                            }
                            Incoming::Command {id,action,arguments} => {
                                if commands.contains_key(&id) || active.contains_key(&id) { break "duplicate active command UUID"; }
                                if commands.len() >= 4 {
                                    if tx.try_send(protocol::message(json!({"type":"command_error","id":id,"error":"connector allows at most 4 concurrent commands"}))).is_err() { break "WebSocket writer is congested"; }
                                    continue;
                                }
                                let abort = jobs.spawn(command_task(config.clone(),id,action,arguments,client.clone(),tx.clone(),attach_lock.clone()));
                                job_ids.insert(abort.id(),id);
                                commands.insert(id,abort);
                            }
                        }
                    }
                    _ => break "protocol v1 requires text JSON frames",
                }
            }
        }
    };
    // Cancel children first; bound graceful cleanup, then dropping their owners kills them.
    shutdown.cancel();
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    let _ = tokio::time::timeout(Duration::from_secs(4), async {
        while targets.join_next().await.is_some() {}
    })
    .await;
    targets.abort_all();
    while targets.join_next().await.is_some() {}
    writer.abort();
    if stop.is_cancelled() {
        Ok(())
    } else {
        Err(reason.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn http_stream_filters_headers_and_does_not_follow_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let size = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]).to_lowercase();
            assert!(!request.contains("authorization:"));
            assert!(!request.contains("cookie:"));
            assert!(request.contains("mcp-session-id: abc"));
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://192.0.2.1/private\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nSet-Cookie: secret=yes\r\nMcp-Session-Id: next\r\nConnection: close\r\n\r\nhello").await.unwrap();
        });
        let endpoint = crate::config::local_endpoint(&format!("http://{address}")).unwrap();
        let headers = HashMap::from([
            ("Authorization".into(), "secret".into()),
            ("Cookie".into(), "secret".into()),
            ("Mcp-Session-Id".into(), "abc".into()),
        ]);
        let id = Uuid::new_v4();
        let request = HttpRequest::validate(id, "POST", "/mcp".into(), headers, "", 1000).unwrap();
        let (tx, mut rx) = mpsc::channel(32);
        stream_http(
            &http_client().unwrap(),
            &endpoint,
            request,
            &tx,
            &Credits::new(),
        )
        .await
        .unwrap();
        let start: Value =
            serde_json::from_str(rx.recv().await.unwrap().to_text().unwrap()).unwrap();
        assert_eq!(start["type"], "response_start");
        assert_eq!(start["status"], 302);
        assert_eq!(
            start["headers"],
            json!({"content-type":"text/plain","mcp-session-id":"next"})
        );
        let chunk: Value =
            serde_json::from_str(rx.recv().await.unwrap().to_text().unwrap()).unwrap();
        assert_eq!(
            STANDARD
                .decode(chunk["data_base64"].as_str().unwrap())
                .unwrap(),
            b"hello"
        );
        let end: Value = serde_json::from_str(rx.recv().await.unwrap().to_text().unwrap()).unwrap();
        assert_eq!(end["type"], "response_end");
        server.await.unwrap();
    }
}
