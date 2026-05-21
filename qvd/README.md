# `qvd/` — QVD staging + XLSX output

Drop Qlik `.qvd` files here. Run the converter and the XLSX outputs
land right back in this folder.

## Quick start

```bash
# from satori_SFML-main/
python qvd_to_xlsx.py                       # convert every .qvd in this folder
python qvd_to_xlsx.py qvd\Timesheets.qvd    # convert just one
```

Each `Foo.qvd` becomes `Foo.xlsx` next to it.

## End-to-end (QVD → BigQuery) flow

```
1. Drop  qvd\Timesheets.qvd
2. Run:  python qvd_to_xlsx.py                 →  qvd\Timesheets.xlsx
3. Move: cut Timesheets.xlsx and paste it into data\
4. Run:  python drive_sync.py                  →  capability-agent-prod.Satori_Project.Timesheets
```

If you want to skip step 3, run the converter with `--output-dir data/`
so the XLSX lands directly in the upload folder:

```bash
python qvd_to_xlsx.py --output-dir data\
```

## Dependencies

```bash
pip install pyqvd pandas openpyxl
```

- `pyqvd` reads QVD files (pure Python, no compile tools needed)
- `pandas` + `openpyxl` write the XLSX output
- For very large QVDs, `pip install qvd` adds a Rust-backed reader the
  script falls back to (~5x faster); not required

## Limits

- XLSX caps at 1,048,576 rows per sheet. If your QVD is larger the
  script tells you and exits — split the QVD or go through CSV instead.
- Big QVDs (500k+ rows) take a minute or two to write — openpyxl is
  slow on big workbooks.

## What's skipped

- Files starting with `.`, `_`, or `~$` (lockfiles + this README, etc.)
- Anything that isn't a `.qvd`
- Subfolders inside `qvd/`
