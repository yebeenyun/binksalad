import json
import re
import sys
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile

from openpyxl import load_workbook
from openpyxl.utils.datetime import from_excel


ALIASES = {
    "date": {"거래일시", "거래일자", "거래일", "일시", "날짜", "transactiondate"},
    "description": {"거래내용", "내용", "적요", "거래처", "내역", "description", "merchant"},
    "amount": {"거래금액", "입출금액", "금액", "amount"},
    "deposit": {"입금액", "입금", "deposit"},
    "withdrawal": {"출금액", "출금", "withdrawal"},
    "balance": {"거래후잔액", "잔액", "balance"},
    "classification": {"구분", "거래구분", "수입지출", "transactiontype"},
    "counterparty": {"거래상대방", "상대방", "보내는분", "받는분", "counterparty"},
    "category": {"세부분류", "지출분류", "메모", "카테고리", "category"},
}


def normalize_header(value):
    return re.sub(r"[\s_\-()（）]", "", str(value or "")).lower()


def find_columns(row):
    columns = {}
    for index, value in enumerate(row):
        header = normalize_header(value)
        if not header:
            continue
        for field, aliases in ALIASES.items():
            if header in {normalize_header(alias) for alias in aliases} and field not in columns:
                columns[field] = index
    has_amount = "amount" in columns or ("deposit" in columns and "withdrawal" in columns)
    if "date" in columns and "description" in columns and has_amount:
        return columns
    return None


def cell(row, columns, key):
    index = columns.get(key)
    return row[index] if index is not None and index < len(row) else None


def parse_date(value):
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time()).isoformat(timespec="seconds")
    if isinstance(value, (int, float)):
        return from_excel(value).isoformat(timespec="seconds")
    text = str(value or "").strip()
    if not text:
        return None
    text = text.replace(".", "-").replace("/", "-")
    try:
        return datetime.fromisoformat(text.replace(" ", "T")).isoformat(timespec="seconds")
    except ValueError:
        for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                return datetime.strptime(text, pattern).isoformat(timespec="seconds")
            except ValueError:
                pass
    return None


def parse_amount(value):
    if value is None or value == "":
        return 0
    try:
        amount = Decimal(str(value).replace(",", "").replace("₩", "").strip())
    except (InvalidOperation, ValueError):
        raise ValueError("거래 금액을 숫자로 읽을 수 없습니다.")
    if amount != amount.to_integral_value():
        raise ValueError("거래 금액에 원 단위 미만 값이 있습니다.")
    return int(amount)


def open_statement(path, password):
    with open(path, "rb") as source:
        signature = source.read(8)
    if signature.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
        try:
            import msoffcrypto
            from msoffcrypto.exceptions import InvalidKeyError

            decrypted = BytesIO()
            with open(path, "rb") as source:
                office_file = msoffcrypto.OfficeFile(source)
                office_file.load_key(password=password or "")
                office_file.decrypt(decrypted)
            decrypted.seek(0)
            return load_workbook(decrypted, read_only=True, data_only=True)
        except InvalidKeyError:
            raise ValueError("엑셀 비밀번호가 올바르지 않습니다.") from None
        except ImportError:
            raise ValueError("암호화된 엑셀을 읽으려면 requirements.txt의 Python 패키지를 설치해야 합니다.") from None
        except Exception as error:
            if error.__class__.__name__ in {"DecryptionError", "InvalidKeyError"}:
                raise ValueError("엑셀 비밀번호가 올바르지 않거나 파일이 손상되었습니다.") from None
            raise ValueError("암호화된 엑셀 파일을 복호화하지 못했습니다.") from None
    try:
        return load_workbook(path, read_only=True, data_only=True)
    except (BadZipFile, OSError):
        raise ValueError(".xlsx 파일을 열 수 없습니다. 파일 형식과 암호를 확인해 주세요.") from None


def parse_statement(path, password):
    workbook = open_statement(path, password)
    transactions = []
    errors = []
    header_found = False

    try:
        for sheet in workbook.worksheets:
            columns = None
            header_row = 0
            for row_number, row in enumerate(sheet.iter_rows(min_row=1, max_row=min(sheet.max_row, 30), values_only=True), start=1):
                columns = find_columns(row)
                if columns:
                    header_row = row_number
                    header_found = True
                    break
            if not columns:
                continue

            for row_number, row in enumerate(sheet.iter_rows(min_row=header_row + 1, values_only=True), start=header_row + 1):
                if not any(value is not None and str(value).strip() for value in row):
                    continue
                raw_date = cell(row, columns, "date")
                if not raw_date:
                    continue
                try:
                    transaction_date = parse_date(raw_date)
                    if not transaction_date:
                        raise ValueError("거래 일시를 읽을 수 없습니다.")

                    raw_classification = str(cell(row, columns, "classification") or "").strip()
                    if "deposit" in columns or "withdrawal" in columns:
                        deposit = parse_amount(cell(row, columns, "deposit"))
                        withdrawal = parse_amount(cell(row, columns, "withdrawal"))
                        if deposit and withdrawal:
                            raise ValueError("입금액과 출금액이 동시에 기록되어 있습니다.")
                        amount = deposit if deposit else -abs(withdrawal)
                    else:
                        amount = parse_amount(cell(row, columns, "amount"))
                    if amount == 0:
                        continue

                    is_income = amount > 0
                    if "입금" in raw_classification or "수입" in raw_classification:
                        is_income = True
                    elif "출금" in raw_classification or "지출" in raw_classification:
                        is_income = False
                    amount = abs(amount) if is_income else -abs(amount)

                    description = str(cell(row, columns, "description") or "").strip()
                    if not description:
                        raise ValueError("거래 내용이 비어 있습니다.")
                    category = str(cell(row, columns, "category") or "").strip()
                    balance_value = cell(row, columns, "balance")
                    balance = parse_amount(balance_value) if balance_value not in (None, "") else None
                    counterparty = str(cell(row, columns, "counterparty") or "").strip() or None

                    transactions.append({
                        "transactionDate": transaction_date,
                        "description": description,
                        "counterparty": counterparty,
                        "amount": amount,
                        "balance": balance,
                        "transactionType": "income" if is_income else "expense",
                        "category": category or "미분류",
                        "sourceSheet": sheet.title,
                        "sourceRow": row_number,
                    })
                except ValueError as error:
                    errors.append({"sheet": sheet.title, "row": row_number, "message": str(error)})
    finally:
        workbook.close()

    if not header_found:
        raise ValueError("카카오뱅크 거래 내역 열을 찾지 못했습니다.")
    if not transactions and not errors:
        raise ValueError("가져올 거래 내역이 없습니다.")
    return {"transactions": transactions, "errors": errors}


def main():
    if len(sys.argv) != 2:
        raise ValueError("파일 경로가 필요합니다.")
    options = json.load(sys.stdin)
    path = Path(sys.argv[1])
    if not path.is_file() or path.suffix.lower() != ".xlsx":
        raise ValueError(".xlsx 파일만 가져올 수 있습니다.")
    result = parse_statement(path, options.get("password", ""))
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))


try:
    main()
except ValueError as error:
    print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
    sys.exit(0)
except Exception:
    print(json.dumps({"ok": False, "error": "엑셀 파일을 처리하는 중 오류가 발생했습니다."}, ensure_ascii=False))
    sys.exit(0)
