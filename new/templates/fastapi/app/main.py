from fastapi import FastAPI

app = FastAPI(title="{{NAME}}")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
