use crate::config::{local_endpoint, Config, Target};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    task::JoinHandle,
};

const OUTPUT_LIMIT: usize = 16 * 1024;

pub fn command(executable: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(executable);
    cmd.current_dir(cwd).stdin(Stdio::null()).kill_on_drop(true);
    // Isolate JVM temp files and kubectl caches from the invoking shell's workspace.
    cmd.env("TMP", cwd)
        .env("TEMP", cwd)
        .env("TMPDIR", cwd)
        .env("HOME", cwd)
        .env("USERPROFILE", cwd)
        .env("XDG_CACHE_HOME", cwd.join("cache"))
        .env("XDG_CONFIG_HOME", cwd.join("config"));
    #[cfg(windows)]
    cmd.creation_flags(0x08000000 | 0x00000004); // CREATE_NO_WINDOW | CREATE_SUSPENDED
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    cmd
}

// Start Windows children suspended, assign their job, then resume the owned thread.
// This closes the assignment race in which a cmd wrapper could spawn an orphan.
#[cfg(windows)]
struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    fn own(child: &Child) -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                    THREADENTRY32,
                },
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
            },
        };
        // Handles always refer to this newly spawned child, never a caller-provided PID.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("cannot create owned Windows process job".into());
            }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err("cannot configure owned Windows process job".into());
            }
            let process = child
                .raw_handle()
                .ok_or("owned Windows child has no process handle")?;
            if AssignProcessToJobObject(handle, process as _) == 0 {
                return Err(
                    "cannot assign owned child to Windows job; nested-job policy may forbid it"
                        .into(),
                );
            }
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("cannot inspect the suspended owned child thread".into());
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let pid = child.id().ok_or("owned child exited before resume")?;
            let mut found = false;
            let mut exists = Thread32First(snapshot, &mut entry);
            while exists != 0 {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        found = ResumeThread(thread) != u32::MAX;
                        CloseHandle(thread);
                    }
                    break;
                }
                exists = Thread32Next(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            if !found {
                return Err("cannot resume the suspended owned child thread".into());
            }
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(unix)]
struct ProcessTree(u32);
#[cfg(unix)]
impl ProcessTree {
    fn own(child: &Child) -> Result<Self, String> {
        Ok(Self(child.id().ok_or(
            "owned child exited before process group registration",
        )?))
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

struct Captured {
    task: JoinHandle<()>,
    bytes: Arc<Mutex<VecDeque<u8>>>,
}
impl Captured {
    fn start<R: AsyncRead + Unpin + Send + 'static>(mut reader: R) -> Self {
        let bytes = Arc::new(Mutex::new(VecDeque::with_capacity(OUTPUT_LIMIT)));
        let sink = bytes.clone();
        let task = tokio::spawn(async move {
            let mut buf = [0; 4096];
            loop {
                let count = match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut out = sink.lock().unwrap();
                for byte in &buf[..count] {
                    if out.len() == OUTPUT_LIMIT {
                        out.pop_front();
                    }
                    out.push_back(*byte);
                }
            }
        });
        Self { task, bytes }
    }
    fn text(&self) -> String {
        let bytes: Vec<u8> = self.bytes.lock().unwrap().iter().copied().collect();
        String::from_utf8_lossy(&bytes).trim().to_string()
    }
}
impl Drop for Captured {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct OwnedProcess {
    child: Child,
    tree: Option<ProcessTree>,
    stdout: Captured,
    stderr: Captured,
}
impl OwnedProcess {
    fn spawn(cmd: &mut Command) -> Result<Self, String> {
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "failed to start executable ({:?}); check its path and permissions",
                e.kind()
            )
        })?;
        let tree = ProcessTree::own(&child)?;
        let stdout = Captured::start(child.stdout.take().unwrap());
        let stderr = Captured::start(child.stderr.take().unwrap());
        Ok(Self {
            child,
            tree: Some(tree),
            stdout,
            stderr,
        })
    }
    pub fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }
    pub async fn stop(&mut self) {
        self.tree.take();
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
    }
    async fn output(mut self, timeout: Duration) -> Result<Output, String> {
        let status = match tokio::time::timeout(timeout, self.child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(_)) => return Err("failed while waiting for child process".into()),
            Err(_) => {
                self.stop().await;
                return Err("command timed out; owned process was terminated".into());
            }
        };
        // Finite EOF drain; a descendant must not keep the pipe open indefinitely.
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut self.stdout.task).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut self.stderr.task).await;
        Ok(Output {
            success: status.success(),
            stdout: self.stdout.text(),
            stderr: self.stderr.text(),
        })
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct JavaProcess {
    pub pid: u32,
    pub identity: String,
}
pub fn parse_jps(text: &str) -> Vec<JavaProcess> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let split = line.find(char::is_whitespace)?;
            let pid = line[..split].parse::<u32>().ok()?;
            let identity = line[split..].trim();
            if pid == 0
                || identity.is_empty()
                || identity.split_whitespace().next().is_some_and(|v| {
                    matches!(v, "sun.tools.jps.Jps" | "jdk.jcmd/sun.tools.jps.Jps")
                })
            {
                return None;
            }
            Some(JavaProcess {
                pid,
                identity: identity.into(),
            })
        })
        .collect()
}

pub async fn scan(config: &Config) -> Value {
    let mut cmd = command(&config.jps, &config.data_dir);
    cmd.args(["-J-XX:-UsePerfData", "-lv"]);
    let result = match OwnedProcess::spawn(&mut cmd) {
        Ok(child) => child.output(Duration::from_secs(8)).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(output) if output.success => {
            json!({"processes":parse_jps(&output.stdout),"available":true,"detail":"jps -lv; identities must match exactly before attach"})
        }
        Ok(_) => {
            json!({"processes":[],"available":false,"detail":"jps failed; configure a working JDK jps and run as the JVM owner"})
        }
        Err(error) => json!({"processes":[],"available":false,"detail":error}),
    }
}

pub fn port_forward_args(target: &Target, port: u16, cache: &Path) -> Result<Vec<String>, String> {
    let Target::K8s {
        kubeconfig,
        namespace,
        pod,
        remote_port,
        ..
    } = target
    else {
        return Err("not a Kubernetes target".into());
    };
    // A pod shares its network namespace: kubectl port-forward has no container option.
    Ok(vec![
        "--kubeconfig".into(),
        kubeconfig.to_string_lossy().into(),
        "--cache-dir".into(),
        cache.to_string_lossy().into(),
        "-n".into(),
        namespace.clone(),
        "port-forward".into(),
        format!("pod/{pod}"),
        format!("{port}:{remote_port}"),
        "--address".into(),
        "127.0.0.1".into(),
    ])
}

pub async fn forward(config: &Config, target: &Target) -> Result<(OwnedProcess, url::Url), String> {
    let Target::K8s { kubeconfig, .. } = target else {
        return Err("not a Kubernetes target".into());
    };
    if !kubeconfig.is_file() {
        return Err("kubeconfig file is missing or unreadable".into());
    }
    ensure_plain_directory(&config.data_dir.join("kube-cache"))?;
    for _ in 0..3 {
        // Reserve a free loopback port until immediately before spawning kubectl; retry races.
        let reservation = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "unable to allocate a loopback port")?;
        let port = reservation
            .local_addr()
            .map_err(|_| "unable to inspect loopback port")?
            .port();
        let mut cmd = command(&config.kubectl, &config.data_dir);
        cmd.args(port_forward_args(
            target,
            port,
            &config.data_dir.join("kube-cache"),
        )?);
        drop(reservation);
        let mut child = OwnedProcess::spawn(&mut cmd)?;
        let expected = format!("Forwarding from 127.0.0.1:{port} ->");
        let mut ready = false;
        for _ in 0..80 {
            if child.exited() {
                break;
            }
            // Observe kubectl's own bind confirmation, never an unrelated port occupant.
            if child.stdout.text().contains(&expected) || child.stderr.text().contains(&expected) {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if ready {
            return Ok((
                child,
                local_endpoint(&format!("http://127.0.0.1:{port}")).unwrap(),
            ));
        }
        child.stop().await;
    }
    Err("port-forward failed after 3 attempts; check kubectl, kubeconfig credentials, RBAC, pod and remote port; reconnect retries".into())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachArgs {
    pub target_id: String,
    pub pid: u32,
    pub identity: String,
}

// Refuse links anywhere we write. Distribution links are also refused during copying.
pub fn ensure_plain_directory(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("data paths cannot contain symlinks or junctions".into())
            }
            Ok(meta) if !meta.is_dir() => return Err("data path is not a directory".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("data path cannot be inspected".into()),
            _ => {}
        }
    }
    std::fs::create_dir_all(path).map_err(|_| "cannot create writable data directory".into())
}

fn copy_distribution(source: &Path, destination: &Path) -> Result<(), String> {
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
    let mut count = 0;
    let mut total = 0u64;
    while let Some((from, to)) = pending.pop() {
        ensure_plain_directory(&to)?;
        for entry in std::fs::read_dir(&from).map_err(|_| "cannot read arthas_home distribution")? {
            let entry = entry.map_err(|_| "cannot read Arthas distribution entry")?;
            let kind = entry
                .file_type()
                .map_err(|_| "cannot inspect Arthas distribution entry")?;
            if kind.is_symlink() {
                return Err("arthas_home must not contain symlinks or junctions".into());
            }
            let name = entry.file_name();
            if name == "arthas.properties" {
                continue;
            }
            if kind.is_dir() {
                if pending.len() >= 1024 {
                    return Err("Arthas distribution contains too many directories".into());
                }
                pending.push((entry.path(), to.join(name)));
            } else if kind.is_file() {
                count += 1;
                total += entry
                    .metadata()
                    .map_err(|_| "cannot inspect Arthas distribution file")?
                    .len();
                if count > 4096 || total > 512 * 1024 * 1024 {
                    return Err("Arthas distribution exceeds 4096 files or 512 MiB".into());
                }
                std::fs::copy(entry.path(), to.join(name))
                    .map_err(|_| "cannot copy Arthas distribution into data_dir")?;
            } else {
                return Err("unsupported special file in Arthas distribution".into());
            }
        }
    }
    Ok(())
}

pub fn stage(config: &Config, target_id: &str, port: u16) -> Result<PathBuf, String> {
    let source = config
        .arthas_home
        .as_ref()
        .ok_or("attach requires arthas_home")?;
    for name in [
        "arthas-boot.jar",
        "arthas-core.jar",
        "arthas-agent.jar",
        "arthas-spy.jar",
    ] {
        if !source.join(name).is_file() {
            return Err(format!(
                "arthas_home must contain {name}; provide a complete offline Arthas distribution"
            ));
        }
    }
    let source = std::fs::canonicalize(source).map_err(|_| "cannot resolve arthas_home")?;
    let data_dir =
        std::fs::canonicalize(&config.data_dir).map_err(|_| "cannot resolve data_dir")?;
    if data_dir.starts_with(&source) {
        return Err("data_dir must not be inside arthas_home; choose separate directories to avoid recursively copying staged homes".into());
    }
    let base = config.data_dir.join("attach").join(target_id);
    ensure_plain_directory(&base)?;
    // Fresh directory avoids modifying jars still used by an earlier attached JVM.
    let home = base.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&home).map_err(|_| "cannot create isolated Arthas home")?;
    if let Err(error) = copy_distribution(&source, &home) {
        let _ = std::fs::remove_dir_all(&home);
        return Err(error);
    }
    // Official docs: CLI > env > system properties > arthas.properties unless overrideAll=true.
    // https://arthas.aliyun.com/en/doc/arthas-properties.html
    let properties = format!("arthas.config.overrideAll=true\narthas.httpPort={port}\narthas.telnetPort=-1\narthas.ip=127.0.0.1\narthas.mcpEndpoint=/mcp\narthas.localConnectionNonAuth=true\n");
    std::fs::write(home.join("arthas.properties"), properties)
        .map_err(|_| "cannot write isolated arthas.properties")?;
    Ok(home)
}

pub fn attach_argv(home: &Path, pid: u32, port: u16) -> Vec<String> {
    vec![
        format!("-Duser.home={}", home.display()),
        format!("-Djava.io.tmpdir={}", home.display()),
        "-XX:-UsePerfData".into(),
        "-jar".into(),
        home.join("arthas-boot.jar").to_string_lossy().into(),
        "--arthas-home".into(),
        home.to_string_lossy().into(),
        "--attach-only".into(),
        "--http-port".into(),
        port.to_string(),
        "--telnet-port".into(),
        "-1".into(),
        "--target-ip".into(),
        "127.0.0.1".into(),
        pid.to_string(),
    ]
}

pub async fn probe(client: &reqwest::Client, endpoint: &url::Url) -> bool {
    let mut url = endpoint.clone();
    url.set_path("/mcp");
    match client
        .get(url)
        .header("accept", "application/json, text/event-stream")
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => {
            response.status().is_success()
                || response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED
                || response.status() == reqwest::StatusCode::BAD_REQUEST
                || response.status() == reqwest::StatusCode::NOT_ACCEPTABLE
        }
        Err(_) => false,
    }
}

pub async fn attach(
    config: &Config,
    args: AttachArgs,
    client: &reqwest::Client,
) -> Result<Value, String> {
    if !config.allow_attach {
        return Err("attach_local is disabled; set allow_attach=true and configure an offline arthas_home on this node".into());
    }
    if args.pid == 0 || args.identity.trim().is_empty() {
        return Err("attach requires a positive pid and exact scanned identity".into());
    }
    let target = config
        .targets
        .iter()
        .find(|target| target.id() == args.target_id)
        .ok_or("target_id is not configured on this connector")?;
    let Target::Local { endpoint, .. } = target else {
        return Err("attach_local only supports configured local targets".into());
    };
    let endpoint = local_endpoint(endpoint)?;
    if endpoint.host_str() != Some("127.0.0.1") {
        return Err("attach_local requires an endpoint on 127.0.0.1 or localhost because Arthas binds --target-ip 127.0.0.1".into());
    }
    let scanned = scan(config).await;
    if scanned["available"] != true {
        return Err(
            "cannot verify Java identity; configure a working jps and retry scan_java".into(),
        );
    }
    let processes: Vec<JavaProcess> =
        serde_json::from_value(scanned["processes"].clone()).unwrap_or_default();
    if !processes
        .iter()
        .any(|p| p.pid == args.pid && p.identity == args.identity)
    {
        return Err("PID or identity changed since scan; run scan_java again and explicitly select the process".into());
    }
    let port = endpoint
        .port_or_known_default()
        .ok_or("endpoint has no port")?;
    let reservation = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,port)).map_err(|_| "local endpoint port is already occupied; cannot establish ownership of an existing Arthas instance")?;
    // Copy synchronously so cancellation cannot leave a detached filesystem writer behind.
    let home = stage(config, target.id(), port)?;
    let mut cmd = command(&config.java, &home);
    cmd.args(attach_argv(&home, args.pid, port));
    // Prevent injected JVM flags from changing this explicitly configured bootstrap invocation.
    cmd.env_remove("JAVA_TOOL_OPTIONS")
        .env_remove("JDK_JAVA_OPTIONS")
        .env_remove("_JAVA_OPTIONS");
    drop(reservation);
    let output = OwnedProcess::spawn(&mut cmd)?
        .output(Duration::from_secs(45))
        .await?;
    let stdout = output.stdout.replace(&config.token, "[redacted]");
    let stderr = output.stderr.replace(&config.token, "[redacted]");
    if !output.success {
        return Err(format!("Arthas bootstrap failed; verify matching JDK, JVM ownership and offline distribution. stdout: {stdout}; stderr: {stderr}"));
    }
    for _ in 0..20 {
        if probe(client, &endpoint).await {
            return Ok(
                json!({"success":true,"target_id":args.target_id,"pid":args.pid,"stdout":stdout,"stderr":stderr,"detail":"isolated bootstrap completed and the configured /mcp endpoint responded"}),
            );
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!("Arthas exited successfully but /mcp did not respond on the configured port; verify this distribution supports MCP. stdout: {stdout}; stderr: {stderr}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_parser_retains_identity_and_excludes_jps() {
        assert_eq!(
            parse_jps("123 app.Main -Xmx2g\n456 sun.tools.jps.Jps -lv\nbad\n0 nope\n"),
            vec![JavaProcess {
                pid: 123,
                identity: "app.Main -Xmx2g".into()
            }]
        );
    }
    #[test]
    fn commands_use_explicit_argv_and_no_shell() {
        let target = Target::K8s {
            id: "pod".into(),
            name: "Pod".into(),
            kubeconfig: PathBuf::from("/private/kube config"),
            namespace: "ns".into(),
            pod: "pod-name".into(),
            container: Some("app".into()),
            remote_port: 8563,
        };
        let argv = port_forward_args(&target, 12345, Path::new("/data/cache")).unwrap();
        assert!(argv
            .windows(2)
            .any(|w| w == ["--kubeconfig", "/private/kube config"]));
        assert!(argv.windows(2).any(|w| w == ["--address", "127.0.0.1"]));
        assert!(argv.contains(&"12345:8563".into()));
        assert!(argv.contains(&"pod/pod-name".into()));
        assert!(!argv.contains(&"app".into()));
        let argv = attach_argv(Path::new("/data/home"), 42, 8563);
        assert!(argv.windows(2).any(|w| w == ["--telnet-port", "-1"]));
        assert!(argv.windows(2).any(|w| w == ["--target-ip", "127.0.0.1"]));
        assert!(argv.contains(&"--arthas-home".into()));
    }
}
