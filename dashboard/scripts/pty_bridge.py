#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import pty
import select
import signal
import subprocess
import sys
from typing import NoReturn


child_process: subprocess.Popen[bytes] | None = None
master_fd: int | None = None


def terminate_child() -> None:
    global child_process
    if child_process is None or child_process.poll() is not None:
        return
    try:
        os.killpg(child_process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return


def handle_signal(signum: int, _frame: object) -> NoReturn:
    terminate_child()
    raise SystemExit(128 + signum)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="PTY bridge for the Opseeq dashboard terminal")
    parser.add_argument("--cwd", default=None, help="Working directory for the child shell")
    parser.add_argument("--command", required=True, help="Shell command to run inside the PTY")
    return parser


def main(argv: list[str] | None = None) -> int:
    global child_process
    global master_fd

    args = build_parser().parse_args(argv)
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    master_fd, slave_fd = pty.openpty()
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")

    child_process = subprocess.Popen(
        ["/bin/sh", "-c", args.command],
        cwd=args.cwd or None,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=env,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave_fd)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    try:
        while True:
            readable, _, _ = select.select([master_fd, stdin_fd], [], [], 0.1)

            if master_fd in readable:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    data = b""
                if not data:
                    break
                os.write(stdout_fd, data)

            if stdin_fd in readable:
                data = os.read(stdin_fd, 4096)
                if data:
                    os.write(master_fd, data)

            if child_process.poll() is not None and not readable:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    data = b""
                if data:
                    os.write(stdout_fd, data)
                    continue
                break
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        terminate_child()

    return child_process.wait() if child_process is not None else 0


if __name__ == "__main__":
    raise SystemExit(main())
