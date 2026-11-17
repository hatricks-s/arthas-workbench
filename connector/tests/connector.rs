use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_tungstenite::{
    tungstenite::{
        handshake::server::{Request, Response},
        Message,
    },
    WebSocketStream,
};
use uuid::Uuid;

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-data")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn recv(ws: &mut WebSocketStream<TcpStream>) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("timed out waiting for connector")
            .unwrap()
            .unwrap();
        match frame {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(data) => ws.send(Message::Pong(data)).await.unwrap(),
            other => panic!("unexpected connector frame {other:?}"),
        }
    }
}
async fn send(ws: &mut WebSocketStream<TcpStream>, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn result(ws: &mut WebSocketStream<TcpStream>, id: Uuid) -> Value {
    loop {
        let value = recv(ws).await;
        if value["id"] == id.to_string() {
            return value;
        }
    }
}
async fn wait_file(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn outbound_handshake_attach_stream_cancel_and_owned_forward_cleanup() {
    let temp = TestDir::new();
    let data = temp.0.join("data");
    let home = temp.0.join("offline-home");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    for name in [
        "arthas-boot.jar",
        "arthas-core.jar",
        "arthas-agent.jar",
        "arthas-spy.jar",
    ] {
        std::fs::write(home.join(name), b"not a real jar").unwrap();
    }
    std::fs::write(home.join("arthas.properties"), "must stay unchanged").unwrap();
    let kube = temp.0.join("kubeconfig");
    std::fs::write(&kube, "offline fixture only").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let local_port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let config = json!({"server_url":format!("ws://{}/connectors/ws",listener.local_addr().unwrap()),"node_id":"test-node","token":"fixture-secret",
        "targets":[{"id":"local","name":"Local JVM","kind":"local","endpoint":format!("http://127.0.0.1:{local_port}")},
        {"id":"pod","name":"Pod JVM","kind":"k8s","kubeconfig":kube,"namespace":"ns","pod":"pod-name","container":"app","remote_port":8563}],
        "kubectl":env!("CARGO_BIN_EXE_connector-test-tool"),"java":env!("CARGO_BIN_EXE_connector-test-tool"),"jps":env!("CARGO_BIN_EXE_connector-test-tool"),
        "arthas_home":home,"allow_attach":true,"data_dir":data});
    let path = temp.0.join("config.json");
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_arthas-connector"));
    command
        .args(["--config", path.to_str().unwrap()])
        .current_dir(&temp.0)
        .env("TMP", &data)
        .env("TEMP", &data)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().unwrap();
    let (tcp, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut ws =
        tokio_tungstenite::accept_hdr_async(tcp, |request: &Request, response: Response| {
            assert_eq!(request.headers()["authorization"], "Bearer fixture-secret");
            assert_eq!(request.headers()["x-node-id"], "test-node");
            Ok(response)
        })
        .await
        .unwrap();
    let hello = recv(&mut ws).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["version"], 1);
    assert_eq!(hello["capabilities"], json!(["scan_java", "attach_local"]));
    assert!(!hello.to_string().contains("fixture-secret"));
    assert!(!hello.to_string().contains("kubeconfig"));
    assert!(!hello.to_string().contains("endpoint"));
    let mut pod_ready = false;
    let mut local_unavailable = false;
    while !pod_ready || !local_unavailable {
        let value = recv(&mut ws).await;
        if value["type"] == "target_status" && value["target_id"] == "pod" {
            assert_eq!(value["status"], "ready", "{value}");
            pod_ready = true;
        }
        if value["type"] == "target_status" && value["target_id"] == "local" {
            assert_eq!(value["status"], "unavailable");
            local_unavailable = true;
        }
    }
    // A fixture must not reply before the request has arrived, including when
    // Windows accept() inherits the nonblocking listener mode. Fragment headers
    // deliberately so a single read() cannot accidentally make this test pass.
    let fixture_port: u16 = std::fs::read_to_string(data.join("fixture-forward-port"))
        .unwrap()
        .parse()
        .unwrap();
    let mut probe = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, fixture_port))
        .await
        .unwrap();
    let mut first = [0; 1];
    assert!(
        tokio::time::timeout(Duration::from_millis(100), probe.read(&mut first))
            .await
            .is_err(),
        "fixture must wait for an HTTP request before replying"
    );
    probe.write_all(b"GET /mcp HTTP/1.1\r\n").await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), probe.read(&mut first))
            .await
            .is_err(),
        "fixture must wait for the complete HTTP headers"
    );
    probe
        .write_all(b"Host: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), probe.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
    assert!(response.ends_with(b"\r\n\r\n{}"));

    let scan = Uuid::new_v4();
    send(
        &mut ws,
        json!({"type":"command","id":scan,"action":"scan_java","arguments":{}}),
    )
    .await;
    let scan = result(&mut ws, scan).await;
    assert_eq!(
        scan["result"]["processes"],
        json!([{"pid":4242,"identity":"example.Main -Xmx128m"}])
    );
    let invalid = Uuid::new_v4();
    send(&mut ws,json!({"type":"command","id":invalid,"action":"attach_local","arguments":{"target_id":"local","pid":4242,"identity":"stale identity"}})).await;
    assert_eq!(result(&mut ws, invalid).await["type"], "command_error");
    assert!(!data.join("attach").exists());

    // Bind the fake upstream only after the fake bootstrap writes its marker.
    let marker = data.join("fixture-attach-port");
    let upstream = tokio::spawn(async move {
        wait_file(&marker).await;
        let port: u16 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut bytes = [0; 8192];
                let count = socket.read(&mut bytes).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&bytes[..count]).to_lowercase();
                assert!(!request.contains("authorization:"));
                assert!(!request.contains("cookie:"));
                if request.contains("mcp-session-id: slow") {
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await;
                    let mut buf = [0; 1];
                    let _ = socket.read(&mut buf).await;
                } else if request.contains("mcp-session-id: large") {
                    let body = vec![b'x'; 64 * 1024 * 10 + 19];
                    let headers=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: kept\r\nSet-Cookie: hidden=yes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                    let _ = socket.write_all(headers.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                } else {
                    let _=socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await;
                }
            });
        }
    });
    let attach = Uuid::new_v4();
    send(&mut ws,json!({"type":"command","id":attach,"action":"attach_local","arguments":{"target_id":"local","pid":4242,"identity":"example.Main -Xmx128m"}})).await;
    let attached = result(&mut ws, attach).await;
    assert_eq!(attached["type"], "command_result", "{attached}");
    assert_eq!(attached["result"]["success"], true);
    assert_eq!(
        std::fs::read_to_string(home.join("arthas.properties")).unwrap(),
        "must stay unchanged"
    );
    let staged = std::fs::read_dir(data.join("attach/local"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(staged.join("fixture-argv.json").is_file());
    assert!(staged.join("arthas-core.jar").is_file());

    let id = Uuid::new_v4();
    send(&mut ws,json!({"type":"request","id":id,"target_id":"local","method":"POST","path":"/mcp","headers":{"Authorization":"drop","Cookie":"drop","Host":"evil","Mcp-Session-Id":"large"},"body_base64":"e30=","timeout_ms":10000})).await;
    let start = result(&mut ws, id).await;
    assert_eq!(start["type"], "response_start");
    assert_eq!(
        start["headers"],
        json!({"content-type":"application/json","mcp-session-id":"kept"})
    );
    let mut total = 0;
    for _ in 0..8 {
        let frame = result(&mut ws, id).await;
        assert_eq!(frame["type"], "response_chunk");
        let bytes = STANDARD
            .decode(frame["data_base64"].as_str().unwrap())
            .unwrap();
        assert!(bytes.len() <= 64 * 1024);
        total += bytes.len();
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(80), ws.next())
            .await
            .is_err(),
        "ninth chunk must wait for ACK"
    );
    for _ in 0..8 {
        send(&mut ws, json!({"type":"ack","id":id})).await;
    }
    loop {
        let frame = result(&mut ws, id).await;
        if frame["type"] == "response_end" {
            break;
        }
        assert_eq!(frame["type"], "response_chunk");
        let bytes = STANDARD
            .decode(frame["data_base64"].as_str().unwrap())
            .unwrap();
        assert!(bytes.len() <= 64 * 1024);
        total += bytes.len();
        send(&mut ws, json!({"type":"ack","id":id})).await;
    }
    assert_eq!(total, 64 * 1024 * 10 + 19);

    let mut waiting = Vec::new();
    for _ in 0..16 {
        let id = Uuid::new_v4();
        waiting.push(id);
        send(&mut ws,json!({"type":"request","id":id,"target_id":"local","method":"GET","path":"/mcp","headers":{"mcp-session-id":"slow"},"body_base64":"","timeout_ms":10000})).await;
        assert_eq!(result(&mut ws, id).await["type"], "response_start");
    }
    let excess = Uuid::new_v4();
    send(&mut ws,json!({"type":"request","id":excess,"target_id":"local","method":"GET","path":"/mcp","headers":{},"body_base64":"","timeout_ms":10000})).await;
    assert_eq!(result(&mut ws, excess).await["type"], "response_error");
    for id in waiting {
        send(&mut ws, json!({"type":"cancel","id":id})).await;
    }
    let id = Uuid::new_v4();
    send(&mut ws,json!({"type":"request","id":id,"target_id":"pod","method":"GET","path":"/mcp","headers":{},"body_base64":"","timeout_ms":10000})).await;
    let start = result(&mut ws, id).await;
    assert_eq!(start["type"], "response_start", "{start}");
    assert_eq!(result(&mut ws, id).await["type"], "response_chunk");
    assert_eq!(result(&mut ws, id).await["type"], "response_end");

    // A failed owned child changes status; subsequent connector reconnects restart it.
    std::fs::write(data.join("fixture-forward-exit"), "").unwrap();
    loop {
        let value = recv(&mut ws).await;
        if value["type"] == "target_status" && value["target_id"] == "pod" {
            assert_eq!(value["status"], "unavailable");
            break;
        }
    }
    std::fs::remove_file(data.join("fixture-forward-exit")).unwrap();
    ws.close(None).await.unwrap();
    let (tcp, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
    assert_eq!(recv(&mut ws).await["type"], "hello");
    loop {
        let value = recv(&mut ws).await;
        if value["type"] == "target_status" && value["target_id"] == "pod" {
            assert_eq!(value["status"], "ready");
            break;
        }
    }
    let forward_port: u16 = std::fs::read_to_string(data.join("fixture-forward-port"))
        .unwrap()
        .parse()
        .unwrap();
    ws.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            let connected = tokio::time::timeout(
                Duration::from_millis(500),
                TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, forward_port)),
            )
            .await;
            if !matches!(connected, Ok(Ok(_))) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("owned port-forward must be killed on WS loss");
    child.kill().await.unwrap();
    let _ = child.wait().await;
    upstream.abort();
    let _ = upstream.await;
}
