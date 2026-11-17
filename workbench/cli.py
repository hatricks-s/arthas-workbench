from __future__ import annotations

import argparse
import sys

import uvicorn
from pydantic import ValidationError

from .app import create_app
from .config import ServerConfig


def main():
    parser = argparse.ArgumentParser(description="Arthas Web + MCP dual-path prototype")
    parser.add_argument("--config", required=True, help="absolute path to server JSON configuration")
    args = parser.parse_args()
    try:
        config = ServerConfig.load(args.config)
    except ValidationError as exc:
        # Pydantic's default exception rendering may include input tokens.
        print("Configuration errors: " + str(exc.errors(include_input=False, include_url=False)), file=sys.stderr)
        raise SystemExit(2)
    except (ValueError, OSError) as exc:
        print(f"Cannot load configuration: {exc}", file=sys.stderr)
        raise SystemExit(2)
    uvicorn.run(create_app(config), host=config.host, port=config.port,
                ws_max_size=128 * 1024, ws_ping_interval=20, ws_ping_timeout=20,
                access_log=False)


if __name__ == "__main__":
    main()
