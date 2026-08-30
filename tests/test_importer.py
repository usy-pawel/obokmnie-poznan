import contextlib
import importlib.util
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "import-poland-postgis.py"
SPEC = importlib.util.spec_from_file_location("poland_importer", MODULE_PATH)
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class ImporterTests(unittest.TestCase):
    def test_variants_normalize_sheet_and_annotations(self):
        variants = IMPORTER.variants_for("306401_1.0022.AR_001.9/8 część")
        self.assertIn("306401_1.0022.AR_1.9/8 część", variants)
        self.assertIn("306401_1.0022.AR_001.9/8", variants)
        self.assertIn("306401_1.0022.9/8", variants)

    def test_parcel_ids_preserve_sheet_when_present(self):
        row = {
            "jednosta_numer_ew": "306401_1",
            "obreb_numer": "0022",
            "numer_arkusza_dzialki": "01",
            "numer_dzialki": "9/8, 9/9",
        }
        self.assertEqual(
            IMPORTER.parcel_ids(row, "jednosta_numer_ew"),
            ["306401_1.0022.AR_01.9/8", "306401_1.0022.AR_01.9/9"],
        )

    def test_subtract_year_handles_leap_day(self):
        self.assertEqual(str(IMPORTER.subtract_year(IMPORTER.date(2024, 2, 29))), "2023-02-28")

    def test_publication_validation_rejects_large_drop(self):
        with self.assertRaisesRegex(RuntimeError, "Walidacja publikacji"):
            IMPORTER.validate_publication(1000, 200, 800)

    def test_publication_validation_accepts_stable_result(self):
        IMPORTER.validate_publication(1000, 700, 800)

    def test_mutating_import_holds_session_advisory_lock_for_entire_run(self):
        events = []

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, sql, params):
                events.append(("lock", sql, params))

            @staticmethod
            def fetchone():
                return (True,)

        class Connection:
            autocommit = False

            @staticmethod
            def cursor():
                return Cursor()

            @staticmethod
            def close():
                events.append(("close",))

        def run_import():
            events.append(("run",))

        with (
            patch.object(IMPORTER, "STAGE_ONLY", False),
            patch.object(IMPORTER, "FETCH_ONLY", False),
            patch.object(IMPORTER, "postgres_connection", return_value=Connection()),
            patch.object(IMPORTER, "stage_advisory_lock", return_value=contextlib.nullcontext()),
            patch.object(IMPORTER, "run_import", side_effect=run_import),
        ):
            self.assertEqual(IMPORTER.main(), 0)

        self.assertEqual(events[0][0], "lock")
        self.assertIn("pg_try_advisory_lock", events[0][1])
        self.assertEqual(events[0][2], (IMPORTER.IMPORT_ADVISORY_LOCK_KEY,))
        self.assertEqual(events[1:], [("run",), ("close",)])

    def test_parallel_import_exits_with_stable_code_without_running_or_failure_record(self):
        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def execute(_sql, _params):
                return None

            @staticmethod
            def fetchone():
                return (False,)

        class Connection:
            autocommit = False

            @staticmethod
            def cursor():
                return Cursor()

            @staticmethod
            def close():
                return None

        output = StringIO()
        with (
            patch.object(IMPORTER, "STAGE_ONLY", False),
            patch.object(IMPORTER, "FETCH_ONLY", False),
            patch.object(IMPORTER, "postgres_connection", return_value=Connection()),
            patch.object(IMPORTER, "run_import") as run_import,
            patch.object(IMPORTER, "fail_import") as fail_import,
            redirect_stdout(output),
        ):
            self.assertEqual(IMPORTER.main(), IMPORTER.IMPORT_ALREADY_RUNNING_EXIT_CODE)

        run_import.assert_not_called()
        fail_import.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), {
            "ok": True,
            "skipped": True,
            "code": "import_already_running",
        })

    def test_stage_only_and_fetch_only_use_stage_lock_without_import_lock(self):
        for stage_only, fetch_only in ((True, False), (False, True)):
            with self.subTest(stage_only=stage_only, fetch_only=fetch_only):
                with (
                    patch.object(IMPORTER, "STAGE_ONLY", stage_only),
                    patch.object(IMPORTER, "FETCH_ONLY", fetch_only),
                    patch.object(IMPORTER, "import_advisory_lock") as lock,
                    patch.object(IMPORTER, "stage_advisory_lock") as stage_lock,
                    patch.object(IMPORTER, "run_import") as run_import,
                ):
                    self.assertEqual(IMPORTER.main(), 0)
                lock.assert_not_called()
                stage_lock.assert_called_once()
                run_import.assert_called_once()

    def test_import_failure_is_recorded_before_locks_are_released(self):
        events = []

        @contextlib.contextmanager
        def importer_lock():
            events.append("import_lock_enter")
            try:
                yield
            finally:
                events.append("import_lock_exit")

        @contextlib.contextmanager
        def stage_lock():
            events.append("stage_lock_enter")
            try:
                yield
            finally:
                events.append("stage_lock_exit")

        with (
            patch.object(IMPORTER, "STAGE_ONLY", False),
            patch.object(IMPORTER, "FETCH_ONLY", False),
            patch.object(IMPORTER, "import_advisory_lock", importer_lock),
            patch.object(IMPORTER, "stage_advisory_lock", stage_lock),
            patch.object(IMPORTER, "run_import", side_effect=RuntimeError("boom")),
            patch.object(IMPORTER, "fail_import", side_effect=lambda *_args: events.append("failed")),
            self.assertRaises(RuntimeError),
        ):
            IMPORTER.main()

        self.assertEqual(events, [
            "import_lock_enter", "stage_lock_enter", "stage_lock_exit",
            "failed", "import_lock_exit",
        ])

    def test_stage_lock_setup_failure_is_recorded_before_import_lock_releases(self):
        events = []

        @contextlib.contextmanager
        def importer_lock():
            events.append("import_lock_enter")
            try:
                yield
            finally:
                events.append("import_lock_exit")

        @contextlib.contextmanager
        def broken_stage_lock():
            events.append("stage_lock_enter")
            raise OSError("stage unavailable")
            yield

        with (
            patch.object(IMPORTER, "STAGE_ONLY", False),
            patch.object(IMPORTER, "FETCH_ONLY", False),
            patch.object(IMPORTER, "import_advisory_lock", importer_lock),
            patch.object(IMPORTER, "stage_advisory_lock", broken_stage_lock),
            patch.object(IMPORTER, "fail_import", side_effect=lambda *_args: events.append("failed")),
            self.assertRaises(OSError),
        ):
            IMPORTER.main()

        self.assertEqual(events, [
            "import_lock_enter", "stage_lock_enter", "failed", "import_lock_exit",
        ])

    def test_real_sqlite_stage_lock_rejects_parallel_access(self):
        with tempfile.TemporaryDirectory() as directory:
            stage_path = Path(directory) / "stage.sqlite"
            with patch.object(IMPORTER, "STAGE_PATH", stage_path):
                with IMPORTER.stage_advisory_lock():
                    with self.assertRaises(IMPORTER.StageAlreadyRunning):
                        with IMPORTER.stage_advisory_lock():
                            pass


if __name__ == "__main__":
    unittest.main()
