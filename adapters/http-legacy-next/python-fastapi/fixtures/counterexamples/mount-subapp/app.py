from fastapi import FastAPI

app = FastAPI()
sub = FastAPI()


@sub.get("/ping")
def sub_ping():
    return "pong"


app.mount("/sub", sub)
