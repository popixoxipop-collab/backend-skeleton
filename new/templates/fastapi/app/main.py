from fastapi import FastAPI

app = FastAPI(title="{{SLUG}}")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
