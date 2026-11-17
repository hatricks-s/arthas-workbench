from __future__ import annotations

import hmac
import json
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class User(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    token: SecretStr
    nodes: list[str]
    scopes: list[Literal["diagnose", "attach"]] = ["diagnose"]


class Node(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    token: SecretStr


class ServerConfig(StrictModel):
    host: str = "127.0.0.1"
    port: int = Field(default=18880, ge=1, le=65535)
    public_url: str = "http://127.0.0.1:18880"
    users: list[User] = Field(min_length=1)
    nodes: list[Node] = Field(min_length=1)

    @field_validator("public_url")
    @classmethod
    def validate_public_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("public_url must be an HTTP(S) origin")
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("public_url must not contain a path, query, or fragment")
        if parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("non-loopback public_url requires HTTPS (terminate TLS at a reverse proxy)")
        return value.rstrip("/")

    @model_validator(mode="after")
    def validate_identities(self) -> ServerConfig:
        node_ids = [n.id for n in self.nodes]
        user_ids = [u.id for u in self.users]
        if len(set(node_ids)) != len(node_ids) or len(set(user_ids)) != len(user_ids):
            raise ValueError("node and user IDs must each be unique")
        secrets = [entry.token.get_secret_value() for entry in [*self.users, *self.nodes]]
        if any(len(s) < 24 or s.startswith("REPLACE_") for s in secrets):
            raise ValueError("use generated unique tokens with at least 24 characters")
        if len(set(secrets)) != len(secrets):
            raise ValueError("user tokens and connector tokens must all differ")
        if any(not set(user.nodes).issubset(node_ids) for user in self.users):
            raise ValueError("user nodes must refer to configured node IDs")
        return self

    def authenticate(self, authorization: str) -> User | None:
        if not authorization.startswith("Bearer "):
            return None
        candidate = authorization[7:]
        for user in self.users:
            if hmac.compare_digest(candidate.encode(), user.token.get_secret_value().encode()):
                return user
        return None

    def authenticate_node(self, node_id: str, authorization: str) -> bool:
        node = next((n for n in self.nodes if n.id == node_id), None)
        return bool(node and hmac.compare_digest(
            authorization.encode(), f"Bearer {node.token.get_secret_value()}".encode()
        ))

    @classmethod
    def load(cls, path: str) -> ServerConfig:
        file = Path(path)
        if not file.is_absolute():
            raise ValueError("configuration path must be absolute")
        return cls.model_validate(json.loads(file.read_text(encoding="utf-8")))
