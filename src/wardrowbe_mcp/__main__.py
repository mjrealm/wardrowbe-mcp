import logging
import sys

import uvicorn

from . import __version__
from .app import SERVER_NAME, create_app
from .login import run_login
from .config import ConfigError, load_config


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "login":
        raise SystemExit(run_login())
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    try:
        config = load_config()
    except ConfigError as err:
        print(f"{SERVER_NAME}: {err}", file=sys.stderr)
        raise SystemExit(2) from err
    print(f"{SERVER_NAME} {__version__} listening on http://{config.host}:{config.port}/mcp", file=sys.stderr)
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="warning")


if __name__ == "__main__":
    main()
