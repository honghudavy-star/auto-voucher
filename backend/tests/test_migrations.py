import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import auto_voucher.database as database_module
from auto_voucher.database import DATABASE_SCHEMA_VERSION, Database


class MigrationTests(unittest.TestCase):
    def test_legacy_database_is_adopted_without_losing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.mkdir(parents=True, exist_ok=True)
            path = root / "auto-voucher.sqlite3"
            state = {"version": 2, "auditLog": [], "events": [], "vouchers": []}
            with closing(sqlite3.connect(path)) as connection:
                connection.execute(
                    """
                    CREATE TABLE app_state (
                        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                        revision INTEGER NOT NULL DEFAULT 1,
                        state_json TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    """
                    INSERT INTO app_state(singleton, revision, state_json, updated_at)
                    VALUES (1, 1, ?, '2026-07-25T00:00:00Z')
                    """,
                    (json.dumps(state),),
                )
                connection.commit()

            database = Database(root)

            self.assertEqual(database.schema_version(), DATABASE_SCHEMA_VERSION)
            self.assertEqual(database.get_state()["version"], 2)

    def test_failed_migration_rolls_back_every_statement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = Database(root)
            self.assertEqual(database.schema_version(), DATABASE_SCHEMA_VERSION)
            broken = {
                **database_module.MIGRATIONS,
                DATABASE_SCHEMA_VERSION + 1: (
                    "CREATE TABLE migration_probe(value TEXT)",
                    "THIS IS NOT VALID SQL",
                ),
            }
            with (
                patch.object(database_module, "MIGRATIONS", broken),
                patch.object(
                    database_module,
                    "DATABASE_SCHEMA_VERSION",
                    DATABASE_SCHEMA_VERSION + 1,
                ),
                self.assertRaises(sqlite3.OperationalError),
            ):
                Database(root)

            with closing(sqlite3.connect(database.db_path)) as connection:
                probe = connection.execute(
                    """
                    SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name = 'migration_probe'
                    """
                ).fetchone()
                version = connection.execute(
                    "SELECT version FROM schema_meta WHERE singleton = 1"
                ).fetchone()[0]
            self.assertIsNone(probe)
            self.assertEqual(version, DATABASE_SCHEMA_VERSION)

    def test_newer_database_is_rejected_without_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = Database(root)
            with closing(sqlite3.connect(database.db_path)) as connection:
                connection.execute(
                    "UPDATE schema_meta SET version = 99 WHERE singleton = 1"
                )
                connection.commit()

            with self.assertRaisesRegex(ValueError, "高于当前程序支持"):
                Database(root)

            with closing(sqlite3.connect(database.db_path)) as connection:
                version = connection.execute(
                    "SELECT version FROM schema_meta WHERE singleton = 1"
                ).fetchone()[0]
            self.assertEqual(version, 99)


if __name__ == "__main__":
    unittest.main()
