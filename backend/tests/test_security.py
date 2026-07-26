import unittest
from unittest.mock import patch

from auto_voucher.security import SecretStore


class UnavailableBackend:
    priority = 0


class FakeKeyring:
    @staticmethod
    def get_keyring():
        return UnavailableBackend()


class FailingKeyring:
    @staticmethod
    def get_keyring():
        raise RuntimeError("desktop session missing")


class SecurityTests(unittest.TestCase):
    def test_unavailable_windows_keyring_has_actionable_hint(self):
        store = SecretStore()
        with (
            patch.object(store, "_keyring", return_value=FakeKeyring),
            patch("auto_voucher.security.platform.system", return_value="Windows"),
        ):
            status = store.status()
        self.assertFalse(status["available"])
        self.assertIn("Windows 凭据管理器", status["message"])
        self.assertIn("Credential Manager", status["message"])

    def test_keyring_backend_exception_becomes_unavailable_status(self):
        store = SecretStore()
        with (
            patch.object(store, "_keyring", return_value=FailingKeyring),
            patch("auto_voucher.security.platform.system", return_value="Windows"),
        ):
            status = store.status()
        self.assertFalse(status["available"])
        self.assertEqual(status["backend"], "Unavailable")
        self.assertIn("desktop session missing", status["message"])


if __name__ == "__main__":
    unittest.main()
