from __future__ import annotations

import argparse
import http.client
import json
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Sequence
from urllib.parse import urlsplit


RESPONSE_LIMIT = 64 * 1024 * 1024
RESPONSE_TIMEOUT_SECONDS = 300
RESPONSE_HEADER_LIMIT = 32 * 1024
HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
RESPONSE_HEADERS = {"content-type"}
REVIEWED_ROUTES = (
    ("GET", "/api/tags"),
    ("POST", "/api/show"),
    ("POST", "/v1/chat/completions"),
)


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _BoundedHeaderReader:
    def __init__(self, stream, limit: int) -> None:
        self.stream = stream
        self.remaining = limit

    def readline(self, limit: int = -1) -> bytes:
        allowed = self.remaining + 1
        if limit >= 0:
            allowed = min(allowed, limit)
        value = self.stream.readline(allowed)
        self.remaining -= len(value)
        if self.remaining < 0:
            raise http.client.LineTooLong("header section exceeds 32 KiB")
        return value

    def __getattr__(self, name: str):
        return getattr(self.stream, name)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = True
    request_queue_size = 16

    def __init__(self, *args, **kwargs) -> None:
        self._slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address) -> None:
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class ProxyRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AlloyOllamaGate/1"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(30)

    def parse_request(self) -> bool:
        original = self.rfile
        self.rfile = _BoundedHeaderReader(original, self.server.policy.header_limit)
        try:
            return super().parse_request()
        finally:
            self.rfile = original

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def do_CONNECT(self) -> None:
        self._reject(405, "method not allowed")

    def _handle(self) -> None:
        request_id = uuid.uuid4().hex
        try:
            pairs = list(self.headers.raw_items())
            counts: dict[str, int] = {}
            for name, _ in pairs:
                lowered = name.lower()
                counts[lowered] = counts.get(lowered, 0) + 1
            if any(counts.get(name, 0) > 1 for name in ("host", "content-length")):
                raise ValueError("duplicate framing or authority header")
            length_values = self.headers.get_all("Content-Length", failobj=[])
            if len(length_values) > 1:
                raise ValueError("duplicate content length")
            length = int(length_values[0]) if length_values else 0
            if length < 0 or length > self.server.policy.body_limit:
                raise ValueError("request body exceeds limit")
            body = self.rfile.read(length) if length else b""
            validated = self.server.policy.validate(
                self.command, self.path, self.headers, body
            )
        except (ValueError, OSError) as error:
            self._reject(400, str(error), request_id)
            return

        headers = {
            "Content-Type": "application/json",
            "Content-Length": str(len(validated.body)),
            "X-Request-ID": request_id,
        }
        request = urllib.request.Request(
            self.server.origin + validated.target,
            data=validated.body if validated.method == "POST" else None,
            headers=headers,
            method=validated.method,
        )
        started = time.monotonic()
        headers_sent = False
        try:
            with self.server.opener.open(
                request, timeout=self.server.response_timeout
            ) as response:
                if not 200 <= response.status < 300:
                    raise RuntimeError("upstream returned a disallowed status")
                raw_items = getattr(response.headers, "raw_items", None)
                response_headers = (
                    list(raw_items()) if callable(raw_items) else list(response.headers.items())
                )
                if sum(
                    len(name) + len(value) + 4 for name, value in response_headers
                ) > self.server.response_header_limit:
                    raise RuntimeError("upstream response headers exceeded byte limit")
                grouped: dict[str, list[str]] = {}
                for name, value in response_headers:
                    grouped.setdefault(name.lower(), []).append(value)
                lengths = grouped.get("content-length", [])
                if (
                    len(lengths) > 1
                    or (lengths and not lengths[0].isdigit())
                    or (lengths and "transfer-encoding" in grouped)
                ):
                    raise RuntimeError("upstream response framing is ambiguous")
                expected_length = int(lengths[0]) if lengths else None
                self.send_response(response.status)
                for name, value in response_headers:
                    lowered = name.lower()
                    if lowered in RESPONSE_HEADERS:
                        self.send_header(name, value)
                self.send_header("X-Request-ID", request_id)
                self.send_header("Connection", "close")
                self.end_headers()
                headers_sent = True
                self.close_connection = True
                transferred = 0
                while True:
                    remaining_time = self.server.response_timeout - (time.monotonic() - started)
                    if remaining_time <= 0:
                        raise TimeoutError("upstream response exceeded time limit")
                    self._set_upstream_timeout(response, remaining_time)
                    remaining_bytes = self.server.response_limit - transferred
                    chunk = response.read1(min(64 * 1024, remaining_bytes + 1))
                    if not chunk:
                        break
                    accepted = chunk[:remaining_bytes]
                    if accepted:
                        self.wfile.write(accepted)
                        self.wfile.flush()
                        transferred += len(accepted)
                    if len(chunk) > len(accepted):
                        raise RuntimeError("upstream response exceeded byte limit")
                if expected_length is not None and transferred != expected_length:
                    raise RuntimeError("upstream response ended before content length")
        except (
            OSError,
            TimeoutError,
            RuntimeError,
            http.client.HTTPException,
            urllib.error.URLError,
        ):
            if not headers_sent:
                self._reject(502, "upstream request failed", request_id)
            else:
                self.close_connection = True

    @staticmethod
    def _set_upstream_timeout(response, timeout: float) -> None:
        stream = getattr(response, "fp", None)
        raw = getattr(stream, "raw", None)
        sock = getattr(raw, "_sock", None)
        if sock is not None:
            sock.settimeout(max(timeout, 0.001))

    def _reject(self, status: int, message: str, request_id: str | None = None) -> None:
        payload = json.dumps(
            {"error": message, "request_id": request_id or uuid.uuid4().hex},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def log_message(self, _format: str, *_args: object) -> None:
        return


def create_server(
    address: tuple[str, int],
    policy,
    origin: str,
    *,
    response_limit: int = RESPONSE_LIMIT,
    response_timeout: int = RESPONSE_TIMEOUT_SECONDS,
    response_header_limit: int = RESPONSE_HEADER_LIMIT,
) -> BoundedThreadingHTTPServer:
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "http"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.hostname is None
        or parsed.port is None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or origin != f"http://{parsed.hostname}:{parsed.port}"
    ):
        raise ValueError("origin must be a fixed HTTP origin without a path")
    server = BoundedThreadingHTTPServer(address, ProxyRequestHandler)
    server.policy = policy
    server.origin = origin
    server.response_limit = response_limit
    server.response_timeout = response_timeout
    server.response_header_limit = response_header_limit
    server.opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirectHandler()
    )
    return server


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--expected-host", required=True)
    parser.add_argument("--model", required=True)
    arguments = parser.parse_args(argv)
    host, separator, encoded_port = arguments.listen.rpartition(":")
    if not separator or not host:
        raise ValueError("listen must be host:port")

    try:
        from benchmarks.swebench.proxy import ProxyPolicy
    except ModuleNotFoundError:
        from proxy import ProxyPolicy

    policy = ProxyPolicy(REVIEWED_ROUTES, arguments.model, arguments.expected_host)
    server = create_server((host, int(encoded_port)), policy, arguments.origin)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
