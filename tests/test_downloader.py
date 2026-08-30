import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "download_gunb_archives.py"
SPEC = importlib.util.spec_from_file_location("gunb_downloader", MODULE_PATH)
DOWNLOADER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOWNLOADER)


class DownloaderTests(unittest.TestCase):
    def test_expected_archive_set_is_complete(self):
        names = DOWNLOADER.expected_archive_names()
        self.assertEqual(len(names), 18)
        self.assertIn("wynik_wielkopolskie.zip", names)
        self.assertIn("wynik_zgloszenia_2022_up.zip", names)

    def test_archive_validation_rejects_zip_without_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("padding.txt", "x" * 2000)
            with self.assertRaisesRegex(RuntimeError, "dokładnie jednego CSV"):
                DOWNLOADER.validate_archive(path)


if __name__ == "__main__":
    unittest.main()
