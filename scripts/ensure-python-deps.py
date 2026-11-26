import importlib.util
import subprocess
import sys
from pathlib import Path


project_root = Path(__file__).resolve().parent.parent
requirements = project_root / "requirements.txt"
in_virtual_environment = sys.prefix != sys.base_prefix


def has_excel_dependencies():
    return all(importlib.util.find_spec(module) is not None for module in ("msoffcrypto", "openpyxl"))


def run(command):
    return subprocess.run(command, cwd=project_root).returncode


if not has_excel_dependencies():
    if importlib.util.find_spec("pip") is None:
        print("pip is missing; bootstrapping it for the active Python interpreter...", flush=True)
        ensurepip_command = [sys.executable, "-m", "ensurepip", "--upgrade"]
        if not in_virtual_environment:
            ensurepip_command.append("--user")
        if run(ensurepip_command) != 0:
            print("Could not bootstrap pip. Reinstall Python with pip/ensurepip enabled.")
            sys.exit(1)

    install_command = [sys.executable, "-m", "pip", "install"]
    if not in_virtual_environment:
        install_command.append("--user")
    install_command.extend(["-r", str(requirements)])
    if run(install_command) != 0:
        print("Could not install Excel dependencies from requirements.txt.")
        sys.exit(1)

if not has_excel_dependencies():
    print("Excel dependencies are still unavailable in the active Python interpreter.")
    sys.exit(1)

print(f"Excel dependencies are ready: {sys.executable}")
