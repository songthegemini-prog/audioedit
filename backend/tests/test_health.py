from fastapi.testclient import TestClient

from app.main import APP_VERSION, app

client = TestClient(app)


def test_health() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "version": APP_VERSION}
