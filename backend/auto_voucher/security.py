from __future__ import annotations

import platform
import re
from pathlib import Path
from typing import Any


SENSITIVE_PATTERNS = (
    (re.compile(r"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*([^\s,;]+)"), r"\1=[REDACTED]"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"), "Bearer [REDACTED]"),
    (re.compile(r"(?<!\d)(\d{4})\d{8,15}(\d{4})(?!\d)"), r"\1********\2"),
    (re.compile(r"(?<!\d)(\d{3})\d{8,11}(\d{4})(?!\d)"), r"\1********\2"),
    (re.compile(r"\b([A-Za-z0-9._%+-])[^@\s]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b"), r"\1***@\2"),
)

SENSITIVE_KEYS = {
    "password",
    "passwd",
    "secret",
    "appsecret",
    "clientsecret",
    "token",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "cookie",
    "apikey",
    "privatekey",
    "certificatepassword",
}


def redact_text(value: object) -> str:
    text = str(value)
    home = str(Path.home())
    if home and home != "/":
        text = text.replace(home, "<HOME>")
    for pattern, replacement in SENSITIVE_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def redact_data(value: Any, *, max_string: int = 4000, depth: int = 0) -> Any:
    if depth > 8:
        return "[TRUNCATED_DEPTH]"
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in list(value.items())[:200]:
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            result[str(key)] = (
                "[REDACTED]"
                if normalized in SENSITIVE_KEYS or any(marker in normalized for marker in ("password", "secret", "token"))
                else redact_data(item, max_string=max_string, depth=depth + 1)
            )
        if len(value) > 200:
            result["_truncatedFields"] = len(value) - 200
        return result
    if isinstance(value, (list, tuple)):
        items = list(value)
        result = [redact_data(item, max_string=max_string, depth=depth + 1) for item in items[:200]]
        if len(items) > 200:
            result.append(f"[TRUNCATED_ITEMS:{len(items) - 200}]")
        return result
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = redact_text(value)
    return text if len(text) <= max_string else f"{text[:max_string]}…[TRUNCATED:{len(text) - max_string}]"


class SecretStore:
    service_name = "AutoVoucher"

    @staticmethod
    def _keyring():
        try:
            import keyring
        except ImportError as exc:
            raise RuntimeError("当前安装缺少操作系统密钥库组件 keyring") from exc
        return keyring

    def status(self) -> dict[str, str | bool]:
        keyring = self._keyring()
        try:
            backend = keyring.get_keyring()
        except Exception as exc:
            return {
                "available": False,
                "backend": "Unavailable",
                "message": f"{self._unavailable_hint()}（{redact_text(exc)}）",
            }
        usable = backend.priority > 0
        return {
            "available": usable,
            "backend": backend.__class__.__name__,
            "message": "操作系统密钥库可用" if usable else self._unavailable_hint(),
        }

    @staticmethod
    def _unavailable_hint() -> str:
        return {
            "Windows": "Windows 凭据管理器不可用，请登录桌面会话并确认 Credential Manager 服务正在运行",
            "Darwin": "macOS 钥匙串不可用，请登录桌面会话并确认“钥匙串访问”可正常打开",
            "Linux": "系统密钥库不可用，请安装并启动 gnome-keyring 或 KWallet 与 D-Bus 会话",
        }.get(platform.system(), "没有可用的操作系统密钥库后端")

    def set(self, connector_id: str, secret_name: str, value: str) -> None:
        if not connector_id or not secret_name or not value:
            raise ValueError("连接器、密钥名称和值不能为空")
        status = self.status()
        if not status["available"]:
            raise RuntimeError(status["message"])
        self._keyring().set_password(
            self.service_name,
            f"{connector_id}:{secret_name}",
            value,
        )

    def get(self, connector_id: str, secret_name: str) -> str:
        if not connector_id or not secret_name:
            raise ValueError("连接器和密钥名称不能为空")
        status = self.status()
        if not status["available"]:
            raise RuntimeError(status["message"])
        return self._keyring().get_password(
            self.service_name,
            f"{connector_id}:{secret_name}",
        ) or ""

    def delete(self, connector_id: str, secret_name: str) -> None:
        keyring = self._keyring()
        try:
            keyring.delete_password(self.service_name, f"{connector_id}:{secret_name}")
        except keyring.errors.PasswordDeleteError:
            return
