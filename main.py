import json
import os
import secrets
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Dict, Optional, Union

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, StrictBool


DATA_DIR = Path("data")
DATA_FILE = DATA_DIR / "presence.json"
API_KEY_ENV = "API_KEY"

presence_lock = threading.Lock()


class PresenceUpdate(BaseModel):
    present: StrictBool


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text("{}", encoding="utf-8")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    ensure_storage()
    yield


app = FastAPI(title="Home Presence API", lifespan=lifespan)


def read_presence() -> Dict[str, bool]:
    ensure_storage()
    with DATA_FILE.open("r", encoding="utf-8") as file:
        data = json.load(file)
    return {str(name).lower(): bool(present) for name, present in data.items()}


def write_presence(data: Dict[str, bool]) -> None:
    ensure_storage()
    with DATA_FILE.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=2, sort_keys=True)
        file.write("\n")


def require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    expected_api_key = os.getenv(API_KEY_ENV)
    if not expected_api_key or not x_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    if not secrets.compare_digest(x_api_key, expected_api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/presence/{name}", dependencies=[Depends(require_api_key)])
def update_presence(name: str, update: PresenceUpdate) -> Dict[str, Union[bool, str]]:
    normalized_name = name.lower()

    with presence_lock:
        people = read_presence()
        people[normalized_name] = update.present
        write_presence(people)

    return {
        "ok": True,
        "name": normalized_name,
        "present": update.present,
    }


@app.get("/presence/status", dependencies=[Depends(require_api_key)])
def presence_status() -> Dict[str, Union[bool, Dict[str, bool]]]:
    with presence_lock:
        people = read_presence()

    return {
        "someone_home": any(people.values()),
        "people": people,
    }
