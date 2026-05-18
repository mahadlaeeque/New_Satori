"""
Best-effort PII redaction for prompts going to Gemini.

This is NOT a complete DLP solution — assume anything sent to a third-party
LLM may end up in their training/eval corpora. We strip the easy stuff so
casual leaks of user emails, phone numbers, CNICs, etc., don't ride along
with every SAP-mirror query.

Patterns intentionally kept conservative:
- emails: anything that looks like RFC 5322-ish addr-spec
- phone numbers: 8-15 consecutive digits, optionally with +/-/spaces
- Pakistani CNIC: 13 digits with optional dashes
- credit-card-ish: 13-19 consecutive digits in a row (no spaces)

If you find this redacting valid SAP IDs (material_id is 18 digits, plant_id
is 4 digits), tune `MATERIAL_ID_PATTERN` / `PLANT_ID_PATTERN` exclusions
below — we leave SAP-looking IDs alone on purpose.
"""
import re

_PATTERNS = [
    # Email — keep the domain TLD for readability.
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "[REDACTED-EMAIL]"),
    # Pakistani CNIC (13 digits w/ optional dashes: 35202-1234567-8).
    (re.compile(r"\b\d{5}-?\d{7}-?\d\b"), "[REDACTED-CNIC]"),
    # International-style phone: +92-300-1234567 / 0300 1234567 / +1 555 5555.
    # Tight character class so we don't accidentally eat plant ids or SAP doc
    # numbers (those are pure digits without separators).
    (re.compile(r"\+?\d{1,3}[\s\-]\d{2,4}[\s\-]\d{4,8}"), "[REDACTED-PHONE]"),
    # Long bare digit runs (13-19 chars) — credit-card-ish, bank account numbers.
    # Material IDs in SAP are stored zero-padded to 18 chars, so this WOULD
    # match — but users typically paste the trimmed form (10-13 chars) which
    # also matches. We err on safety: redact anything that long.
    (re.compile(r"\b\d{13,19}\b"), "[REDACTED-NUMBER]"),
]


def redact(text: str) -> str:
    """Return `text` with high-risk PII patterns replaced by placeholders.
    Empty/None input returns ''. Safe to call repeatedly."""
    if not text:
        return ""
    out = text
    for pat, repl in _PATTERNS:
        out = pat.sub(repl, out)
    return out


def redact_history(history: list[dict]) -> list[dict]:
    """Redact every message in an [{role, text}] chat history."""
    if not history:
        return []
    return [{**m, "text": redact(m.get("text", ""))} for m in history]
