#!/usr/bin/env python3
"""Push a real missing-ConfigMap repair through the lab's ttyd terminal."""

import argparse
import base64
import json
import os
import socket
import struct
import subprocess
import time
from urllib.parse import quote

from live_mode_matrix import checked, forward, ready_run, wait_until


def send_frame(sock, payload, opcode=2):
    mask = os.urandom(4)
    length = len(payload)
    if length < 126:
        header = bytes([0x80 | opcode, 0x80 | length])
    elif length < 65536:
        header = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack("!H", length)
    else:
        header = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack("!Q", length)
    sock.sendall(header + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))


def read_frame(stream):
    header = stream.read(2)
    if len(header) != 2:
        raise RuntimeError("terminal WebSocket closed")
    length = header[1] & 0x7f
    if length == 126:
        length = struct.unpack("!H", stream.read(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", stream.read(8))[0]
    payload = stream.read(length)
    return header[0] & 0x0f, payload


def terminal_output(stream, connection, marker, seconds):
    markers = marker if isinstance(marker, tuple) else (marker,)
    deadline = time.monotonic() + seconds
    output = bytearray()
    while time.monotonic() < deadline:
        opcode, payload = read_frame(stream)
        if opcode == 2 and payload[:1] == b"0":
            output.extend(payload[1:])
            if any(item in output for item in markers):
                return bytes(output)
        elif opcode == 9:
            send_frame(connection, payload, opcode=10)
        elif opcode == 8:
            raise RuntimeError("terminal closed before command completed")
    raise TimeoutError("terminal command did not complete")


def prompt_events(context, run_id):
    code = ("import json,sys,pathlib; p=pathlib.Path('/tmp/argo-learning-events.jsonl'); "
            "print(json.dumps([r['action']['details'] for r in "
            "(json.loads(x) for x in p.read_text().splitlines()) "
            "if r.get('run') == sys.argv[1] and r.get('action',{}).get('type') == 'terminal_command']) "
            "if p.exists() else '[]')")
    result = subprocess.run([
        "kubectl", "--context", context, "-n", "applications", "exec", "deploy/learning-service",
        "--", "python3", "-c", code, run_id,
    ], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()
    if args.context == "default":
        parser.error("use the isolated lab context")
    base = f"http://127.0.0.1:{args.port}"
    process = forward(args.context, "lab-gateway", args.port, 8080)
    run_id = None
    connection = None
    try:
        created = checked(base, "/coach/learning/api/runs", "POST", {
            "scenario": "missing-configmap", "mode": "guided", "environment": "prod", "seed": 0,
        })
        run_id = created["run"]["id"]
        wait_until("READY", lambda: ready_run(base, "/coach/learning/api/runs/" + quote(run_id)))
        terminal_token = checked(base, "/terminal/token")["token"]
        connection = socket.create_connection(("127.0.0.1", args.port), timeout=15)
        connection.settimeout(30)
        stream = connection.makefile("rb")
        key = base64.b64encode(os.urandom(16)).decode()
        connection.sendall((
            "GET /terminal/ws HTTP/1.1\r\n" + f"Host: 127.0.0.1:{args.port}\r\n" +
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Protocol: tty\r\n\r\n"
        ).encode())
        status = stream.readline().decode().strip()
        while stream.readline().strip():
            pass
        if not status.startswith("HTTP/1.1 101"):
            raise RuntimeError("terminal WebSocket upgrade failed: " + status)
        send_frame(connection, json.dumps({"AuthToken": terminal_token, "columns": 100, "rows": 30}).encode())
        terminal_output(stream, connection, (b"$ ", b"# "), 60)
        marker = "ARGO_GIT_FIX_EXIT"
        command = (
            "git fetch --depth=1 origin refs/tags/baseline:refs/tags/baseline && "
            "git checkout baseline -- chart/django-app/templates/deployment.yaml && "
            "git add chart/django-app/templates/deployment.yaml && "
            "git commit -m 'fix: restore required ConfigMap reference' && "
            "git push origin main; " + f"echo {marker}:$?"
        )
        send_frame(connection, b"0" + command.encode() + b"\r")
        output = terminal_output(stream, connection, (marker + ":0").encode(), 180)
        if b"fix: restore required ConfigMap reference" not in output:
            raise AssertionError("terminal did not show the repair commit")
        session_route = "/coach/learning/api/sessions/" + quote(created["session"]["session_id"])
        token = created["session"]["connection_token"]
        fixed = wait_until("terminal repair", lambda: repaired(base, session_route, token), 300)
        events = wait_until("terminal telemetry", lambda: git_events(args.context, run_id), 30)
        print("PASS: ttyd git push repaired %s at %s; telemetry=%s" %
              (fixed["application"], fixed["revision"][:7], events), flush=True)
        send_frame(connection, b"0exit\r")
    finally:
        if connection:
            connection.close()
        if run_id:
            try:
                checked(base, "/coach/learning/api/runs/" + quote(run_id), "DELETE")
            except Exception as error:
                print("cleanup failed:", error, flush=True)
        process.terminate()
        process.wait(timeout=5)


def repaired(base, session_route, token):
    view = checked(base, session_route, token=token)
    return view if view.get("fixed") and view.get("durable") else None


def git_events(context, run_id):
    events = prompt_events(context, run_id)
    return events if any(event.get("verb") == "git" and event.get("exit_code") == 0 for event in events) else None


if __name__ == "__main__":
    main()
