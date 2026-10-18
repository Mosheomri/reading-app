"""Run every test suite in this folder and print a summary.
Requires: pip install playwright, and Google Chrome installed.
Usage: python tests/run_all.py"""
import os, subprocess, sys

sys.stdout.reconfigure(encoding="utf-8")  # Hebrew in the output, also on a cp1252 console
HERE = os.path.dirname(os.path.abspath(__file__))
SUITES = ["e2e.py", "e2e_v3.py", "e2e_prompt.py", "e2e_check.py", "e2e_dicta.py", "reading.py", "ktiv.py", "match.py"]

env = dict(os.environ, PYTHONIOENCODING="utf-8")
failed = []
for name in SUITES:
    print("=== " + name, flush=True)
    r = subprocess.run([sys.executable, os.path.join(HERE, name)], env=env, capture_output=True, text=True, encoding="utf-8")
    out = r.stdout + r.stderr
    # Only failures and the summary line; the full log is printed if the suite crashed.
    lines = [l for l in out.splitlines() if l.startswith("FAIL") or "failures" in l]
    print("\n".join(lines) if lines else out)
    if r.returncode != 0:
        failed.append(name)

print("\n" + ("All suites passed." if not failed else "Failed: " + ", ".join(failed)))
sys.exit(1 if failed else 0)
