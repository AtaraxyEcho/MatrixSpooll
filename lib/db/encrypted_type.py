"""Application-level encryption for credentials stored in the database."""

from __future__ import annotations

import functools
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import Text
from sqlalchemy.engine.interfaces import Dialect
from sqlalchemy.types import TypeDecorator

from lib.app_data_dir import app_data_dir

ENCRYPTED_PREFIX = "msp1:"
_KEY_ENV = "MATRIXSPOOLL_CREDENTIAL_KEY"
_KEY_FILE_ENV = "MATRIXSPOOLL_CREDENTIAL_KEY_FILE"
_DEFAULT_KEY_FILENAME = ".credential-key"


def _key_file_path() -> Path:
    configured = os.environ.get(_KEY_FILE_ENV, "").strip()
    if configured:
        path = Path(configured)
        if not path.is_absolute():
            path = app_data_dir() / path
        return path.resolve()
    return app_data_dir() / _DEFAULT_KEY_FILENAME


def _read_or_create_key_file(path: Path) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise RuntimeError(f"credential key file must not be a symlink: {path}")
    try:
        return path.read_bytes().strip()
    except FileNotFoundError:
        pass

    key = Fernet.generate_key()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError:
        if path.is_symlink():
            raise RuntimeError(f"credential key file must not be a symlink: {path}") from None
        return path.read_bytes().strip()

    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(key + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    if os.name == "posix":
        os.chmod(path, 0o600)
    return key


@functools.cache
def _fernet() -> Fernet:
    configured = os.environ.get(_KEY_ENV, "").strip()
    key = configured.encode("ascii") if configured else _read_or_create_key_file(_key_file_path())
    try:
        return Fernet(key)
    except (ValueError, UnicodeEncodeError) as exc:
        source = _KEY_ENV if configured else str(_key_file_path())
        raise RuntimeError(f"invalid MatrixSpooll credential encryption key: {source}") from exc


def encrypt_secret(value: str | None) -> str | None:
    if value is None or value == "":
        return value
    if value.startswith(ENCRYPTED_PREFIX):
        decrypt_secret(value)
        return value
    token = _fernet().encrypt(value.encode("utf-8")).decode("ascii")
    return f"{ENCRYPTED_PREFIX}{token}"


def decrypt_secret(value: str | None) -> str | None:
    if value is None or value == "" or not value.startswith(ENCRYPTED_PREFIX):
        return value
    token = value.removeprefix(ENCRYPTED_PREFIX)
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError) as exc:
        raise RuntimeError("stored credential cannot be decrypted with the configured key") from exc


def reset_credential_cipher_for_tests() -> None:
    _fernet.cache_clear()


class EncryptedText(TypeDecorator[str]):
    """Text column that transparently encrypts values at the ORM boundary."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: str | None, dialect: Dialect) -> str | None:
        del dialect
        return encrypt_secret(value)

    def process_result_value(self, value: str | None, dialect: Dialect) -> str | None:
        del dialect
        return decrypt_secret(value)
