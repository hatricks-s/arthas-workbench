// Opt-in offline fixture. Never invokes a JDK, kubectl or a shell.
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    time::Duration,
};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap();
    if args.iter().any(|a| a == "-lv") {
        println!("4242 example.Main -Xmx128m\n5555 sun.tools.jps.Jps -lv");
        return;
    }
    if args.iter().any(|a| a == "--attach-only") {
        let value = |key: &str| args[args.iter().position(|a| a == key).unwrap() + 1].clone();
        let home = PathBuf::from(value("--arthas-home"));
        assert_eq!(home, cwd);
        assert_eq!(value("--telnet-port"), "-1");
        assert_eq!(value("--target-ip"), "127.0.0.1");
        assert_eq!(args.last().unwrap(), "4242");
        let properties = std::fs::read_to_string(home.join("arthas.properties")).unwrap();
        assert!(properties.contains("arthas.config.overrideAll=true"));
        assert!(properties.contains("arthas.mcpEndpoint=/mcp"));
        std::fs::write(
            home.join("fixture-argv.json"),
            serde_json::to_vec(&args).unwrap(),
        )
        .unwrap();
        let root = home.parent().unwrap().parent().unwrap().parent().unwrap();
        std::fs::write(root.join("fixture-attach-port"), value("--http-port")).unwrap();
        println!("offline fixture attach completed");
        return;
    }
    if args.iter().any(|a| a == "port-forward") {
        let at = args.iter().position(|a| a == "port-forward").unwrap();
        assert_eq!(args[at + 1], "pod/pod-name");
        let port: u16 = args[at + 2].split(':').next().unwrap().parse().unwrap();
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
        listener.set_nonblocking(true).unwrap();
        std::fs::write(cwd.join("fixture-forward-port"), port.to_string()).unwrap();
        println!("Forwarding from 127.0.0.1:{port} -> 8563");
        std::io::stdout().flush().unwrap();
        while !cwd.join("fixture-forward-exit").exists() {
            if let Ok((mut stream, _)) = listener.accept() {
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        eprintln!("fixture child stopped");
        return;
    }
    eprintln!("unexpected fake command arguments");
    std::process::exit(2);
}
