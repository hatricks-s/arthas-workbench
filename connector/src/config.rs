use serde::Deserialize;
use std::{
    collections::HashSet,
    net::Ipv4Addr,
    path::{Path, PathBuf},
};
use url::{Host, Url};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub server_url: String,
    pub node_id: String,
    pub token: String,
    pub targets: Vec<Target>,
    #[serde(default = "default_kubectl")]
    pub kubectl: String,
    #[serde(default = "default_java")]
    pub java: String,
    #[serde(default = "default_jps")]
    pub jps: String,
    pub arthas_home: Option<PathBuf>,
    #[serde(default)]
    pub allow_attach: bool,
    pub data_dir: PathBuf,
}
fn default_kubectl() -> String {
    "kubectl".into()
}
fn default_java() -> String {
    "java".into()
}
fn default_jps() -> String {
    "jps".into()
}
fn default_remote_port() -> u16 {
    8563
}

// The enum deliberately rejects keys that belong to a different target kind.
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Target {
    Local {
        id: String,
        name: String,
        endpoint: String,
    },
    K8s {
        id: String,
        name: String,
        kubeconfig: PathBuf,
        namespace: String,
        pod: String,
        container: Option<String>,
        #[serde(default = "default_remote_port")]
        remote_port: u16,
    },
}
impl Target {
    pub fn id(&self) -> &str {
        match self {
            Self::Local { id, .. } | Self::K8s { id, .. } => id,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Self::Local { name, .. } | Self::K8s { name, .. } => name,
        }
    }
    pub fn kind(&self) -> &str {
        match self {
            Self::Local { .. } => "local",
            Self::K8s { .. } => "k8s",
        }
    }
}

pub fn safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn dns_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.as_bytes()[s.len() - 1].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn dns_subdomain(s: &str) -> bool {
    s.len() <= 253 && s.split('.').all(dns_label)
}

pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(name)) => name == "localhost",
        None => false,
    }
}

fn clean_url(raw: &str) -> Result<Url, String> {
    if raw.trim() != raw || raw.contains('\\') || raw.chars().any(char::is_control) {
        return Err("URL contains whitespace, control characters or backslashes".into());
    }
    let url = Url::parse(raw).map_err(|_| "invalid absolute URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("URL credentials, query strings and fragments are not allowed".into());
    }
    if url.host().is_none() || url.port() == Some(0) {
        return Err("URL needs a host and nonzero port".into());
    }
    // url normalizes exotic IPv4 encodings; require the original canonical dotted decimal form.
    if let Some(Host::Ipv4(ip)) = url.host() {
        let authority = raw
            .split_once("://")
            .ok_or("invalid URL")?
            .1
            .split('/')
            .next()
            .unwrap_or("");
        let raw_host = authority.split(':').next().unwrap_or("");
        if raw_host.parse::<Ipv4Addr>().ok() != Some(ip) || raw_host != ip.to_string() {
            return Err("IPv4 URLs must use canonical dotted decimal notation".into());
        }
    }
    Ok(url)
}

pub fn local_endpoint(raw: &str) -> Result<Url, String> {
    let mut url = clean_url(raw)?;
    let authority_and_path = raw.split_once("://").ok_or("invalid endpoint URL")?.1;
    let (authority, path) = authority_and_path
        .split_once('/')
        .unwrap_or((authority_and_path, ""));
    if !path.is_empty() || authority.contains('@') {
        return Err("local endpoint must be an origin without credentials or path segments".into());
    }
    if url.scheme() != "http" || !is_loopback(&url) || url.path() != "/" {
        return Err("local endpoint must be an HTTP loopback origin without a path".into());
    }
    // Never resolve localhost through DNS or the system hosts file.
    if url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| "invalid loopback host")?;
    }
    Ok(url)
}

pub fn server_endpoint(raw: &str) -> Result<Url, String> {
    let mut url = clean_url(raw)?;
    if url.scheme() != "wss" && !(url.scheme() == "ws" && is_loopback(&url)) {
        return Err("server_url requires wss except for a loopback ws connection".into());
    }
    if url.scheme() == "ws" && url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| "invalid loopback host")?;
    }
    Ok(url)
}

pub fn absolute(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "{label} cannot contain parent directory components"
        ));
    }
    Ok(())
}

impl Config {
    pub fn validate(&self) -> Result<(), String> {
        server_endpoint(&self.server_url)?;
        if !safe_id(&self.node_id) {
            return Err(
                "node_id must contain 1..128 ASCII letters, digits, underscores or hyphens".into(),
            );
        }
        if self.token.is_empty()
            || self.token.len() > 4096
            || !self.token.bytes().all(|b| (33..=126).contains(&b))
        {
            return Err(
                "token must contain 1..4096 visible ASCII characters without spaces".into(),
            );
        }
        absolute(&self.data_dir, "data_dir")?;
        for (label, executable) in [
            ("kubectl", &self.kubectl),
            ("java", &self.java),
            ("jps", &self.jps),
        ] {
            if executable.trim().is_empty() || executable.chars().any(char::is_control) {
                return Err(format!("{label} must be an executable name or path"));
            }
            if (executable.contains('/') || executable.contains('\\'))
                && !Path::new(executable).is_absolute()
            {
                return Err(format!("{label} path must be absolute"));
            }
        }
        if let Some(home) = &self.arthas_home {
            absolute(home, "arthas_home")?;
        }
        if self.allow_attach && self.arthas_home.is_none() {
            return Err(
                "allow_attach requires an explicit arthas_home containing local Arthas jars".into(),
            );
        }
        if self.targets.len() > 128 {
            return Err("at most 128 targets are allowed".into());
        }
        let mut ids = HashSet::new();
        for target in &self.targets {
            if !safe_id(target.id()) || !ids.insert(target.id()) {
                return Err("target ids must be unique and contain only ASCII letters, digits, underscores or hyphens".into());
            }
            if target.name().trim().is_empty()
                || target.name().len() > 256
                || target.name().chars().any(char::is_control)
            {
                return Err(format!("invalid target name for {}", target.id()));
            }
            match target {
                Target::Local { endpoint, .. } => {
                    local_endpoint(endpoint).map_err(|e| format!("target {}: {e}", target.id()))?;
                }
                Target::K8s {
                    kubeconfig,
                    namespace,
                    pod,
                    container,
                    remote_port,
                    ..
                } => {
                    absolute(kubeconfig, "kubeconfig")?;
                    if !dns_label(namespace)
                        || !dns_subdomain(pod)
                        || container.as_ref().is_some_and(|s| !dns_label(s))
                        || *remote_port == 0
                    {
                        return Err(format!(
                            "target {} has invalid Kubernetes namespace, pod, container or port",
                            target.id()
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_validation_blocks_ssrf_and_normalization_tricks() {
        for raw in [
            "http://127.0.0.1:8563",
            "http://127.2.3.4",
            "http://localhost:8563/",
            "http://[::1]:8563",
        ] {
            assert!(local_endpoint(raw).is_ok(), "{raw}");
        }
        for raw in [
            "http://169.254.169.254",
            "https://127.0.0.1",
            "http://127.1",
            "http://2130706433",
            "http://0x7f000001",
            "http://127.0.0.1.evil",
            "http://user:pw@127.0.0.1",
            "http://127.0.0.1/mcp",
            "http://127.0.0.1/?x=y",
            "http://[::ffff:127.0.0.1]",
            "http://127.0.0.1:0",
            " http://127.0.0.1",
        ] {
            assert!(local_endpoint(raw).is_err(), "{raw}");
        }
        assert_eq!(
            local_endpoint("http://localhost").unwrap().host_str(),
            Some("127.0.0.1")
        );
        assert!(server_endpoint("ws://example.org/connectors/ws").is_err());
        assert!(server_endpoint("wss://example.org/connectors/ws").is_ok());
        assert!(server_endpoint("ws://[::1]/connectors/ws").is_ok());
    }
    #[test]
    fn strict_target_schema() {
        assert!(serde_json::from_str::<Target>(r#"{"kind":"local","id":"a","name":"A","endpoint":"http://127.0.0.1","pod":"unexpected"}"#).is_err());
        assert!(serde_json::from_str::<Target>(r#"{"kind":"ssh","id":"a","name":"A"}"#).is_err());
        assert!(!safe_id("../outside"));
    }
}
