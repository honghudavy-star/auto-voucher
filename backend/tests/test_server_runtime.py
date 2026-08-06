import tempfile
import threading
import unittest
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch

from auto_voucher.database import Database
from auto_voucher.server import JobManager, bind_host_allowed, make_handler


class ServerRuntimeTests(unittest.TestCase):
    def test_container_bind_requires_explicit_container_mode(self):
        self.assertTrue(bind_host_allowed("127.0.0.1", {}))
        self.assertTrue(bind_host_allowed("localhost", {}))
        self.assertFalse(bind_host_allowed("0.0.0.0", {}))
        self.assertTrue(bind_host_allowed("0.0.0.0", {"AUTO_VOUCHER_CONTAINER": "1"}))
        self.assertFalse(bind_host_allowed("192.168.1.10", {"AUTO_VOUCHER_CONTAINER": "1"}))

    def make_handler_instance(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        static = root / "dist"
        static.mkdir()
        (static / "index.html").write_text("<!doctype html>", encoding="utf-8")
        handler_type = make_handler(Database(root / "data"), static)
        handler = object.__new__(handler_type)
        handler.request_version = "HTTP/1.1"
        handler.command = "GET"
        handler.path = "/api/test"
        handler.requestline = "GET /api/test HTTP/1.1"
        handler.wfile = BytesIO()
        handler.close_connection = False
        return handler

    def test_unhandled_error_does_not_send_second_response_after_headers_started(self):
        handler = self.make_handler_instance()
        handler.json_response = Mock()

        def partially_respond(current):
            current.send_response(HTTPStatus.OK)
            raise RuntimeError("body write failed")

        with patch.object(BaseHTTPRequestHandler, "handle_one_request", partially_respond):
            handler.handle_one_request()

        handler.json_response.assert_not_called()
        self.assertTrue(handler.close_connection)

    def test_unhandled_error_sends_json_when_no_response_started(self):
        handler = self.make_handler_instance()
        handler.json_response = Mock()

        def fail_before_response(_current):
            raise RuntimeError("request failed")

        with patch.object(BaseHTTPRequestHandler, "handle_one_request", fail_before_response):
            handler.handle_one_request()

        handler.json_response.assert_called_once()
        self.assertEqual(handler.json_response.call_args.args[1], HTTPStatus.INTERNAL_SERVER_ERROR)

    def test_job_manager_waits_for_active_job_with_timeout(self):
        manager = JobManager()
        started = threading.Event()
        release = threading.Event()

        def target(*, progress):
            started.set()
            release.wait(2)
            progress({"processed": 1, "total": 1, "percent": 100})
            return {"ok": True}

        job = manager.submit("测试任务", target)
        self.assertTrue(started.wait(1))
        self.assertFalse(manager.wait_for_idle(0.01))
        release.set()
        self.assertTrue(manager.wait_for_idle(1))
        self.assertEqual(manager.get(job["id"])["status"], "completed")


if __name__ == "__main__":
    unittest.main()
