import importlib.util
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
