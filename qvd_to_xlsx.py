#!/usr/bin/env python3
"""
qvd_to_xlsx.py — convert Qlik QVD files to XLSX (Excel workbooks).

Why this exists:
    Converting QVD -> CSV via Qlik's "Export to Excel" path loses type
    information — nulls collapse to empty strings, dates lose their
    type, decimals get reformatted, and Unicode sometimes gets mangled.
    XLSX preserves all of those, and drive_sync.py reads XLSX natively
    (it converts to a temp CSV internally with proper type handling).

Quick start:
    pip install pyqvd pandas openpyxl

    # Single file, output beside the input as `Timesheets.xlsx`:
    python qvd_to_xlsx.py "C:\\path\\to\\Timesheets.qvd"

    # Single file, custom output path:
    python qvd_to_xlsx.py Timesheets.qvd --output data/Timesheets.xlsx

    # Convert every .qvd in a folder (output beside each input):
    python qvd_to_xlsx.py --all-in-dir "C:\\qvd_exports"

    # Convert + drop the result directly into data/ ready for drive_sync.py:
    python qvd_to_xlsx.py Timesheets.qvd --output-dir data/

Then:
    python drive_sync.py    # uploads the XLSX you just created

Notes:
    - XLSX caps at 1,048,576 rows per sheet. If your QVD is larger,
      the script will tell you and you'll have to either split it or
      go through CSV instead.
    - Big QVDs (>500k rows) can take a minute or two to convert —
      openpyxl is slow on writes. Be patient.
    - QVD reading uses pyqvd (pure Python). If you have very large
      files and want a speed-up, `pip install qvd` swaps to a Rust-
      backed reader that's ~5x faster; the script detects either.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


XLSX_MAX_ROWS = 1_048_576  # Excel's hard limit per sheet

# Default staging folder. With no CLI args, the script scans this folder
# and converts every .qvd it finds, dropping the .xlsx output next to
# each input. Keeps QVD staging separate from `data/` (the upload folder
# drive_sync.py watches) so you can review the XLSX before uploading.
DEFAULT_QVD_DIR = Path(__file__).resolve().parent / "qvd"


def _read_qvd(qvd_path: Path):
    """Read a QVD file and return a pandas DataFrame.

    Tries pyqvd first (pure-Python, easiest to install on Windows),
    falls back to `qvd` (Rust-backed, faster). Either produces a
    DataFrame via `to_pandas()`. Pandas is required either way — the
    rest of the pipeline (DataFrame -> XLSX) depends on it.
    """
    try:
        import pandas as pd  # noqa: F401
    except ImportError as e:
        raise SystemExit(
            f"Missing dependency: pandas ({e})\n"
            f"Install with:  pip install pandas openpyxl"
        )

    errors = []

    # Preferred: pyqvd (pure Python, no compile toolchain needed)
    try:
        from pyqvd import QvdTable
        tbl = QvdTable.from_qvd(str(qvd_path))
        return tbl.to_pandas()
    except ImportError:
        errors.append("pyqvd not installed")
    except Exception as e:
        errors.append(f"pyqvd failed to read file: {e}")

    # Fallback: qvd (Rust-backed)
    try:
        from qvd import QvdTable
        tbl = QvdTable.from_qvd(str(qvd_path))
        return tbl.to_pandas()
    except ImportError:
        errors.append("qvd not installed")
    except Exception as e:
        errors.append(f"qvd failed to read file: {e}")

    raise SystemExit(
        "Could not read QVD file.\n  " + "\n  ".join(errors) + "\n\n" +
        "Install a QVD reader:\n"
        "  pip install pyqvd        # pure Python, simple install on Windows\n"
        "  pip install qvd          # Rust-backed, ~5x faster on large files\n"
    )


def _write_xlsx(df, out_path: Path) -> tuple[int, int]:
    """Write a DataFrame to XLSX. Returns (rows, columns) written."""
    try:
        import openpyxl  # noqa: F401
    except ImportError as e:
        raise SystemExit(
            f"Missing dependency: openpyxl ({e})\n"
            f"Install with:  pip install openpyxl"
        )

    n_rows, n_cols = df.shape
    if n_rows > XLSX_MAX_ROWS:
        raise SystemExit(
            f"QVD has {n_rows:,} rows — exceeds Excel's {XLSX_MAX_ROWS:,} "
            f"row limit per sheet.\n"
            f"Options:\n"
            f"  - Split the QVD into chunks and convert each separately, or\n"
            f"  - Export to CSV instead (drive_sync.py handles CSV directly)."
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Pandas handles type preservation: dates stay dates, nulls stay nulls,
    # numbers stay numeric.  Single sheet named after the file.
    sheet_name = (out_path.stem or "Sheet1")[:31]  # XLSX sheet name max 31
    df.to_excel(out_path, index=False, sheet_name=sheet_name, engine="openpyxl")
    return n_rows, n_cols


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{n} {unit}"
        n /= 1024


def convert_one(qvd_path: Path, out_path: Path | None) -> Path:
    """Convert one QVD file to XLSX. Returns the output path."""
    qvd_path = qvd_path.resolve()
    if not qvd_path.is_file():
        raise SystemExit(f"Not a file: {qvd_path}")
    if qvd_path.suffix.lower() != ".qvd":
        raise SystemExit(f"Not a .qvd file: {qvd_path}")

    if out_path is None:
        out_path = qvd_path.with_suffix(".xlsx")
    out_path = Path(out_path).resolve()

    size = qvd_path.stat().st_size
    print(f"[qvd_to_xlsx] reading {qvd_path.name}  ({_human_size(size)})")
    df = _read_qvd(qvd_path)
    print(f"             {df.shape[0]:,} rows × {df.shape[1]} columns")

    print(f"[qvd_to_xlsx] writing  {out_path}")
    rows, cols = _write_xlsx(df, out_path)
    print(f"             done — {rows:,} rows × {cols} columns")
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert Qlik QVD files to XLSX.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("qvd", nargs="?",
                        help="Path to a single .qvd file to convert.")
    parser.add_argument("--output", "-o", default=None,
                        help="Output .xlsx path. Default: input.xlsx next to the input.")
    parser.add_argument("--output-dir", default=None,
                        help="Output directory. The output filename will be the input's "
                             "stem + .xlsx (e.g. Timesheets.qvd -> <dir>/Timesheets.xlsx). "
                             "Ignored if --output is set.")
    parser.add_argument("--all-in-dir", default=None,
                        help="Convert every .qvd in this directory (single-file args ignored).")
    args = parser.parse_args()

    # Batch mode
    if args.all_in_dir:
        d = Path(args.all_in_dir).resolve()
        if not d.is_dir():
            print(f"Not a directory: {d}")
            return 1
        qvds = sorted(d.glob("*.qvd"))
        if not qvds:
            print(f"No .qvd files in {d}")
            return 0
        print(f"[qvd_to_xlsx] found {len(qvds)} .qvd file{'s' if len(qvds) != 1 else ''} in {d}")
        ok, fail = 0, 0
        for q in qvds:
            try:
                if args.output_dir:
                    out = Path(args.output_dir).resolve() / (q.stem + ".xlsx")
                else:
                    out = None
                convert_one(q, out)
                ok += 1
            except SystemExit as e:
                # Catch our own SystemExit (e.g. row-limit) so one bad file doesn't kill the batch
                print(f"             FAILED on {q.name}: {e}")
                fail += 1
            except Exception as e:
                print(f"             FAILED on {q.name}: {e}")
                fail += 1
        print()
        print(f"[qvd_to_xlsx] summary: {ok} ok, {fail} failed")
        return 1 if fail else 0

    # Single-file mode
    if args.qvd:
        if args.output:
            out = Path(args.output)
        elif args.output_dir:
            in_path = Path(args.qvd)
            out = Path(args.output_dir).resolve() / (in_path.stem + ".xlsx")
        else:
            out = None  # default = beside the input
        convert_one(Path(args.qvd), out)
        return 0

    # No CLI args → scan the default qvd/ folder
    d = DEFAULT_QVD_DIR
    if not d.is_dir():
        print(f"[qvd_to_xlsx] default folder {d} does not exist.")
        print(f"[qvd_to_xlsx] create it and drop your .qvd files there, or pass an explicit path.")
        return 1
    qvds = sorted(d.glob("*.qvd"))
    if not qvds:
        print(f"[qvd_to_xlsx] no .qvd files in {d}.")
        print(f"[qvd_to_xlsx] Drop your QVD files there and re-run.")
        return 0
    print(f"[qvd_to_xlsx] scanning default folder: {d}")
    print(f"[qvd_to_xlsx] found {len(qvds)} .qvd file{'s' if len(qvds) != 1 else ''}")
    ok, fail = 0, 0
    for q in qvds:
        try:
            if args.output_dir:
                out = Path(args.output_dir).resolve() / (q.stem + ".xlsx")
            else:
                out = None
            convert_one(q, out)
            ok += 1
        except SystemExit as e:
            print(f"             FAILED on {q.name}: {e}")
            fail += 1
        except Exception as e:
            print(f"             FAILED on {q.name}: {e}")
            fail += 1
    print()
    print(f"[qvd_to_xlsx] summary: {ok} ok, {fail} failed")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
