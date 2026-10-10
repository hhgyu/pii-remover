"""Native setup must reuse valid ONNX weights and reject missing weights."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_windows_models.py"
spec = importlib.util.spec_from_file_location("windows_models", SCRIPT)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class WindowsModelSetupTests(unittest.TestCase):
    def test_configured_fp32_is_reused_without_export_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "model.onnx").touch()
            with patch.dict(os.environ, {"KNER_ONNX_PATH": directory}):
                self.assertEqual(setup.prepare_korean_model(), Path(directory))

    def test_configured_int8_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "model_quantized.onnx").touch()
            with patch.dict(os.environ, {"KNER_ONNX_PATH": directory}):
                self.assertEqual(setup.prepare_korean_model(), Path(directory))

    def test_tokenizer_only_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "tokenizer.json").write_text("{}")
            with patch.dict(os.environ, {"KNER_ONNX_PATH": directory}):
                with self.assertRaisesRegex(FileNotFoundError, "contains no ONNX model"):
                    setup.prepare_korean_model()


if __name__ == "__main__":
    unittest.main()
