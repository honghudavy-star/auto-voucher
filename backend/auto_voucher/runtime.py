from __future__ import annotations

import json
import hashlib
import os
import platform
import shutil
import socket
import tempfile
import urllib.error
import urllib.request
import uuid
import webbrowser
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from .database import DATABASE_SCHEMA_VERSION, Database, utc_now
from .diagnostics import app_version
from .security import SecretStore, redact_data
from .service import resolve_worker


DEFAULT_PORTS = range(8766, 8786)


class RuntimeStore:
    """Non-business runtime state stored separately from the accounting database."""

    def __init__(self, data_dir: Path) -> None:
        self.root = data_dir / "runtime"
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "runtime-state.json"

    def read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            payload = json.loads(self.path.read_text("utf-8"))
            return payload if isinstance(payload, dict) else {}
        except (OSError, ValueError):
            return {}

    def update(self, **changes: Any) -> dict[str, Any]:
        payload = {**self.read(), **changes, "updatedAt": utc_now()}
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, self.path)
        return payload


class EnvironmentService:
    def __init__(
        self,
        database: Database,
        secret_store: SecretStore,
        static_dir: Path,
        host: str,
        port: int,
    ) -> None:
        self.database = database
        self.secret_store = secret_store
        self.static_dir = static_dir
        self.host = host
        self.port = port
        self.session_id = uuid.uuid4().hex
        self.store = RuntimeStore(database.data_dir)
        self.cache_dir = database.data_dir / "cache"
        self.staging_dir = database.data_dir / "runtime" / "staging"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.staging_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _result(
        check_id: str,
        name: str,
        status: str,
        actual: str,
        required: str,
        action: str,
        *,
        blocking: bool,
        production_blocking: bool = False,
    ) -> dict[str, Any]:
        return {
            "id": check_id,
            "name": name,
            "status": status,
            "severity": "blocking" if blocking else ("warning" if status != "passed" else "info"),
            "actual": actual,
            "required": required,
            "blocking": blocking,
            "productionBlocking": production_blocking or blocking,
            "action": action,
        }

    def status(self) -> dict[str, Any]:
        saved = self.store.read().get("environment")
        if (
            isinstance(saved, dict)
            and saved.get("coreVersion") == app_version()
            and saved.get("sessionId") == self.session_id
        ):
            return saved
        return self.check(include_network=False)

    def check(
        self,
        *,
        include_network: bool = True,
        browser_checks: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []
        system = platform.system()
        release = platform.release()
        supported_windows = system == "Windows"
        checks.append(self._result(
            "operating-system",
            "操作系统",
            "passed" if supported_windows else "failed",
            f"{system} {release}",
            "Windows 10 22H2 或 Windows 11 x64",
            "请在受支持的 Windows 电脑上安装正式版本。",
            blocking=not supported_windows,
        ))

        machine = platform.machine().lower()
        supported_arch = machine in {"amd64", "x86_64"}
        checks.append(self._result(
            "architecture",
            "处理器架构",
            "passed" if supported_arch else "failed",
            machine or "unknown",
            "x64",
            "首期不支持 ARM64，请使用 x64 Windows 设备。",
            blocking=not supported_arch,
        ))

        writable, write_message = self._check_writable(self.database.data_dir)
        checks.append(self._result(
            "data-directory",
            "数据目录读写",
            "passed" if writable else "failed",
            write_message,
            "可创建、写入并原子重命名文件",
            "检查目录权限或联系管理员；系统不会自动删除业务数据。",
            blocking=not writable,
        ))

        temporary_ok, temporary_message = self._check_writable(Path(tempfile.gettempdir()))
        checks.append(self._result(
            "temporary-directory",
            "临时目录",
            "passed" if temporary_ok else "failed",
            temporary_message,
            "可读写",
            "释放临时目录空间并检查权限。",
            blocking=not temporary_ok,
        ))

        static_ok = (self.static_dir / "index.html").is_file()
        checks.append(self._result(
            "core-assets",
            "核心程序完整性",
            "passed" if static_ok else "failed",
            str(self.static_dir / "index.html"),
            "核心静态资源完整",
            "通过启动器重新下载当前版本。",
            blocking=not static_ok,
        ))

        try:
            quick_check = self.database.quick_check()
        except Exception as exc:  # sqlite reports actionable detail
            quick_check = f"error: {exc}"
        sqlite_ok = quick_check == "ok"
        checks.append(self._result(
            "sqlite",
            "本地数据库",
            "passed" if sqlite_ok else "failed",
            quick_check,
            "PRAGMA quick_check = ok",
            "停止业务写入，复制问题信息并从完整性备份恢复。",
            blocking=not sqlite_ok,
        ))

        database_version = self.database.schema_version()
        schema_ok = database_version == DATABASE_SCHEMA_VERSION
        checks.append(self._result(
            "database-version",
            "数据库结构版本",
            "passed" if schema_ok else "failed",
            f"v{database_version}",
            f"v{DATABASE_SCHEMA_VERSION}",
            "使用兼容版本启动或联系技术支持执行受控迁移。",
            blocking=not schema_ok,
        ))

        state = self.database.get_state()
        state_version = int((state or {}).get("version") or 2)
        state_ok = state is None or state_version == 2
        checks.append(self._result(
            "state-version",
            "业务状态版本",
            "passed" if state_ok else "failed",
            f"v{state_version}",
            "v2",
            "使用兼容版本启动或从经过校验的备份恢复。",
            blocking=not state_ok,
        ))

        required_bytes = (
            int(os.environ.get("AUTO_VOUCHER_PACKAGE_BYTES", "0"))
            + int(os.environ.get("AUTO_VOUCHER_EXPANDED_BYTES", "0"))
            + int(self.database.database_size() * 1.2)
            + 512 * 1024 * 1024
        )
        free_bytes = shutil.disk_usage(self.database.data_dir).free
        disk_ok = free_bytes >= required_bytes
        checks.append(self._result(
            "disk-space",
            "可用磁盘空间",
            "passed" if disk_ok else "failed",
            f"{free_bytes} bytes",
            f"至少 {required_bytes} bytes",
            "清理未完成下载或无用缓存后重试。",
            blocking=not disk_ok,
        ))

        checks.append(self._port_check())
        checks.append(self._keyring_check())
        checks.append(self._browser_check())
        checks.append(self._optional_component(
            "ocr",
            "OCR 组件",
            "rapidocr_onnxruntime",
            bundled_executable="AutoVoucherOCR.exe",
        ))
        checks.append(self._optional_component(
            "pdf",
            "PDF 文本组件",
            executable="pdftotext",
            bundled_executable="AutoVoucherPDF.exe",
        ))
        checks.extend(self._network_checks(include_network))
        checks.extend(self._browser_capability_checks(browser_checks))

        overall = (
            "blocked"
            if any(item["status"] == "failed" and item["blocking"] for item in checks)
            else "degraded"
            if any(item["status"] != "passed" for item in checks)
            else "ok"
        )
        support_code = f"ENV-{uuid.uuid4().hex[:10].upper()}"
        result = {
            "overallStatus": overall,
            "checkedAt": utc_now(),
            "supportCode": support_code,
            "coreVersion": app_version(),
            "sessionId": self.session_id,
            "checks": checks,
            "repairActions": [
                {"id": "clear-update-cache", "label": "清理未完成下载"},
                {"id": "clear-staging", "label": "清理安装暂存区"},
                {"id": "select-port", "label": "重新选择本地端口"},
                {"id": "recreate-shortcut", "label": "重新创建桌面入口", "launcherRequired": True},
            ],
        }
        fingerprint_payload = {
            "coreVersion": result["coreVersion"],
            "productionChecks": [
                {"id": item["id"], "status": item["status"]}
                for item in checks
                if item.get("productionBlocking")
            ],
        }
        result["productionFingerprint"] = hashlib.sha256(
            json.dumps(fingerprint_payload, sort_keys=True).encode("utf-8")
        ).hexdigest()
        self.store.update(environment=redact_data(result))
        self._invalidate_production_if_changed(result)
        return result

    def _browser_capability_checks(
        self,
        browser_checks: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        allowed = {
            "browser-fetch": "网络请求能力",
            "browser-file": "文件读取能力",
            "browser-blob": "文件导出能力",
            "browser-crypto": "浏览器安全能力",
            "browser-clipboard": "剪贴板能力",
            "browser-dom": "页面交互能力",
        }
        if browser_checks is None:
            saved = self.store.read().get("browserChecks")
            browser_checks = saved if isinstance(saved, list) else []
        normalized = []
        for item in browser_checks:
            check_id = str(item.get("id") or "")
            if check_id not in allowed:
                continue
            passed = item.get("status") == "passed"
            production_required = check_id != "browser-clipboard"
            normalized.append(self._result(
                check_id,
                allowed[check_id],
                "passed" if passed else ("failed" if production_required else "warning"),
                "可用" if passed else "不可用",
                "当前稳定版 Edge 或 Chrome",
                "升级到当前稳定版 Edge 或 Chrome。",
                blocking=bool(production_required and not passed),
            ))
        if normalized:
            self.store.update(browserChecks=normalized)
            return normalized
        return [self._result(
            "browser-capabilities",
            "浏览器能力",
            "warning",
            "尚未由工作台验证",
            "Fetch、File、Blob、Web Crypto 和必要 DOM API 可用",
            "在 Edge 或 Chrome 中打开工作台并重新检测环境。",
            blocking=False,
            production_blocking=True,
        )]

    def repair(self, action: str) -> dict[str, Any]:
        if action == "clear-update-cache":
            self._clear_directory(self.cache_dir)
        elif action == "clear-staging":
            self._clear_directory(self.staging_dir)
        elif action == "select-port":
            recommended = self._find_available_port()
            self.store.update(recommendedPort=recommended)
            return {"ok": True, "action": action, "restartRequired": True, "recommendedPort": recommended}
        elif action == "recreate-shortcut":
            return {"ok": False, "action": action, "launcherRequired": True}
        else:
            raise ValueError("不允许执行该环境修复动作")
        return {"ok": True, "action": action, "environment": self.check(include_network=False)}

    def assert_production_ready(self) -> None:
        result = self.status()
        blockers = [
            item for item in result.get("checks", [])
            if item.get("productionBlocking") and item.get("status") != "passed"
        ]
        if blockers:
            raise ValueError(f"生产启用前环境检查失败：{blockers[0]['name']}；{blockers[0]['action']}")

    def _invalidate_production_if_changed(self, environment: dict[str, Any]) -> None:
        state = self.database.get_state()
        if not state:
            return
        activation = state.get("productionActivation") or {}
        validation = activation.get("environmentValidation") or {}
        if not activation.get("enabled") or not validation:
            return
        if validation.get("productionFingerprint") == environment.get("productionFingerprint"):
            return
        activation["enabled"] = False
        activation["invalidatedAt"] = utc_now()
        activation["invalidationReason"] = "核心版本或生产关键环境状态发生变化，需重新检测并确认上线"
        readiness = state.setdefault("readiness", {})
        readiness["production"] = {
            "status": "not_ready",
            "validatedAt": utc_now(),
            "reasons": [activation["invalidationReason"]],
        }
        self.database.put_state(state)

    def _network_checks(self, include_network: bool) -> list[dict[str, Any]]:
        manifest_url = os.environ.get("AUTO_VOUCHER_UPDATE_MANIFEST_URL", "").strip()
        if not manifest_url:
            return [self._result(
                "update-service",
                "在线更新服务",
                "warning",
                "开发环境未配置更新地址",
                "正式版本使用 HTTPS 更新地址",
                "正式发布前配置 Cloudflare R2/CDN 版本清单地址。",
                blocking=False,
            )]
        if not manifest_url.startswith("https://"):
            return [self._result(
                "update-service",
                "在线更新服务",
                "failed",
                manifest_url,
                "HTTPS",
                "更新地址必须使用有效 HTTPS 证书。",
                blocking=True,
            )]
        if not include_network:
            return [self._result(
                "update-service",
                "在线更新服务",
                "warning",
                "本次未执行联网检测",
                "可通过 HTTPS 访问",
                "点击“重新检测环境”完成联网检测。",
                blocking=False,
            )]
        try:
            request = urllib.request.Request(manifest_url, method="HEAD")
            started = datetime.now(timezone.utc)
            with urllib.request.urlopen(request, timeout=5) as response:
                server_date = response.headers.get("Date")
            elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
            result = [self._result(
                "update-service",
                "在线更新服务",
                "passed",
                f"HTTPS 可用，{elapsed_ms} ms",
                "可通过 HTTPS 访问",
                "无需操作。",
                blocking=False,
            )]
            if server_date:
                drift = abs((datetime.now(timezone.utc) - parsedate_to_datetime(server_date)).total_seconds())
                result.append(self._result(
                    "system-time",
                    "系统时间",
                    "passed" if drift <= 300 else "warning",
                    f"偏差 {int(drift)} 秒",
                    "与更新时间服务偏差不超过 5 分钟",
                    "开启 Windows 自动设置时间后重新检测。",
                    blocking=False,
                ))
            return result
        except (OSError, urllib.error.URLError, ValueError) as exc:
            return [self._result(
                "update-service",
                "在线更新服务",
                "warning",
                str(exc),
                "可通过 HTTPS 访问",
                "检查网络、DNS、系统代理和安全软件；已有版本仍可离线使用。",
                blocking=False,
            )]

    def _port_check(self) -> dict[str, Any]:
        # The running server proves the selected port is usable.
        return self._result(
            "loopback-port",
            "本地服务端口",
            "passed",
            f"{self.host}:{self.port}",
            "仅监听本机回环地址",
            "无需操作。",
            blocking=False,
        )

    def _keyring_check(self) -> dict[str, Any]:
        connector_id = f"environment-check-{uuid.uuid4().hex}"
        secret_name = "temporary"
        expected = uuid.uuid4().hex
        try:
            status = self.secret_store.status()
            available = bool(status.get("available"))
            actual = str(status.get("message") or status.get("backend") or "")
            if available:
                self.secret_store.set(connector_id, secret_name, expected)
                available = self.secret_store.get(connector_id, secret_name) == expected
                actual = "临时密钥写入、读取和删除成功" if available else "临时密钥读取结果不一致"
        except Exception as exc:
            available = False
            actual = str(exc)
        finally:
            try:
                self.secret_store.delete(connector_id, secret_name)
            except Exception:
                pass
        return self._result(
            "credential-manager",
            "Windows 凭据管理器",
            "passed" if available else "warning",
            actual,
            "可安全保存连接器密钥",
            "修复系统凭据管理器后才能配置密钥或启用生产。",
            blocking=False,
            production_blocking=not available,
        )

    def _browser_check(self) -> dict[str, Any]:
        try:
            browser = webbrowser.get()
            available = bool(browser)
            actual = browser.__class__.__name__
        except webbrowser.Error as exc:
            available = False
            actual = str(exc)
        return self._result(
            "default-browser",
            "默认浏览器",
            "passed" if available else "warning",
            actual,
            "可打开 Edge 或 Chrome",
            "设置默认浏览器，或复制本地工作台地址手动打开。",
            blocking=False,
        )

    def _optional_component(
        self,
        check_id: str,
        name: str,
        module: str = "",
        executable: str = "",
        bundled_executable: str = "",
    ) -> dict[str, Any]:
        worker_name = f"AUTO_VOUCHER_{check_id.upper()}_WORKER"
        worker = resolve_worker(worker_name, bundled_executable) if bundled_executable else ""
        available = (
            Path(worker).is_file()
            if worker
            else bool(find_spec(module))
            if module
            else bool(shutil.which(executable))
        )
        return self._result(
            f"component-{check_id}",
            name,
            "passed" if available else "warning",
            "应用包已包含" if available else "当前应用包缺失",
            "随当前应用版本提供",
            "重新安装当前版本的完整应用包。",
            blocking=False,
        )

    @staticmethod
    def _check_writable(path: Path) -> tuple[bool, str]:
        try:
            path.mkdir(parents=True, exist_ok=True)
            source = path / f".environment-{uuid.uuid4().hex}.tmp"
            target = source.with_suffix(".checked")
            source.write_text("ok", encoding="utf-8")
            os.replace(source, target)
            target.unlink()
            return True, str(path)
        except OSError as exc:
            return False, str(exc)

    @staticmethod
    def _clear_directory(path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)
        for child in path.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()

    @staticmethod
    def _find_available_port() -> int:
        for port in DEFAULT_PORTS:
            with socket.socket() as candidate:
                try:
                    candidate.bind(("127.0.0.1", port))
                    return port
                except OSError:
                    continue
        raise ValueError("8766–8785 均不可用，请关闭占用本地端口的程序")


class LauncherClient:
    """Authenticated loopback client for the native launcher's update control API."""

    def __init__(self, store: RuntimeStore) -> None:
        self.store = store
        self.endpoint = os.environ.get("AUTO_VOUCHER_LAUNCHER_ENDPOINT", "").rstrip("/")
        self.token = os.environ.get("AUTO_VOUCHER_LAUNCHER_TOKEN", "")

    def status(self) -> dict[str, Any]:
        if not self.endpoint or not self.token:
            saved = self.store.read().get("update")
            return saved if isinstance(saved, dict) else {
                "available": False,
                "status": "launcher_unavailable",
                "message": "当前开发运行未连接轻量启动器",
                "currentVersion": app_version(),
                "channel": "stable",
                "progress": 0,
            }
        try:
            result = self._request("GET", "/v1/update/status")
            self.store.update(update=redact_data(result))
            return result
        except ValueError as exc:
            return {
                "available": False,
                "status": "error",
                "message": str(exc),
                "currentVersion": app_version(),
                "channel": "stable",
                "progress": 0,
            }

    def command(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        allowed = {"check", "download", "apply", "postpone", "recreate-shortcut"}
        if action not in allowed:
            raise ValueError("不允许执行该启动器操作")
        if not self.endpoint or not self.token:
            raise ValueError("当前运行未连接轻量启动器，无法执行更新操作")
        result = self._request("POST", f"/v1/update/{action}", payload or {})
        self.store.update(update=redact_data(result))
        return result

    def diagnostics(self) -> dict[str, Any]:
        if not self.endpoint or not self.token:
            return {"available": False, "state": {}, "logs": []}
        try:
            result = self._request("GET", "/v1/diagnostics")
            return redact_data(result)
        except ValueError as exc:
            return {"available": False, "error": str(exc), "state": {}, "logs": []}

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.endpoint}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.load(response)
        except (OSError, urllib.error.URLError, ValueError) as exc:
            raise ValueError(f"启动器通信失败：{exc}") from exc
        if not isinstance(result, dict):
            raise ValueError("启动器返回了无效响应")
        return result
