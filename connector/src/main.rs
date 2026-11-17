mod config;
mod process;
mod protocol;
mod session;

use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

fn load() -> Result<config::Config, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 || args[0] != "--config" {
        return Err("usage: arthas-connector --config ABSOLUTE_JSON_PATH".into());
    }
    let path = PathBuf::from(&args[1]);
    config::absolute(&path, "--config")?;
    let metadata = std::fs::metadata(&path).map_err(|_| "cannot read config file")?;
    if metadata.len() > 1024 * 1024 {
        return Err("config file exceeds 1 MiB".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "cannot read config file")?;
    // serde diagnostics can echo values; omit the text so tokens never enter logs.
    let config: config::Config = serde_json::from_slice(&bytes).map_err(|error| format!("invalid config schema/JSON at line {}, column {}; check required fields, unknown fields, target kind and value types",error.line(),error.column()))?;
    config.validate()?;
    Ok(config)
}

#[tokio::main]
async fn main() {
    let config = match load() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    if let Err(error) = process::ensure_plain_directory(&config.data_dir) {
        eprintln!("{error}");
        std::process::exit(2);
    }
    let stop = CancellationToken::new();
    let signal = stop.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            if let Ok(mut term) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        signal.cancel();
    });
    let mut delay = 1u64;
    while !stop.is_cancelled() {
        let started = tokio::time::Instant::now();
        if let Err(error) = session::connection(config.clone(), stop.clone()).await {
            eprintln!("{error}; reconnecting in {delay}s");
        }
        if stop.is_cancelled() {
            break;
        }
        if started.elapsed() > Duration::from_secs(60) {
            delay = 1;
        }
        tokio::select! { _ = stop.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
        delay = (delay * 2).min(15);
    }
    eprintln!("connector stopped; owned requests and port-forward processes cleaned up");
}
